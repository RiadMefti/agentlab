import type {
  FactoryIntakeRequest,
  FactoryPreparationAuthority,
  FactoryPreparationEvent,
  FactoryPreparationState,
  Sha256Digest
} from "@agentlab/contracts";

import type { CanonicalFactoryDocument } from "./factory-documents.js";

export interface FactoryPreparationSnapshot {
  readonly request: FactoryIntakeRequest;
  readonly requestDigest: Sha256Digest;
  readonly authority: FactoryPreparationAuthority;
  readonly authorityDigest: Sha256Digest;
  readonly state: FactoryPreparationState;
  readonly sequence: number;
  readonly lastEvent: FactoryPreparationEvent;
  readonly lastEventDigest: Sha256Digest;
}

/** Append-only pre-contract journal. Request, authority, and events are immutable after insertion. */
export interface FactoryPreparationRepository {
  register(
    request: CanonicalFactoryDocument<FactoryIntakeRequest>,
    authority: CanonicalFactoryDocument<FactoryPreparationAuthority>,
    initialEvent: CanonicalFactoryDocument<FactoryPreparationEvent>
  ): Promise<FactoryPreparationSnapshot>;
  findById(taskId: string): Promise<FactoryPreparationSnapshot | null>;
  listForConversation(
    conversationId: string,
    limit: number
  ): Promise<readonly FactoryPreparationSnapshot[]>;
  listEvents(taskId: string): Promise<readonly FactoryPreparationEvent[]>;
  append(
    event: CanonicalFactoryDocument<FactoryPreparationEvent>
  ): Promise<FactoryPreparationSnapshot | null>;
  close(): void;
}
