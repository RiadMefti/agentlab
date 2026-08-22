import type { Conversation } from "@orchestrator/contracts";

export interface ConversationRepository {
  list(): Promise<readonly Conversation[]>;
  findById(id: string): Promise<Conversation | null>;
  create(conversation: Conversation): Promise<void>;
  close(): void;
}
