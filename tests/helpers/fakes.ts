import type {
  AgentSession,
  Conversation,
  ProviderCapability,
  ProviderId
} from "@orchestrator/contracts";

import type { ConversationRepository } from "../../apps/server/src/domain/conversation-repository.js";
import type {
  CaptainLauncher,
  ProviderCatalog,
  ResolvedCaptainProvider
} from "../../apps/server/src/domain/captain-launcher.js";
import type {
  CreateCaptainSessionInput,
  SessionRuntime
} from "../../apps/server/src/domain/session-runtime.js";
import { codexCaptainLauncher } from "../../apps/server/src/infrastructure/providers/captain-launchers.js";

export const TEST_CONVERSATION_ID = "11111111-1111-4111-8111-111111111111";

export class MemoryConversationRepository implements ConversationRepository {
  public readonly conversations: Conversation[] = [];
  public createError: Error | null = null;
  public closed = false;

  public list(): Promise<readonly Conversation[]> {
    return Promise.resolve([...this.conversations]);
  }

  public findById(id: string): Promise<Conversation | null> {
    return Promise.resolve(
      this.conversations.find((conversation) => conversation.id === id) ?? null
    );
  }

  public create(conversation: Conversation): Promise<void> {
    if (this.createError !== null) return Promise.reject(this.createError);
    this.conversations.push(conversation);
    return Promise.resolve();
  }

  public close(): void {
    this.closed = true;
  }
}

export class MemorySessionRuntime implements SessionRuntime {
  public readonly created: CreateCaptainSessionInput[] = [];
  public readonly killed: string[] = [];
  public liveSessions: AgentSession[] = [];
  public createError: Error | null = null;

  public createCaptain(input: CreateCaptainSessionInput): Promise<void> {
    if (this.createError !== null) return Promise.reject(this.createError);
    this.created.push(input);
    return Promise.resolve();
  }

  public kill(name: string): Promise<void> {
    this.killed.push(name);
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

export class StaticProviderCatalog implements ProviderCatalog {
  public constructor(
    private readonly launchers: ReadonlyMap<ProviderId, CaptainLauncher> = new Map([
      ["codex", codexCaptainLauncher]
    ]),
    private readonly executable = "/opt/bin/codex"
  ) {}

  public list(): Promise<readonly ProviderCapability[]> {
    return Promise.resolve(
      [...this.launchers.values()].map((launcher) => ({
        ...launcher.capability,
        available: true,
        version: "test 1.0.0",
        reason: null
      }))
    );
  }

  public resolveCaptain(id: ProviderId): Promise<ResolvedCaptainProvider | null> {
    const launcher = this.launchers.get(id);
    return Promise.resolve(
      launcher === undefined
        ? null
        : { launcher, executable: this.executable, version: "test 1.0.0" }
    );
  }
}
