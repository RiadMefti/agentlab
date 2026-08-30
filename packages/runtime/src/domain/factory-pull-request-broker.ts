import type {
  FactoryPullRequestProposal,
  FactoryPullRequestRecord,
  GitObjectId
} from "@agentlab/contracts";

export interface FactoryRepositoryGovernance {
  readonly requiresPullRequest: boolean;
  readonly requiredApprovals: number;
  readonly dismissesStaleReviews: boolean;
  readonly requiresLastPushApproval: boolean;
  readonly enforcesAdmins: boolean;
  readonly allowsForcePushes: boolean;
  readonly allowsDeletions: boolean;
  readonly requiredStatusChecks: readonly string[];
}

export interface FactoryRemoteRepositorySnapshot {
  readonly repositoryId: string;
  readonly baseBranch: string;
  readonly baseRevision: GitObjectId;
  readonly governance: FactoryRepositoryGovernance;
}

export interface OpenFactoryDraftPullRequestInput {
  readonly proposal: FactoryPullRequestProposal;
  readonly patch: string;
  readonly repositoryRoot: string;
}

export interface OpenFactoryDraftPullRequestResult {
  readonly record: FactoryPullRequestRecord;
  readonly created: boolean;
}

/** Sole remote-write port. Implementations carry no model/provider credential. */
export interface FactoryDraftPullRequestBroker {
  inspect(repositoryId: string): Promise<FactoryRemoteRepositorySnapshot>;
  openDraft(input: OpenFactoryDraftPullRequestInput): Promise<OpenFactoryDraftPullRequestResult>;
  closeDraft(record: FactoryPullRequestRecord, reason: string): Promise<void>;
}
