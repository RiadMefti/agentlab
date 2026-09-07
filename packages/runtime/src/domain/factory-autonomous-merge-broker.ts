import type {
  FactoryAutonomousMergeAuthorization,
  FactoryAutonomousMergeRecord
} from "@agentlab/contracts";

export interface FactoryAutonomousMergerIdentity {
  readonly repositoryId: string;
  readonly mergerId: string;
}

export interface FactoryAutonomousMergeRemoteSnapshot {
  readonly repositoryId: string;
  readonly pullRequestNodeId: string;
  readonly pullRequestNumber: number;
  readonly pullRequestUrl: string;
  readonly state: "open" | "closed";
  readonly draft: boolean;
  readonly merged: boolean;
  readonly baseRevision: string;
  readonly headRevision: string;
  readonly mergeQueueEntryId: string | null;
  readonly mergedRevision: string | null;
  readonly mergedAt: string | null;
}

export interface FactoryAutonomousMergeEnqueueResult {
  readonly snapshot: FactoryAutonomousMergeRemoteSnapshot;
  readonly mergeQueueEntryId: string;
  readonly created: boolean;
}

/** Narrow remote authority: exact PR readback, draft promotion, and merge-queue enqueue only. */
export interface FactoryAutonomousMerger {
  identity(): FactoryAutonomousMergerIdentity;
  observe(
    authorization: FactoryAutonomousMergeAuthorization
  ): Promise<FactoryAutonomousMergeRemoteSnapshot>;
  markReadyForReview(
    authorization: FactoryAutonomousMergeAuthorization
  ): Promise<FactoryAutonomousMergeRemoteSnapshot>;
  enqueue(
    authorization: FactoryAutonomousMergeAuthorization
  ): Promise<FactoryAutonomousMergeEnqueueResult>;
  verifyRecord(
    authorization: FactoryAutonomousMergeAuthorization,
    record: FactoryAutonomousMergeRecord
  ): Promise<void>;
}

export class FactoryAutonomousMergeStaleError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "FactoryAutonomousMergeStaleError";
  }
}

export class FactoryAutonomousMergeQuarantineError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "FactoryAutonomousMergeQuarantineError";
  }
}
