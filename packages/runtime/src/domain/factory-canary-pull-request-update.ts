import type {
  FactoryPullRequestUpdateState,
  FactoryTaskState,
  Sha256Digest
} from "@agentlab/contracts";

export interface FactoryCanaryPullRequestUpdateRecoveryItem {
  readonly source: "recoverable";
  readonly taskId: string;
  readonly repositoryId: string;
  readonly authorizationDigest: Sha256Digest;
  readonly repairRunDigest: Sha256Digest;
  readonly updateRunDigest: Sha256Digest;
  readonly runPolicyBundleDigest: Sha256Digest;
  readonly brokerId: string;
  readonly updateState: Exclude<FactoryPullRequestUpdateState, "completed">;
  readonly taskState: FactoryTaskState;
  readonly runCreatedAt: string;
  readonly lastEventAt: string;
}

export interface FactoryCanaryPullRequestUpdateAuthorizationItem {
  readonly source: "authorized";
  readonly taskId: string;
  readonly repositoryId: string;
  readonly authorizationDigest: Sha256Digest;
  readonly observationDigest: Sha256Digest;
  readonly repairRunDigest: Sha256Digest;
  readonly repairRunPolicyBundleDigest: Sha256Digest;
  readonly contractRepairAttempt: number;
  readonly repairFinishedAt: string;
  readonly reservationDigest: Sha256Digest;
  readonly schedulePolicyDigest: Sha256Digest;
  readonly factoryPolicyBundleDigest: Sha256Digest;
  readonly roleIdentityPolicyDigest: Sha256Digest;
  readonly handoffSchedulePolicyDigest: Sha256Digest;
  readonly handoffFactoryPolicyBundleDigest: Sha256Digest;
  readonly handoffRoleIdentityPolicyDigest: Sha256Digest;
  readonly scheduledFor: string;
  readonly handoffFinishedAt: string;
  readonly reservedAt: string;
  readonly expiresAt: string;
  readonly maintenanceSlot: string;
  readonly observationCreatedAt: string;
  readonly authorizationCreatedAt: string;
  readonly pullRequestRecordDigest: Sha256Digest;
  readonly headRevision: string;
  readonly brokerId: string;
}

export type FactoryCanaryPullRequestUpdateQueueItem =
  FactoryCanaryPullRequestUpdateRecoveryItem | FactoryCanaryPullRequestUpdateAuthorizationItem;

export interface FactoryCanaryPullRequestUpdateQueuePage {
  readonly items: readonly FactoryCanaryPullRequestUpdateQueueItem[];
  readonly truncated: boolean;
}

export interface FactoryCanaryPullRequestUpdateQueueQuery {
  readonly repositoryId: string;
  readonly observedAt: string;
  readonly schedulePolicyDigest: Sha256Digest;
  readonly factoryPolicyBundleDigest: Sha256Digest;
  readonly roleIdentityPolicyDigest: Sha256Digest;
  readonly limit: number;
}

/** Read-only projection of interrupted update journals and completed canary repair proposals. */
export interface FactoryCanaryPullRequestUpdateQueue {
  listPending(
    query: FactoryCanaryPullRequestUpdateQueueQuery
  ): Promise<FactoryCanaryPullRequestUpdateQueuePage>;
  close(): void;
}
