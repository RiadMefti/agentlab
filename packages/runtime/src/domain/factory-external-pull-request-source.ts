import type { FactoryExternalPullRequestCandidate } from "@agentlab/contracts";

export type FactoryExternalPullRequestRemoteItem = Omit<
  FactoryExternalPullRequestCandidate,
  "disposition" | "reasonCodes"
>;

export interface FactoryExternalPullRequestSourceIdentity {
  readonly repositoryId: string;
  readonly observerId: string;
}

export interface FactoryExternalPullRequestPage {
  readonly items: readonly FactoryExternalPullRequestRemoteItem[];
  readonly truncated: boolean;
}

/** Credentialed remote-read port. It deliberately cannot express any repository mutation. */
export interface FactoryExternalPullRequestSource {
  identity(): FactoryExternalPullRequestSourceIdentity;
  inspectRepository(): Promise<{
    readonly repositoryId: string;
    readonly repositoryNumericId: number;
    readonly defaultBranch: string;
  }>;
  listOpen(limit: number): Promise<FactoryExternalPullRequestPage>;
}

/** Local lineage lookup used only to avoid adopting AgentLab's own PRs into the external lane. */
export interface FactoryOwnedPullRequestIndex {
  contains(repositoryId: string, pullRequestNumber: number): Promise<boolean>;
  close(): void;
}
