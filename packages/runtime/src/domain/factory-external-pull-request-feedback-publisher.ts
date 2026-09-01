import type { Sha256Digest } from "@agentlab/contracts";

export interface FactoryExternalPullRequestFeedbackPublisherIdentity {
  readonly repositoryId: string;
  readonly repositoryNumericId: number;
  readonly publisherId: string;
  readonly publisherUserId: number;
}

export interface FactoryExternalPullRequestRemotePublication {
  readonly reviewId: string;
  readonly state: "commented";
  readonly url: string | null;
  readonly headRevision: string;
  readonly bodyDigest: Sha256Digest;
  readonly submittedAt: string;
}

export interface FactoryExternalPullRequestRemoteSnapshot {
  readonly repositoryId: string;
  readonly pullRequestNumber: number;
  readonly url: string;
  readonly state: "open" | "closed";
  readonly draft: boolean;
  readonly merged: boolean;
  readonly baseRevision: string;
  readonly headRevision: string;
  readonly existingPublication: FactoryExternalPullRequestRemotePublication | null;
}

export interface FactoryExternalPullRequestFeedbackPublisher {
  identity(): FactoryExternalPullRequestFeedbackPublisherIdentity;
  inspectRepository(): Promise<{
    readonly repositoryId: string;
    readonly repositoryNumericId: number;
  }>;
  inspect(input: {
    readonly pullRequestNumber: number;
    readonly headRevision: string;
    readonly marker: string;
    readonly body: string;
    readonly bodyDigest: Sha256Digest;
  }): Promise<FactoryExternalPullRequestRemoteSnapshot>;
  publish(input: {
    readonly pullRequestNumber: number;
    readonly headRevision: string;
    readonly marker: string;
    readonly body: string;
    readonly bodyDigest: Sha256Digest;
  }): Promise<FactoryExternalPullRequestRemotePublication>;
}
