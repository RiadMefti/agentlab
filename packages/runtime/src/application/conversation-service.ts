import type {
  AgentSession,
  Conversation,
  CreateConversationInput,
  CreateWorkerInput,
  ProviderCapability,
  ProviderId
} from "@agentlab/contracts";

import type { ProviderCatalogFactory } from "../domain/agent-launcher.js";
import {
  assertCaptainSessionOwnership,
  buildCaptainSessionName,
  buildWorkerSessionName,
  parseSessionName,
  workerSlugFromLabel
} from "../domain/agent-session-name.js";
import type { CaptainPolicyRenderer } from "../domain/captain-policy.js";
import type { CommandSpec } from "../domain/command.js";
import { preservePrimaryFailure } from "../domain/compensation.js";
import type { ConversationRepository } from "../domain/conversation-repository.js";
import {
  newConversationReservationSchema,
  publicConversation,
  type StoredConversation
} from "../domain/conversation-record.js";
import { ConflictError, NotFoundError, ProviderUnavailableError } from "../domain/errors.js";
import type {
  SessionAttachmentTarget,
  SessionInventoryEntry,
  SessionOwnership,
  SessionRuntime
} from "../domain/session-runtime.js";
import { maximumManagedSessionInventory, SessionCreationError } from "../domain/session-runtime.js";
import type { WorkspacePathResolver } from "../domain/workspace-path-resolver.js";
import { ConversationLifecycle } from "./conversation-lifecycle.js";
import type {
  ConversationOperations,
  WorkspaceInspection,
  WorkspacePreparation
} from "./conversation-operations.js";

const maximumCleanupPasses = 4;
const maximumConcurrentSessionCleanup = 8;

export interface ConversationServiceDependencies {
  readonly repository: ConversationRepository;
  readonly providers: ProviderCatalogFactory;
  readonly sessions: SessionRuntime;
  readonly workspacePaths: WorkspacePathResolver;
  readonly captainPolicy: CaptainPolicyRenderer;
  readonly now: () => Date;
  readonly createId: () => string;
  readonly createOwnershipNonce: () => string;
}

/** Enforces the durable conversation → one captain → workers aggregate. */
export class ConversationService implements ConversationOperations {
  readonly #repository: ConversationRepository;
  readonly #providers: ProviderCatalogFactory;
  readonly #sessions: SessionRuntime;
  readonly #workspacePaths: WorkspacePathResolver;
  readonly #captainPolicy: CaptainPolicyRenderer;
  readonly #now: () => Date;
  readonly #createId: () => string;
  readonly #createOwnershipNonce: () => string;
  readonly #lifecycle = new ConversationLifecycle();

  public constructor(dependencies: ConversationServiceDependencies) {
    this.#repository = dependencies.repository;
    this.#providers = dependencies.providers;
    this.#sessions = dependencies.sessions;
    this.#workspacePaths = dependencies.workspacePaths;
    this.#captainPolicy = dependencies.captainPolicy;
    this.#now = dependencies.now;
    this.#createId = dependencies.createId;
    this.#createOwnershipNonce = dependencies.createOwnershipNonce;
  }

  public async reconcilePending(): Promise<void> {
    const pending = (await this.#repository.list()).filter(
      ({ lifecycleState }) => lifecycleState === "creating" || lifecycleState === "deleting"
    );
    const failures: unknown[] = [];
    for (const record of pending) {
      try {
        await this.#lifecycle.serialize(record.id, async () => {
          const current = await this.#repository.findById(record.id);
          if (current?.lifecycleState === "creating") await this.cleanupCreating(current);
          else if (current?.lifecycleState === "deleting") await this.cleanupDeleting(current);
        });
      } catch (error: unknown) {
        failures.push(
          new Error(
            `Project ${record.id} remains ${record.lifecycleState}; resolve its managed-session ownership conflict and restart AgentLab.`,
            { cause: error }
          )
        );
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "AgentLab startup reconciliation failed closed.");
    }
  }

  public async listConversations(): Promise<readonly Conversation[]> {
    return (await this.#repository.list())
      .filter(
        ({ lifecycleState }) => lifecycleState === "active" || lifecycleState === "legacy-unlinked"
      )
      .map(publicConversation);
  }

  public async inspectWorkspace(workspacePath: string): Promise<WorkspaceInspection> {
    const workspace = await this.prepareWorkspace(workspacePath);
    return {
      ...workspace,
      providers: await this.discoverWorkspaceProviders(workspace.workspacePath)
    };
  }

  public async prepareWorkspace(workspacePath: string): Promise<WorkspacePreparation> {
    const workspace = await this.#workspacePaths.resolve(workspacePath);
    const existing = await this.#repository.findByWorkspacePath(workspace.path);
    if (existing !== null) {
      throw new ConflictError(`That folder is already saved as ${existing.title}.`);
    }
    return {
      workspacePath: workspace.path,
      suggestedName: workspace.suggestedName
    };
  }

  public async discoverWorkspaceProviders(
    workspacePath: string
  ): Promise<readonly ProviderCapability[]> {
    const canonical = await this.#workspacePaths.resolve(workspacePath);
    return this.#providers.forWorkspace(canonical.path).list();
  }

  public async listProviders(conversationId: string): Promise<readonly ProviderCapability[]> {
    const conversation = await this.requireActiveConversation(conversationId);
    const workspace = await this.requireWorkspace(conversation);
    return this.#providers.forWorkspace(workspace).list();
  }

  public async createConversation(input: CreateConversationInput): Promise<Conversation> {
    const workspace = await this.#workspacePaths.resolve(input.workspacePath);
    const existing = await this.#repository.findByWorkspacePath(workspace.path);
    if (existing !== null) {
      throw new ConflictError(`That folder is already saved as ${existing.title}.`);
    }

    const providers = this.#providers.forWorkspace(workspace.path);
    const resolved = await providers.resolve(input.provider);
    if (resolved === null) {
      throw new ProviderUnavailableError(
        `${providerLabel(input.provider)} is not available on this machine.`
      );
    }
    validateSelection(resolved.capability, input.model, input.reasoning);

    const id = this.#createId();
    const ownershipNonce = this.#createOwnershipNonce();
    const timestamp = this.#now().toISOString();
    const captainSessionName = buildCaptainSessionName(id, input.provider);
    const record = newConversationReservationSchema.parse({
      id,
      title: input.title,
      workspacePath: workspace.path,
      provider: input.provider,
      model: input.model,
      reasoning: input.reasoning,
      captainSessionName,
      createdAt: timestamp,
      updatedAt: timestamp,
      lifecycleState: "creating",
      ownershipMode: "nonce",
      ownershipNonce
    });

    const providerExecutables: Partial<Record<ProviderId, string>> = {};
    for (const capability of await providers.list()) {
      if (!capability.available) continue;
      const provider = await providers.resolve(capability.id);
      if (provider !== null) providerExecutables[capability.id] = provider.executable;
    }
    const policy = this.#captainPolicy.render({
      conversationId: id,
      workspace: workspace.path,
      ownershipNonce,
      providerExecutables
    });
    const command = mergeCommandEnvironment(
      resolved.launcher.buildCaptainCommand({
        executable: resolved.executable,
        conversationId: id,
        workspace: workspace.path,
        model: record.model,
        reasoning: record.reasoning,
        supervisorInstructions: policy.instructions,
        userPrompt: input.prompt
      }),
      policy.environment
    );

    await this.#repository.create(record);
    let captainReady = false;
    try {
      await this.#sessions.createCaptain({
        name: captainSessionName,
        cwd: workspace.path,
        command,
        ownership: ownershipFor(record)
      });
      captainReady = true;
      const active = await this.#repository.transitionLifecycle({
        id,
        expected: "creating",
        next: "active"
      });
      if (active === null) {
        throw new ConflictError("Project activation lost its durable creating reservation.");
      }
      return publicConversation(active);
    } catch (error: unknown) {
      const creationCleanupConfirmed =
        error instanceof SessionCreationError && error.cleanup === "confirmed-absent";
      try {
        const current = await this.#repository.findById(id);
        if (captainReady && current?.lifecycleState === "active") {
          return publicConversation(current);
        }
        if ((captainReady || creationCleanupConfirmed) && current?.lifecycleState === "creating") {
          await this.cleanupCreating(current);
        }
      } catch (compensationError: unknown) {
        throw preservePrimaryFailure(error, compensationError);
      }
      throw error;
    }
  }

  public async deleteConversation(conversationId: string): Promise<void> {
    await this.#lifecycle.serialize(conversationId, async () => {
      let record = await this.requireConversation(conversationId);
      if (record.lifecycleState === "creating") {
        throw new ConflictError(
          "This project is still being recovered and cannot be removed through normal deletion."
        );
      }
      if (record.lifecycleState === "active" || record.lifecycleState === "legacy-unlinked") {
        const deleting = await this.#repository.transitionLifecycle({
          id: record.id,
          expected: record.lifecycleState,
          next: "deleting"
        });
        if (deleting === null) {
          const current = await this.#repository.findById(record.id);
          if (current?.lifecycleState !== "deleting") {
            throw new ConflictError("Project deletion lost its durable lifecycle transition.");
          }
          record = current;
        } else {
          record = deleting;
        }
      }
      if (record.lifecycleState !== "deleting") {
        throw new ConflictError("This project is not in a deletable lifecycle state.");
      }
      await this.cleanupDeleting(record);
    });
  }

  public async listSessions(conversationId: string): Promise<readonly AgentSession[]> {
    const conversation = await this.requireActiveConversation(conversationId);
    const sessions = [...(await this.authorizedSessions(conversation))];

    if (!sessions.some(({ name }) => name === conversation.captainSessionName)) {
      sessions.unshift({
        name: conversation.captainSessionName,
        conversationId,
        role: "captain",
        provider: conversation.provider,
        label: "Captain",
        status: "stopped",
        attached: false,
        startedAt: null
      });
    }

    return sessions.sort((left, right) => {
      if (left.role !== right.role) return left.role === "captain" ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
  }

  public async createWorker(conversationId: string, input: CreateWorkerInput): Promise<string> {
    return this.#lifecycle.serialize(conversationId, async () => {
      const conversation = await this.requireActiveConversation(conversationId);
      const workspace = await this.requireWorkspace(conversation);
      const resolved = await this.#providers.forWorkspace(workspace).resolve(input.provider);
      if (resolved === null) {
        throw new ProviderUnavailableError(
          `${providerLabel(input.provider)} is not available on this machine.`
        );
      }

      const workerSlug = workerSlugFromLabel(input.label);
      const sessionName = buildWorkerSessionName(conversationId, input.provider, workerSlug);
      const command = resolved.launcher.buildWorkerCommand({
        executable: resolved.executable,
        conversationId,
        workspace,
        workerSlug,
        userPrompt: input.prompt
      });
      await this.#sessions.createWorker({
        name: sessionName,
        cwd: workspace,
        command,
        ownership: ownershipFor(conversation)
      });
      return sessionName;
    });
  }

  public async deleteWorker(conversationId: string, sessionName: string): Promise<void> {
    await this.#lifecycle.serialize(conversationId, async () => {
      const conversation = await this.requireActiveConversation(conversationId);
      const identity = parseSessionName(sessionName);
      if (identity?.conversationId !== conversationId) {
        throw new NotFoundError("Worker session not found.");
      }
      if (identity.role === "captain") {
        throw new ConflictError("The Captain cannot be deleted.");
      }
      const result = await this.#sessions.killOwned(sessionName, ownershipFor(conversation));
      if (result === "ownership-mismatch") {
        throw new ConflictError("Worker session ownership does not match this project.");
      }
      if (result === "absent") throw new NotFoundError("Worker session not found.");
    });
  }

  public async requireAttachableSession(
    conversationId: string,
    sessionName: string
  ): Promise<string> {
    const conversation = await this.requireActiveConversation(conversationId);
    const workspace = await this.requireWorkspace(conversation);
    await this.assertSessionAuthorized(conversation, sessionName);
    return workspace;
  }

  /** Resolves an immutable adapter handle after current ownership proof. */
  public async assertSessionAttachable(
    conversationId: string,
    sessionName: string
  ): Promise<SessionAttachmentTarget> {
    const conversation = await this.requireActiveConversation(conversationId);
    const identity = parseSessionName(sessionName);
    const identityMatches =
      identity?.conversationId === conversation.id &&
      (identity.role === "worker" || sessionName === conversation.captainSessionName);
    if (!identityMatches) {
      throw new NotFoundError("That agent session is no longer available.");
    }
    const resolution = await this.#sessions.resolveOwnedTarget(
      sessionName,
      ownershipFor(conversation)
    );
    if (resolution.status !== "owned") {
      throw new NotFoundError("That agent session is no longer available.");
    }
    return resolution.target;
  }

  private async cleanupCreating(record: StoredConversation): Promise<void> {
    if (record.lifecycleState !== "creating" || record.ownershipMode !== "nonce") {
      throw new Error("Only nonce-owned creating rows may use creation recovery.");
    }
    await this.stopOwnedSetUntilAbsent(record, true);
    const deleted = await this.#repository.deleteIfLifecycle(record.id, "creating");
    if (!deleted) throw new ConflictError("Creating reservation changed during recovery.");
  }

  private async cleanupDeleting(record: StoredConversation): Promise<void> {
    if (record.lifecycleState !== "deleting") {
      throw new Error("Only deleting rows may use deletion recovery.");
    }
    await this.stopOwnedSetUntilAbsent(record, false);
    const deleted = await this.#repository.deleteIfLifecycle(record.id, "deleting");
    if (!deleted) throw new ConflictError("Deleting reservation changed during recovery.");
  }

  private async stopOwnedSetUntilAbsent(
    record: StoredConversation,
    continueAfterCaptainFailure: boolean
  ): Promise<void> {
    for (let pass = 0; pass < maximumCleanupPasses; pass += 1) {
      const inventory = await this.sessionInventory(record.id);
      const failures: unknown[] = [];
      let ownedCaptain: SessionInventoryEntry | null = null;
      const ownedWorkers: SessionInventoryEntry[] = [];
      for (const entry of inventory) {
        const identity = parseSessionName(entry.session.name);
        const persistedCaptain = entry.session.name === record.captainSessionName;
        const managedWorker = identity?.role === "worker";
        if (!persistedCaptain && !managedWorker) continue;
        if (record.ownershipMode === "nonce" && entry.ownershipNonce !== record.ownershipNonce) {
          const conflict = new ConflictError(
            persistedCaptain
              ? "Captain session ownership does not match the durable project."
              : `Worker ${entry.session.name} has conflicting ownership proof.`
          );
          if (persistedCaptain && !continueAfterCaptainFailure) throw conflict;
          failures.push(conflict);
        } else if (persistedCaptain) {
          ownedCaptain = entry;
        } else {
          ownedWorkers.push(entry);
        }
      }

      if (ownedCaptain !== null) {
        try {
          const result = await this.#sessions.killOwned(
            ownedCaptain.session.name,
            ownershipFor(record)
          );
          if (result === "ownership-mismatch") {
            throw new ConflictError(
              "Captain session ownership does not match the durable project."
            );
          }
        } catch (error: unknown) {
          if (!continueAfterCaptainFailure) throw error;
          failures.push(error);
        }
      }

      const results = await settleWithConcurrency(
        ownedWorkers,
        maximumConcurrentSessionCleanup,
        async ({ session }) => {
          const result = await this.#sessions.killOwned(session.name, ownershipFor(record));
          if (result === "ownership-mismatch") {
            throw new ConflictError(`Session ${session.name} has conflicting ownership proof.`);
          }
        }
      );
      failures.push(
        ...results.flatMap((result) =>
          result.status === "rejected" ? [result.reason as unknown] : []
        )
      );

      throwCleanupFailures(failures);

      const remaining = (await this.sessionInventory(record.id)).filter(({ session }) => {
        const identity = parseSessionName(session.name);
        return session.name === record.captainSessionName || identity?.role === "worker";
      });
      if (remaining.length === 0) return;
    }
    throw new ConflictError("Managed-session cleanup did not reach an empty final inventory.");
  }

  private async sessionInventory(
    conversationId: string
  ): Promise<readonly SessionInventoryEntry[]> {
    const inventory = await this.#sessions.listInventory(conversationId);
    if (inventory.length > maximumManagedSessionInventory) {
      throw new ConflictError(
        `Managed-session inventory exceeds the safe limit of ${String(maximumManagedSessionInventory)}.`
      );
    }
    return inventory;
  }

  private async authorizedSessions(
    conversation: StoredConversation
  ): Promise<readonly AgentSession[]> {
    const inventory = await this.sessionInventory(conversation.id);
    const authorized: AgentSession[] = [];
    for (const { session, ownershipNonce } of inventory) {
      const identity = parseSessionName(session.name);
      const identityMatches =
        identity?.conversationId === conversation.id &&
        (identity.role === "worker" || session.name === conversation.captainSessionName);
      if (!identityMatches) continue;
      if (conversation.ownershipMode === "nonce") {
        if (ownershipNonce !== conversation.ownershipNonce) continue;
      }
      authorized.push(session);
    }
    return authorized;
  }

  private async assertSessionAuthorized(
    conversation: StoredConversation,
    sessionName: string
  ): Promise<void> {
    const identity = parseSessionName(sessionName);
    const identityMatches =
      identity?.conversationId === conversation.id &&
      (identity.role === "worker" || sessionName === conversation.captainSessionName);
    if (!identityMatches) {
      throw new NotFoundError("That agent session is no longer available.");
    }
    const inventory = await this.sessionInventory(conversation.id);
    const entry = inventory.find(({ session }) => session.name === sessionName);
    if (entry === undefined) {
      throw new NotFoundError("That agent session is no longer available.");
    }
    if (conversation.ownershipMode === "nonce") {
      if (entry.ownershipNonce !== conversation.ownershipNonce) {
        throw new NotFoundError("That agent session is no longer available.");
      }
    }
  }

  private async requireActiveConversation(id: string): Promise<StoredConversation> {
    const conversation = await this.requireConversation(id);
    if (conversation.lifecycleState !== "active") {
      throw new ConflictError("This project is not active.");
    }
    return conversation;
  }

  private async requireConversation(id: string): Promise<StoredConversation> {
    const conversation = await this.#repository.findById(id);
    if (conversation === null) throw new NotFoundError("Conversation not found.");
    assertCaptainSessionOwnership(
      conversation.captainSessionName,
      conversation.id,
      conversation.provider
    );
    return conversation;
  }

  private async requireWorkspace(conversation: StoredConversation): Promise<string> {
    if (conversation.workspacePath === null) {
      throw new ConflictError("This project does not have a folder. Remove and add it again.");
    }
    const resolved = (await this.#workspacePaths.resolve(conversation.workspacePath)).path;
    if (resolved !== conversation.workspacePath) {
      throw new ConflictError(
        "This project's saved folder now resolves somewhere else. Remove and add it again."
      );
    }
    return resolved;
  }
}

function ownershipFor(record: StoredConversation): SessionOwnership {
  if (record.ownershipMode === "legacy-name") return { mode: "legacy-name" };
  if (record.ownershipNonce === null) {
    throw new Error("Nonce-owned conversation is missing its ownership nonce.");
  }
  return { mode: "nonce", nonce: record.ownershipNonce };
}

function mergeCommandEnvironment(
  command: CommandSpec,
  environment: Readonly<Record<string, string>>
): CommandSpec {
  return {
    ...command,
    environment: { ...command.environment, ...environment }
  };
}

function validateSelection(
  capability: ProviderCapability,
  selectedModel: string | null,
  selectedReasoning: string | null
): void {
  const effectiveModel = selectedModel ?? capability.defaultModel;
  const model =
    effectiveModel === null
      ? null
      : (capability.models.find(({ id }) => id === effectiveModel) ?? null);

  if (selectedModel !== null && model === null && capability.customModelPolicy === "catalog-only") {
    throw new ConflictError(
      `${selectedModel} is not in the discovered ${capability.label} model catalog.`
    );
  }
  if (selectedReasoning === null) return;
  if (model === null) {
    throw new ConflictError(
      `Choose a discovered ${capability.label} model before overriding its reasoning.`
    );
  }
  if (!model.reasoningOptions.some(({ id }) => id === selectedReasoning)) {
    throw new ConflictError(`${selectedReasoning} reasoning is not supported by ${model.label}.`);
  }
}

function providerLabel(provider: ProviderId): string {
  const labels: Record<ProviderId, string> = {
    codex: "Codex",
    claude: "Claude",
    opencode: "OpenCode"
  };
  return labels[provider];
}

function throwCleanupFailures(failures: readonly unknown[]): void {
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Multiple managed sessions could not be stopped safely.");
  }
}

async function settleWithConcurrency<Input>(
  values: readonly Input[],
  maximumConcurrency: number,
  operation: (value: Input) => Promise<void>
): Promise<readonly PromiseSettledResult<void>[]> {
  const results = values.map((): PromiseSettledResult<void> | undefined => undefined);
  let next = 0;
  const workers = Array.from({ length: Math.min(maximumConcurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next;
      next += 1;
      const value = values[index];
      if (value === undefined) continue;
      try {
        await operation(value);
        results[index] = { status: "fulfilled", value: undefined };
      } catch (reason: unknown) {
        results[index] = { status: "rejected", reason };
      }
    }
  });
  await Promise.all(workers);
  return results.map((result) => {
    if (result === undefined) {
      throw new Error("A managed-session cleanup operation was not scheduled.");
    }
    return result;
  });
}
