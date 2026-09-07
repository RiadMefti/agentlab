import type {
  FactoryExternalPullRequestCandidate,
  FactoryExternalPullRequestReviewBundle,
  FactoryExternalPullRequestReviewEvent,
  FactoryExternalPullRequestReviewRun,
  FactoryExternalPullRequestReviewState,
  Sha256Digest
} from "@agentlab/contracts";

import type { CanonicalFactoryDocument } from "./factory-documents.js";

export interface FactoryExternalPullRequestReviewCandidateEnvelope {
  readonly candidate: FactoryExternalPullRequestCandidate;
  readonly candidateDigest: Sha256Digest;
  readonly discoveryRunId: string;
  readonly discoveryRunDigest: Sha256Digest;
  readonly discoverySnapshotDigest: Sha256Digest;
  readonly discoveryPolicyDigest: Sha256Digest;
}

export interface FactoryExternalPullRequestReviewCandidateSource {
  listAdmitted(input: {
    readonly repositoryId: string;
    readonly discoveryPolicyDigest: Sha256Digest;
    readonly reviewPolicyDigest: Sha256Digest;
    readonly limit: number;
  }): Promise<readonly FactoryExternalPullRequestReviewCandidateEnvelope[]>;
}

export interface FactoryExternalPullRequestReviewJournalSnapshot {
  readonly run: FactoryExternalPullRequestReviewRun;
  readonly runDigest: Sha256Digest;
  readonly state: FactoryExternalPullRequestReviewState;
  readonly sequence: number;
  readonly lastEvent: FactoryExternalPullRequestReviewEvent;
  readonly lastEventDigest: Sha256Digest;
  readonly history: readonly FactoryExternalPullRequestReviewEvent[];
  readonly bundle: FactoryExternalPullRequestReviewBundle | null;
}

export interface FactoryExternalPullRequestReviewRepository extends FactoryExternalPullRequestReviewCandidateSource {
  listActive(input: {
    readonly repositoryId: string;
    readonly reviewPolicyDigest: Sha256Digest;
    readonly limit: number;
  }): Promise<readonly FactoryExternalPullRequestReviewJournalSnapshot[]>;
  register(
    run: CanonicalFactoryDocument<FactoryExternalPullRequestReviewRun>,
    event: CanonicalFactoryDocument<FactoryExternalPullRequestReviewEvent>
  ): Promise<FactoryExternalPullRequestReviewJournalSnapshot>;
  findByCandidate(input: {
    readonly candidateDigest: Sha256Digest;
    readonly reviewPolicyDigest: Sha256Digest;
  }): Promise<FactoryExternalPullRequestReviewJournalSnapshot | null>;
  append(
    event: CanonicalFactoryDocument<FactoryExternalPullRequestReviewEvent>
  ): Promise<FactoryExternalPullRequestReviewJournalSnapshot | null>;
  recordBundle(
    event: CanonicalFactoryDocument<FactoryExternalPullRequestReviewEvent>,
    bundle: CanonicalFactoryDocument<FactoryExternalPullRequestReviewBundle>
  ): Promise<FactoryExternalPullRequestReviewJournalSnapshot | null>;
  close(): void;
}
