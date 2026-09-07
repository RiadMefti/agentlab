import type {
  FactoryExternalPullRequestFeedbackEvent,
  FactoryExternalPullRequestFeedbackRecord,
  FactoryExternalPullRequestFeedbackRun,
  FactoryExternalPullRequestFeedbackState,
  FactoryExternalPullRequestReviewBundle,
  FactoryExternalPullRequestReviewRun,
  Sha256Digest
} from "@agentlab/contracts";

import type { CanonicalFactoryDocument } from "./factory-documents.js";

export interface FactoryExternalPullRequestFeedbackCandidate {
  readonly reviewRun: FactoryExternalPullRequestReviewRun;
  readonly reviewRunDigest: Sha256Digest;
  readonly bundle: FactoryExternalPullRequestReviewBundle;
  readonly bundleDigest: Sha256Digest;
}

export interface FactoryExternalPullRequestFeedbackJournalSnapshot {
  readonly run: FactoryExternalPullRequestFeedbackRun;
  readonly runDigest: Sha256Digest;
  readonly state: FactoryExternalPullRequestFeedbackState;
  readonly sequence: number;
  readonly lastEvent: FactoryExternalPullRequestFeedbackEvent;
  readonly lastEventDigest: Sha256Digest;
  readonly history: readonly FactoryExternalPullRequestFeedbackEvent[];
  readonly record: FactoryExternalPullRequestFeedbackRecord | null;
}

export interface FactoryExternalPullRequestFeedbackRepository {
  listCompletedReviews(input: {
    readonly repositoryId: string;
    readonly reviewPolicyDigest: Sha256Digest;
    readonly limit: number;
  }): Promise<readonly FactoryExternalPullRequestFeedbackCandidate[]>;
  listActive(input: {
    readonly repositoryId: string;
    readonly feedbackPolicyDigest: Sha256Digest;
    readonly limit: number;
  }): Promise<readonly FactoryExternalPullRequestFeedbackJournalSnapshot[]>;
  findByBundle(
    bundleDigest: Sha256Digest
  ): Promise<FactoryExternalPullRequestFeedbackJournalSnapshot | null>;
  register(
    run: CanonicalFactoryDocument<FactoryExternalPullRequestFeedbackRun>,
    event: CanonicalFactoryDocument<FactoryExternalPullRequestFeedbackEvent>
  ): Promise<FactoryExternalPullRequestFeedbackJournalSnapshot>;
  append(
    event: CanonicalFactoryDocument<FactoryExternalPullRequestFeedbackEvent>
  ): Promise<FactoryExternalPullRequestFeedbackJournalSnapshot | null>;
  record(
    event: CanonicalFactoryDocument<FactoryExternalPullRequestFeedbackEvent>,
    record: CanonicalFactoryDocument<FactoryExternalPullRequestFeedbackRecord>
  ): Promise<FactoryExternalPullRequestFeedbackJournalSnapshot | null>;
  close(): void;
}
