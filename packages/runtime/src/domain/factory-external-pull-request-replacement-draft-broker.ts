import type {
  FactoryExternalPullRequestReplacementDraftProposal,
  FactoryExternalPullRequestReplacementDraftRecord,
  GitObjectId
} from "@agentlab/contracts";

import type { FactoryRepositoryGovernance } from "./factory-pull-request-broker.js";

export interface FactoryExternalPullRequestReplacementDraftBrokerIdentity {
  readonly repositoryId: string;
  readonly brokerId: string;
}

export interface FactoryExternalPullRequestOriginalSnapshot {
  readonly repositoryId: string;
  readonly number: number;
  readonly url: string;
  readonly state: "open" | "closed";
  readonly baseBranch: string;
  readonly baseRevision: GitObjectId;
  readonly headRevision: GitObjectId;
  readonly governance: FactoryRepositoryGovernance;
}

/** Narrow remote-write port: new branch plus draft PR only; no update, approval, merge, or release. */
export interface FactoryExternalPullRequestReplacementDraftBroker {
  identity(): FactoryExternalPullRequestReplacementDraftBrokerIdentity;
  inspectOriginal(pullRequestNumber: number): Promise<FactoryExternalPullRequestOriginalSnapshot>;
  publishBranch(input: {
    readonly proposal: FactoryExternalPullRequestReplacementDraftProposal;
    readonly patch: string;
    readonly repositoryRoot: string;
  }): Promise<{ readonly headRevision: GitObjectId; readonly created: boolean }>;
  openDraft(input: {
    readonly proposal: FactoryExternalPullRequestReplacementDraftProposal;
    readonly headRevision: GitObjectId;
  }): Promise<{
    readonly record: FactoryExternalPullRequestReplacementDraftRecord;
    readonly created: boolean;
  }>;
  verifyDraft(input: {
    readonly proposal: FactoryExternalPullRequestReplacementDraftProposal;
    readonly record: FactoryExternalPullRequestReplacementDraftRecord;
  }): Promise<void>;
}

export class FactoryExternalPullRequestReplacementStaleError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "FactoryExternalPullRequestReplacementStaleError";
  }
}

export class FactoryExternalPullRequestReplacementQuarantineError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "FactoryExternalPullRequestReplacementQuarantineError";
  }
}
