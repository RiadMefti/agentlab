import type { NewConversationReservation, StoredConversation } from "./conversation-record.js";

export type ConversationLifecycleTransition =
  | { readonly id: string; readonly expected: "creating"; readonly next: "active" }
  | {
      readonly id: string;
      readonly expected: "active" | "legacy-unlinked";
      readonly next: "deleting";
    };

export type RemovableConversationLifecycle = "creating" | "deleting";

/** Persistence port for durable conversation metadata. */
export interface ConversationRepository {
  list(): Promise<readonly StoredConversation[]>;
  findById(id: string): Promise<StoredConversation | null>;
  findByWorkspacePath(workspacePath: string): Promise<StoredConversation | null>;
  create(conversation: NewConversationReservation): Promise<void>;
  transitionLifecycle(
    transition: ConversationLifecycleTransition
  ): Promise<StoredConversation | null>;
  deleteIfLifecycle(id: string, expected: RemovableConversationLifecycle): Promise<boolean>;
  close(): void;
}
