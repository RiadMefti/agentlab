import type { Sha256Digest } from "@agentlab/contracts";

export interface FactoryCanaryPullRequestMaintenanceCoordinates {
  readonly reservationDigest: Sha256Digest;
  readonly schedulePolicyDigest: Sha256Digest;
  readonly factoryPolicyBundleDigest: Sha256Digest;
  readonly roleIdentityPolicyDigest: Sha256Digest;
  readonly scheduledFor: string;
}

export interface FactoryCanaryPullRequestMaintenanceQueueItem {
  readonly taskId: string;
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
  readonly currentPullRequestRecordDigest: Sha256Digest;
  readonly currentHeadRevision: string;
  readonly source: "unobserved" | "observed-actionable";
  readonly observationDigest: Sha256Digest | null;
}

export interface FactoryCanaryPullRequestMaintenanceQueuePage {
  readonly items: readonly FactoryCanaryPullRequestMaintenanceQueueItem[];
  readonly truncated: boolean;
}

export interface FactoryCanaryPullRequestMaintenanceQueueQuery {
  readonly repositoryId: string;
  readonly observedAt: string;
  readonly maintenanceSlot: string;
  readonly limit: number;
}

/** Read-only projection of exact open canary PR heads that still need one slot's broker work. */
export interface FactoryCanaryPullRequestMaintenanceQueue {
  listPending(
    query: FactoryCanaryPullRequestMaintenanceQueueQuery
  ): Promise<FactoryCanaryPullRequestMaintenanceQueuePage>;
  close(): void;
}
