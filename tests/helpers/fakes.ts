import type {
  AgentSession,
  Conversation,
  ProviderCapability,
  ProviderId
} from "@agentlab/contracts";

import type { ConversationRepository } from "../../packages/runtime/src/domain/conversation-repository.js";
import type {
  AgentLauncher,
  ProviderCatalog,
  ProviderCatalogFactory,
  ResolvedProvider
} from "../../packages/runtime/src/domain/agent-launcher.js";
import type {
  CreateCaptainSessionInput,
  CreateWorkerSessionInput,
  SessionRuntime
} from "../../packages/runtime/src/domain/session-runtime.js";
import { codexAgentLauncher } from "../../packages/runtime/src/infrastructure/providers/agent-launchers.js";
import type {
  ResolvedWorkspacePath,
  WorkspacePathResolver
} from "../../packages/runtime/src/domain/workspace-path-resolver.js";

export const TEST_CONVERSATION_ID = "11111111-1111-4111-8111-111111111111";

export class MemoryConversationRepository implements ConversationRepository {
  public readonly conversations: Conversation[] = [];
  public createError: Error | null = null;
  public deleteError: Error | null = null;
  public closed = false;

  public list(): Promise<readonly Conversation[]> {
    return Promise.resolve([...this.conversations]);
  }

  public findById(id: string): Promise<Conversation | null> {
    return Promise.resolve(
      this.conversations.find((conversation) => conversation.id === id) ?? null
    );
  }

  public findByWorkspacePath(workspacePath: string): Promise<Conversation | null> {
    return Promise.resolve(
      this.conversations.find((conversation) => conversation.workspacePath === workspacePath) ??
        null
    );
  }

  public create(conversation: Conversation): Promise<void> {
    if (this.createError !== null) return Promise.reject(this.createError);
    this.conversations.push(conversation);
    return Promise.resolve();
  }

  public delete(id: string): Promise<void> {
    if (this.deleteError !== null) return Promise.reject(this.deleteError);
    const index = this.conversations.findIndex((conversation) => conversation.id === id);
    if (index >= 0) this.conversations.splice(index, 1);
    return Promise.resolve();
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
  public createError: Error | null = null;
  public readonly killErrors = new Map<string, Error>();

  public createCaptain(input: CreateCaptainSessionInput): Promise<void> {
    if (this.createError !== null) return Promise.reject(this.createError);
    this.created.push(input);
    return Promise.resolve();
  }

  public createWorker(input: CreateWorkerSessionInput): Promise<void> {
    if (this.createError !== null) return Promise.reject(this.createError);
    this.createdWorkers.push(input);
    return Promise.resolve();
  }

  public kill(name: string): Promise<void> {
    const error = this.killErrors.get(name);
    if (error !== undefined) return Promise.reject(error);
    this.killed.push(name);
    this.liveSessions = this.liveSessions.filter((session) => session.name !== name);
    return Promise.resolve();
  }

  public exists(name: string): Promise<boolean> {
    return Promise.resolve(this.liveSessions.some((session) => session.name === name));
  }

  public list(conversationId: string): Promise<readonly AgentSession[]> {
    return Promise.resolve(
      this.liveSessions.filter((session) => session.conversationId === conversationId)
    );
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
