import type {
  FactoryExternalPullRequestFeedbackRun,
  FactoryExternalPullRequestRepairBundle,
  FactoryExternalPullRequestRepairExecutionRun,
  FactoryExternalPullRequestRepairQualificationBundle,
  FactoryExternalPullRequestRepairQualificationEvent,
  FactoryExternalPullRequestRepairQualificationPolicy,
  FactoryExternalPullRequestRepairQualificationRun,
  FactoryExternalPullRequestRepairQualificationState,
  FactoryExternalPullRequestRepairerRecord,
  Sha256Digest
} from "@agentlab/contracts";

import type { CanonicalFactoryDocument } from "./factory-documents.js";

export interface FactoryExternalPullRequestRepairQualificationCandidate {
  readonly repairRun: CanonicalFactoryDocument<FactoryExternalPullRequestRepairExecutionRun>;
  readonly repairBundle: CanonicalFactoryDocument<FactoryExternalPullRequestRepairBundle>;
  readonly feedbackRun: CanonicalFactoryDocument<FactoryExternalPullRequestFeedbackRun>;
}

export interface FactoryExternalPullRequestRepairQualificationJournalSnapshot {
  readonly run: FactoryExternalPullRequestRepairQualificationRun;
  readonly runDigest: Sha256Digest;
  readonly state: FactoryExternalPullRequestRepairQualificationState;
  readonly sequence: number;
  readonly lastEvent: FactoryExternalPullRequestRepairQualificationEvent;
  readonly lastEventDigest: Sha256Digest;
  readonly history: readonly FactoryExternalPullRequestRepairQualificationEvent[];
  readonly bundle: FactoryExternalPullRequestRepairQualificationBundle | null;
}

/** Completed repair projection plus append-only gate/review qualification journal. */
export interface FactoryExternalPullRequestRepairQualificationRepository {
  listCompletedRepairs(input: {
    readonly repositoryId: string;
    readonly repairExecutionPolicyDigest: Sha256Digest;
    readonly qualificationPolicyDigest: Sha256Digest;
    readonly limit: number;
  }): Promise<readonly FactoryExternalPullRequestRepairQualificationCandidate[]>;
  listActive(input: {
    readonly repositoryId: string;
    readonly qualificationPolicyDigest: Sha256Digest;
    readonly limit: number;
  }): Promise<readonly FactoryExternalPullRequestRepairQualificationJournalSnapshot[]>;
  findCandidateByRepairBundle(
    repairBundleDigest: Sha256Digest
  ): Promise<FactoryExternalPullRequestRepairQualificationCandidate | null>;
  register(
    policy: CanonicalFactoryDocument<FactoryExternalPullRequestRepairQualificationPolicy>,
    run: CanonicalFactoryDocument<FactoryExternalPullRequestRepairQualificationRun>,
    event: CanonicalFactoryDocument<FactoryExternalPullRequestRepairQualificationEvent>,
    candidate: FactoryExternalPullRequestRepairQualificationCandidate,
    repairerRecord: CanonicalFactoryDocument<FactoryExternalPullRequestRepairerRecord>
  ): Promise<FactoryExternalPullRequestRepairQualificationJournalSnapshot>;
  findByRepairBundle(
    repairBundleDigest: Sha256Digest,
    qualificationPolicyDigest: Sha256Digest
  ): Promise<FactoryExternalPullRequestRepairQualificationJournalSnapshot | null>;
  append(
    event: CanonicalFactoryDocument<FactoryExternalPullRequestRepairQualificationEvent>
  ): Promise<FactoryExternalPullRequestRepairQualificationJournalSnapshot | null>;
  recordBundle(
    event: CanonicalFactoryDocument<FactoryExternalPullRequestRepairQualificationEvent>,
    bundle: CanonicalFactoryDocument<FactoryExternalPullRequestRepairQualificationBundle>
  ): Promise<FactoryExternalPullRequestRepairQualificationJournalSnapshot | null>;
  close(): void;
}
