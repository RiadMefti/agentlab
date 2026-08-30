import type {
  EvidenceBundle,
  FactoryControlEvent,
  FactoryControlName,
  FactoryTaskState,
  ImmutableTaskContract,
  Sha256Digest,
  TaskEvent
} from "@agentlab/contracts";

import type { CanonicalFactoryDocument } from "./factory-documents.js";

export interface FactoryTaskSnapshot {
  readonly contract: ImmutableTaskContract;
  readonly contractDigest: Sha256Digest;
  readonly state: FactoryTaskState;
  readonly sequence: number;
  readonly lastEvent: TaskEvent;
  readonly lastEventDigest: Sha256Digest;
}

/** Append-only task ledger. Contract and event documents are immutable after insertion. */
export interface FactoryTaskRepository {
  create(
    contract: CanonicalFactoryDocument<ImmutableTaskContract>,
    initialEvent: CanonicalFactoryDocument<TaskEvent>,
    initialEvidence: CanonicalFactoryDocument<EvidenceBundle>
  ): Promise<FactoryTaskSnapshot>;
  findById(taskId: string): Promise<FactoryTaskSnapshot | null>;
  listForConversation(
    conversationId: string,
    limit: number
  ): Promise<readonly FactoryTaskSnapshot[]>;
  listEvents(taskId: string): Promise<readonly TaskEvent[]>;
  append(event: CanonicalFactoryDocument<TaskEvent>): Promise<FactoryTaskSnapshot | null>;
  close(): void;
}

export interface FactoryAuthorityState {
  readonly scheduler: boolean;
  readonly prBroker: boolean;
}

export interface FactoryControlRepository {
  state(): Promise<FactoryAuthorityState>;
  record(event: CanonicalFactoryDocument<FactoryControlEvent>): Promise<FactoryAuthorityState>;
  history(control: FactoryControlName, limit: number): Promise<readonly FactoryControlEvent[]>;
}

export interface StoredEvidenceBundle {
  readonly bundle: EvidenceBundle;
  readonly digest: Sha256Digest;
}

export interface FactoryEvidenceRepository {
  appendEvidence(
    bundle: CanonicalFactoryDocument<EvidenceBundle>
  ): Promise<StoredEvidenceBundle | null>;
  latestEvidence(taskId: string): Promise<StoredEvidenceBundle | null>;
  listEvidence(taskId: string): Promise<readonly StoredEvidenceBundle[]>;
}
