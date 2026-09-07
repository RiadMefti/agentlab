import type {
  FactoryAutonomousMergeAuthorization,
  FactoryAutonomousMergeEvent,
  FactoryAutonomousMergePolicy,
  FactoryAutonomousMergeRecord,
  FactoryAutonomousMergeRun,
  FactoryAutonomousMergeState,
  Sha256Digest
} from "@agentlab/contracts";

import type { CanonicalFactoryDocument } from "./factory-documents.js";

export interface FactoryAutonomousMergeCandidate {
  readonly authorization: CanonicalFactoryDocument<FactoryAutonomousMergeAuthorization>;
  readonly evidenceBundleDigest: Sha256Digest;
}

export interface FactoryAutonomousMergeJournalSnapshot {
  readonly run: FactoryAutonomousMergeRun;
  readonly runDigest: Sha256Digest;
  readonly state: FactoryAutonomousMergeState;
  readonly sequence: number;
  readonly lastEvent: FactoryAutonomousMergeEvent;
  readonly lastEventDigest: Sha256Digest;
  readonly history: readonly FactoryAutonomousMergeEvent[];
  readonly record: FactoryAutonomousMergeRecord | null;
}

export class FactoryAutonomousMergeCapacityError extends Error {
  public constructor() {
    super("Autonomous merge daily capacity is exhausted.");
    this.name = "FactoryAutonomousMergeCapacityError";
  }
}

/** Exact authorization projection plus append-only intent-before-effect merge journal. */
export interface FactoryAutonomousMergeRepository {
  listActive(input: {
    readonly repositoryId: string;
    readonly mergePolicyDigest: Sha256Digest;
    readonly limit: number;
  }): Promise<readonly FactoryAutonomousMergeJournalSnapshot[]>;
  countCompletedForUtcDay(input: {
    readonly repositoryId: string;
    readonly mergePolicyDigest: Sha256Digest;
    readonly windowStart: string;
    readonly windowEnd: string;
  }): Promise<number>;
  /** Repository-wide reservations, carryover uncertainty, and merges in the UTC day at `at`. */
  countCapacityForUtcDay(input: {
    readonly repositoryId: string;
    readonly at: string;
  }): Promise<number>;
  /** Atomically reserves daily capacity before recording a new run or allowing remote effects. */
  register(
    policy: CanonicalFactoryDocument<FactoryAutonomousMergePolicy>,
    run: CanonicalFactoryDocument<FactoryAutonomousMergeRun>,
    event: CanonicalFactoryDocument<FactoryAutonomousMergeEvent>,
    candidate: FactoryAutonomousMergeCandidate
  ): Promise<FactoryAutonomousMergeJournalSnapshot>;
  append(
    event: CanonicalFactoryDocument<FactoryAutonomousMergeEvent>
  ): Promise<FactoryAutonomousMergeJournalSnapshot | null>;
  record(
    event: CanonicalFactoryDocument<FactoryAutonomousMergeEvent>,
    record: CanonicalFactoryDocument<FactoryAutonomousMergeRecord>
  ): Promise<FactoryAutonomousMergeJournalSnapshot | null>;
  close(): void;
}
