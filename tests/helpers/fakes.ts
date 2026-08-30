import type { AgentSession, ProviderCapability, ProviderId } from "@agentlab/contracts";

import type {
  ConversationLifecycleTransition,
  ConversationRepository,
  RemovableConversationLifecycle
} from "../../packages/runtime/src/domain/conversation-repository.js";
import type {
  NewConversationReservation,
  StoredConversation
} from "../../packages/runtime/src/domain/conversation-record.js";
import type {
  AgentLauncher,
  ProviderCatalog,
  ProviderCatalogFactory,
  ResolvedProvider
} from "../../packages/runtime/src/domain/agent-launcher.js";
import type {
  CreateCaptainSessionInput,
  CreateWorkerSessionInput,
  OwnedSessionKillResult,
  OwnedSessionResolution,
  SessionInventoryEntry,
  SessionOwnership,
  SessionOwnershipInspection,
  SessionRuntime
} from "../../packages/runtime/src/domain/session-runtime.js";
import { codexAgentLauncher } from "../../packages/runtime/src/infrastructure/providers/agent-launchers.js";
import type {
  ResolvedWorkspacePath,
  WorkspacePathResolver
} from "../../packages/runtime/src/domain/workspace-path-resolver.js";
import {
  parseSessionName,
  sessionLabel
} from "../../packages/runtime/src/domain/agent-session-name.js";

export const TEST_CONVERSATION_ID = "11111111-1111-4111-8111-111111111111";

export class MemoryConversationRepository implements ConversationRepository {
  public readonly conversations: StoredConversation[] = [];
  public createError: Error | null = null;
  public deleteError: Error | null = null;
  public transitionError: Error | null = null;
  public transitionErrorAfterCommit: Error | null = null;
  public closed = false;

  public list(): Promise<readonly StoredConversation[]> {
    return Promise.resolve([...this.conversations]);
  }

  public findById(id: string): Promise<StoredConversation | null> {
    return Promise.resolve(
      this.conversations.find((conversation) => conversation.id === id) ?? null
    );
  }

  public findByWorkspacePath(workspacePath: string): Promise<StoredConversation | null> {
    return Promise.resolve(
      this.conversations.find((conversation) => conversation.workspacePath === workspacePath) ??
        null
    );
  }

  public create(conversation: NewConversationReservation): Promise<void> {
    if (this.createError !== null) return Promise.reject(this.createError);
    this.conversations.push(conversation);
    return Promise.resolve();
  }

  public transitionLifecycle(
    transition: ConversationLifecycleTransition
  ): Promise<StoredConversation | null> {
    if (this.transitionError !== null) return Promise.reject(this.transitionError);
    const index = this.conversations.findIndex(
      (conversation) =>
        conversation.id === transition.id && conversation.lifecycleState === transition.expected
    );
    const current = this.conversations[index];
    if (index < 0 || current === undefined) return Promise.resolve(null);
    const transitioned: StoredConversation = { ...current, lifecycleState: transition.next };
    this.conversations[index] = transitioned;
    if (this.transitionErrorAfterCommit !== null) {
      return Promise.reject(this.transitionErrorAfterCommit);
    }
    return Promise.resolve(transitioned);
  }

  public deleteIfLifecycle(id: string, expected: RemovableConversationLifecycle): Promise<boolean> {
    if (this.deleteError !== null) return Promise.reject(this.deleteError);
    const index = this.conversations.findIndex(
      (conversation) => conversation.id === id && conversation.lifecycleState === expected
    );
    if (index < 0) return Promise.resolve(false);
    this.conversations.splice(index, 1);
    return Promise.resolve(true);
  }

  public close(): void {
    this.closed = true;
  }
}

export class MemorySessionRuntime implements SessionRuntime {
  public readonly created: CreateCaptainSessionInput[] = [];
  public readonly createdWorkers: CreateWorkerSessionInput[] = [];
  public readonly killed: string[] = [];
  public liveSessions: AgentSession[] = [];
  public readonly ownershipByName = new Map<string, string | null>();
  public createError: Error | null = null;
  public readonly killErrors = new Map<string, Error>();

  public createCaptain(input: CreateCaptainSessionInput): Promise<void> {
    if (this.createError !== null) return Promise.reject(this.createError);
    this.created.push(input);
    this.addLiveSession(input.name, "Captain", input.ownership);
    return Promise.resolve();
  }

  public createWorker(input: CreateWorkerSessionInput): Promise<void> {
    if (this.createError !== null) return Promise.reject(this.createError);
    this.createdWorkers.push(input);
    const parsed = parseSessionName(input.name);
    this.addLiveSession(
      input.name,
      parsed === null ? "Worker" : sessionLabel(parsed),
      input.ownership
    );
    return Promise.resolve();
  }

  public inspectOwnership(name: string): Promise<SessionOwnershipInspection> {
    if (!this.liveSessions.some((session) => session.name === name)) {
      return Promise.resolve({ status: "absent" });
    }
    return Promise.resolve({
      status: "present",
      nonce: this.ownershipByName.get(name) ?? null
    });
  }

  public async resolveOwnedTarget(
    name: string,
    ownership: SessionOwnership
  ): Promise<OwnedSessionResolution> {
    const inspection = await this.inspectOwnership(name);
    if (inspection.status === "absent") return { status: "absent" };
    if (ownership.mode === "nonce" && inspection.nonce !== ownership.nonce) {
      return { status: "ownership-mismatch" };
    }
    return {
      status: "owned",
      target: {
        sessionName: name,
        runtimeId: "$1",
        serverPid: "100",
        serverStartedAt: "200",
        ownership
      }
    };
  }

  public async killOwned(
    name: string,
    ownership: SessionOwnership
  ): Promise<OwnedSessionKillResult> {
    const error = this.killErrors.get(name);
    if (error !== undefined) throw error;
    const inspection = await this.inspectOwnership(name);
    if (inspection.status === "absent") return "absent";
    if (ownership.mode === "nonce" && inspection.nonce !== ownership.nonce) {
      return "ownership-mismatch";
    }
    this.killed.push(name);
    this.liveSessions = this.liveSessions.filter((session) => session.name !== name);
    this.ownershipByName.delete(name);
    return "killed";
  }

  public exists(name: string): Promise<boolean> {
    return Promise.resolve(this.liveSessions.some((session) => session.name === name));
  }

  public list(conversationId: string): Promise<readonly AgentSession[]> {
    return Promise.resolve(
      this.liveSessions.filter((session) => session.conversationId === conversationId)
    );
  }

  public async listInventory(conversationId: string): Promise<readonly SessionInventoryEntry[]> {
    return (await this.list(conversationId)).map((session) => ({
      session,
      ownershipNonce: this.ownershipByName.get(session.name) ?? null
    }));
  }

  public addLiveSession(name: string, label: string, ownership: SessionOwnership): void {
    const parsed = parseSessionName(name);
    if (parsed === null) throw new Error("Invalid managed session in test fake.");
    this.liveSessions.push({
      name,
      conversationId: parsed.conversationId,
      role: parsed.role,
      provider: parsed.provider,
      label,
      status: "running",
      attached: false,
      startedAt: "2026-08-21T12:01:00.000Z"
    });
    this.ownershipByName.set(name, ownership.mode === "nonce" ? ownership.nonce : null);
  }
}

export class StaticProviderCatalog implements ProviderCatalog, ProviderCatalogFactory {
  public readonly workspaces: string[] = [];

  public constructor(
    private readonly launchers: ReadonlyMap<ProviderId, AgentLauncher> = new Map([
      ["codex", codexAgentLauncher]
    ]),
    private readonly executable = "/opt/bin/codex",
    private readonly capabilities: Partial<Record<ProviderId, ProviderCapability>> = {}
  ) {}

  public forWorkspace(workspace: string): ProviderCatalog {
    this.workspaces.push(workspace);
    return this;
  }

  public list(): Promise<readonly ProviderCapability[]> {
    return Promise.resolve(
      [...this.launchers.values()].map(
        (launcher) => this.capabilities[launcher.id] ?? testProviderCapability(launcher)
      )
    );
  }

  public resolve(id: ProviderId): Promise<ResolvedProvider | null> {
    const launcher = this.launchers.get(id);
    const capability =
      launcher === undefined ? null : (this.capabilities[id] ?? testProviderCapability(launcher));
    return Promise.resolve(
      launcher === undefined || capability === null
        ? null
        : { launcher, capability, executable: this.executable, version: "test 1.0.0" }
    );
  }
}

export class StaticWorkspacePathResolver implements WorkspacePathResolver {
  public readonly inputs: string[] = [];

  public resolve(input: string): Promise<ResolvedWorkspacePath> {
    this.inputs.push(input);
    return Promise.resolve({
      path: input,
      suggestedName: input.split("/").filter(Boolean).at(-1) ?? input
    });
  }
}

export function testProviderCapability(launcher: AgentLauncher): ProviderCapability {
  return {
    id: launcher.id,
    label: launcher.label,
    available: true,
    version: "test 1.0.0",
    reason: null,
    source: "live",
    discoveredAt: "2026-08-21T12:00:00.000Z",
    defaultModel: "gpt-test",
    models: [
      {
        id: "gpt-test",
        label: "GPT Test",
        description: "Test model",
        defaultReasoning: "high",
        reasoningOptions: ["low", "high", "xhigh"].map((id) => ({ id, label: id }))
      }
    ],
    customModelPolicy: launcher.customModelPolicy
  };
}
