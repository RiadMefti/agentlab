import type {
  FactoryPullRequestProposal,
  FactoryPullRequestObservation,
  FactoryPullRequestAuthorityRecord,
  FactoryPullRequestRecord,
  FactoryPullRequestUpdateProposal,
  FactoryPullRequestUpdateRecord,
  GitObjectId
} from "@agentlab/contracts";

export interface FactoryRepositoryGovernance {
  readonly requiresPullRequest: boolean;
  readonly requiredApprovals: number;
  readonly dismissesStaleReviews: boolean;
  readonly requiresCodeOwnerReviews: boolean;
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

export interface FactoryPullRequestBrokerIdentity {
  readonly brokerId: string;
  readonly repositoryId: string;
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

export interface VerifyFactoryDraftPullRequestInput {
  readonly proposal: FactoryPullRequestProposal;
  readonly record: FactoryPullRequestRecord;
}

export interface ObserveFactoryPullRequestInput {
  readonly record: FactoryPullRequestAuthorityRecord;
}

export interface UpdateFactoryDraftPullRequestInput {
  readonly proposal: FactoryPullRequestUpdateProposal;
  readonly priorRecord: FactoryPullRequestAuthorityRecord;
  readonly patch: string;
  readonly repositoryRoot: string;
}

export interface UpdateFactoryDraftPullRequestResult {
  readonly record: FactoryPullRequestUpdateRecord;
  readonly updated: boolean;
}

export interface VerifyUpdatedFactoryDraftPullRequestInput {
  readonly proposal: FactoryPullRequestUpdateProposal;
  readonly record: FactoryPullRequestUpdateRecord;
}

/** Credentialed read-only port. Returned feedback is untrusted evidence, never authority. */
export interface FactoryPullRequestObserver {
  identity(): FactoryPullRequestBrokerIdentity;
  observe(input: ObserveFactoryPullRequestInput): Promise<FactoryPullRequestObservation>;
}

/** Sole remote-write port. Implementations carry no model/provider credential. */
export interface FactoryDraftPullRequestBroker {
  identity(): FactoryPullRequestBrokerIdentity;
  inspect(repositoryId: string): Promise<FactoryRemoteRepositorySnapshot>;
  openDraft(input: OpenFactoryDraftPullRequestInput): Promise<OpenFactoryDraftPullRequestResult>;
  updateDraft(
    input: UpdateFactoryDraftPullRequestInput
  ): Promise<UpdateFactoryDraftPullRequestResult>;
  verifyDraft(input: VerifyFactoryDraftPullRequestInput): Promise<void>;
  verifyUpdatedDraft(input: VerifyUpdatedFactoryDraftPullRequestInput): Promise<void>;
  closeDraft(record: FactoryPullRequestRecord, reason: string): Promise<void>;
}
