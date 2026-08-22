import { randomUUID } from "node:crypto";

import type {
  AgentSession,
  Conversation,
  CreateConversationInput,
  ProviderCapability,
  ProviderId
} from "@orchestrator/contracts";

import type { ConversationRepository } from "../domain/conversation-repository.js";
import { ConflictError, NotFoundError, ProviderUnavailableError } from "../domain/errors.js";
import type { ProviderCatalog } from "../domain/captain-launcher.js";
import { buildCaptainSessionName } from "../domain/agent-session-name.js";
import type { SessionRuntime } from "../domain/session-runtime.js";
import { buildSupervisorInstructions } from "./supervisor-prompt.js";
import { deriveTitle } from "./title.js";

export interface ConversationServiceDependencies {
  readonly repository: ConversationRepository;
  readonly providers: ProviderCatalog;
  readonly sessions: SessionRuntime;
  readonly workspace: string;
  readonly now?: () => Date;
  readonly createId?: () => string;
}

export class ConversationService {
  readonly #repository: ConversationRepository;
  readonly #providers: ProviderCatalog;
  readonly #sessions: SessionRuntime;
  readonly #workspace: string;
  readonly #now: () => Date;
  readonly #createId: () => string;

  public constructor(dependencies: ConversationServiceDependencies) {
    this.#repository = dependencies.repository;
    this.#providers = dependencies.providers;
    this.#sessions = dependencies.sessions;
    this.#workspace = dependencies.workspace;
    this.#now = dependencies.now ?? (() => new Date());
    this.#createId = dependencies.createId ?? randomUUID;
  }

  public listConversations(): Promise<readonly Conversation[]> {
    return this.#repository.list();
  }

  public listProviders(): Promise<readonly ProviderCapability[]> {
    return this.#providers.list();
  }

  public async createConversation(input: CreateConversationInput): Promise<Conversation> {
    const resolved = await this.#providers.resolveCaptain(input.provider);
    if (resolved === null) {
      throw new ProviderUnavailableError(
        `${providerLabel(input.provider)} is not available on this machine.`
      );
    }

    validateSelection(resolved.capability, input.model, input.reasoning);

    const id = this.#createId();
    const timestamp = this.#now().toISOString();
    const captainSessionName = buildCaptainSessionName(id, input.provider);
    const conversation: Conversation = {
      id,
      title: input.title ?? deriveTitle(input.prompt),
      provider: input.provider,
      model: input.model,
      reasoning: input.reasoning,
      captainSessionName,
      createdAt: timestamp,
      updatedAt: timestamp
    };

    const availableProviders = await this.#providers.list();
    const providerExecutables: Partial<Record<ProviderId, string>> = {};
    for (const capability of availableProviders) {
      if (!capability.available) continue;
      const provider = await this.#providers.resolveCaptain(capability.id);
      if (provider !== null) providerExecutables[capability.id] = provider.executable;
    }

    const supervisorInstructions = buildSupervisorInstructions({
      conversationId: id,
      workspace: this.#workspace,
      providerExecutables
    });
    const command = resolved.launcher.buildCaptainCommand({
      executable: resolved.executable,
      conversationId: id,
      workspace: this.#workspace,
      model: conversation.model,
      reasoning: conversation.reasoning,
      supervisorInstructions,
      userPrompt: input.prompt
    });

    await this.#sessions.createCaptain({
      name: captainSessionName,
      cwd: this.#workspace,
      command
    });

    try {
      await this.#repository.create(conversation);
    } catch (error: unknown) {
      await this.#sessions.kill(captainSessionName).catch(() => undefined);
      throw error;
    }

    return conversation;
  }

  public async listSessions(conversationId: string): Promise<readonly AgentSession[]> {
    const conversation = await this.requireConversation(conversationId);
    const sessions = [...(await this.#sessions.list(conversationId))];

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

  public async requireAttachableSession(
    conversationId: string,
    sessionName: string
  ): Promise<void> {
    await this.requireConversation(conversationId);
    const sessions = await this.#sessions.list(conversationId);
    const session = sessions.find(({ name }) => name === sessionName);
    if (session === undefined) {
      throw new NotFoundError("That agent session is no longer available.");
    }
  }

  private async requireConversation(id: string): Promise<Conversation> {
    const conversation = await this.#repository.findById(id);
    if (conversation === null) {
      throw new NotFoundError("Conversation not found.");
    }
    return conversation;
  }
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
