import type { Sha256Digest } from "@agentlab/contracts";

export interface FactoryCanaryBrokerQueueItem {
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
  readonly source: "undispatched" | "recoverable";
}

export interface FactoryCanaryBrokerQueuePage {
  readonly items: readonly FactoryCanaryBrokerQueueItem[];
  readonly truncated: boolean;
}

export interface FactoryCanaryBrokerQueueQuery {
  readonly repositoryId: string;
  readonly observedAt: string;
  readonly limit: number;
}

/** Read-only desired/observed projection for scheduled draft-PR reconciliation. */
export interface FactoryCanaryBrokerQueue {
  listPending(query: FactoryCanaryBrokerQueueQuery): Promise<FactoryCanaryBrokerQueuePage>;
  close(): void;
}
