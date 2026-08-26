import type { Conversation } from "@orchestrator/contracts";

/** Persistence port for durable conversation metadata. */
export interface ConversationRepository {
  list(): Promise<readonly Conversation[]>;
  findById(id: string): Promise<Conversation | null>;
  findByWorkspacePath(workspacePath: string): Promise<Conversation | null>;
  create(conversation: Conversation): Promise<void>;
  delete(id: string): Promise<void>;
  close(): void;
}
