import type { FactoryTaskState, Sha256Digest } from "@agentlab/contracts";

export interface FactoryCanaryPullRequestRepairRecoveryItem {
  readonly source: "recoverable";
  readonly taskId: string;
  readonly repositoryId: string;
  readonly authorizationDigest: Sha256Digest;
  readonly repairRunDigest: Sha256Digest;
  readonly runPolicyBundleDigest: Sha256Digest;
  readonly repairState: "ready" | "workspace-active" | "operation-active" | "abandoned";
  readonly taskState: FactoryTaskState;
  readonly runCreatedAt: string;
  readonly lastEventAt: string;
}

export interface FactoryCanaryPullRequestRepairAuthorizationItem {
  readonly source: "authorized";
  readonly taskId: string;
  readonly repositoryId: string;
  readonly authorizationDigest: Sha256Digest;
  readonly observationDigest: Sha256Digest;
  readonly reservationDigest: Sha256Digest;
  readonly schedulePolicyDigest: Sha256Digest;
  readonly factoryPolicyBundleDigest: Sha256Digest;
  readonly roleIdentityPolicyDigest: Sha256Digest;
  readonly handoffSchedulePolicyDigest: Sha256Digest;
  readonly handoffFactoryPolicyBundleDigest: Sha256Digest;
  readonly handoffRoleIdentityPolicyDigest: Sha256Digest;
  readonly scheduledFor: string;
  readonly finishedAt: string;
  readonly reservedAt: string;
  readonly expiresAt: string;
  readonly maintenanceSlot: string;
  readonly observationCreatedAt: string;
  readonly authorizationCreatedAt: string;
  readonly pullRequestRecordDigest: Sha256Digest;
  readonly headRevision: string;
}

export type FactoryCanaryPullRequestRepairQueueItem =
  FactoryCanaryPullRequestRepairRecoveryItem | FactoryCanaryPullRequestRepairAuthorizationItem;

export interface FactoryCanaryPullRequestRepairQueuePage {
  readonly items: readonly FactoryCanaryPullRequestRepairQueueItem[];
  readonly truncated: boolean;
}

export interface FactoryCanaryPullRequestRepairQueueQuery {
  readonly observedAt: string;
  readonly schedulePolicyDigest: Sha256Digest;
  readonly factoryPolicyBundleDigest: Sha256Digest;
  readonly roleIdentityPolicyDigest: Sha256Digest;
  readonly limit: number;
}

/** Read-only projection of recoverable repair journals and fresh canary repair authority. */
export interface FactoryCanaryPullRequestRepairQueue {
  listPending(
    query: FactoryCanaryPullRequestRepairQueueQuery
  ): Promise<FactoryCanaryPullRequestRepairQueuePage>;
  close(): void;
}
