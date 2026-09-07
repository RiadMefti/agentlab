import type {
  FactoryExternalPullRequestFeedbackRecord,
  FactoryExternalPullRequestFeedbackRun,
  FactoryExternalPullRequestRepairAdmissionPolicy,
  FactoryExternalPullRequestRepairAuthorization,
  FactoryExternalPullRequestRepairBundle,
  FactoryExternalPullRequestRepairDecision,
  FactoryExternalPullRequestRepairExecutionEvent,
  FactoryExternalPullRequestRepairExecutionPolicy,
  FactoryExternalPullRequestRepairExecutionRun,
  FactoryExternalPullRequestRepairExecutionState,
  Sha256Digest
} from "@agentlab/contracts";

import type { CanonicalFactoryDocument } from "./factory-documents.js";

export interface FactoryExternalPullRequestRepairExecutionCandidate {
  readonly decision: CanonicalFactoryDocument<FactoryExternalPullRequestRepairDecision>;
  readonly authorization: CanonicalFactoryDocument<FactoryExternalPullRequestRepairAuthorization>;
  readonly feedbackRun: CanonicalFactoryDocument<FactoryExternalPullRequestFeedbackRun>;
  readonly feedbackRecord: CanonicalFactoryDocument<FactoryExternalPullRequestFeedbackRecord>;
}

export interface FactoryExternalPullRequestRepairExecutionJournalSnapshot {
  readonly run: FactoryExternalPullRequestRepairExecutionRun;
  readonly runDigest: Sha256Digest;
  readonly state: FactoryExternalPullRequestRepairExecutionState;
  readonly sequence: number;
  readonly lastEvent: FactoryExternalPullRequestRepairExecutionEvent;
  readonly lastEventDigest: Sha256Digest;
  readonly history: readonly FactoryExternalPullRequestRepairExecutionEvent[];
  readonly bundle: FactoryExternalPullRequestRepairBundle | null;
}

/** Completed admission projection plus append-only credentialless repair execution journal. */
export interface FactoryExternalPullRequestRepairExecutionRepository {
  listAdmitted(input: {
    readonly repositoryId: string;
    readonly admissionPolicyDigest: Sha256Digest;
    readonly repairExecutionPolicyDigest: Sha256Digest;
    readonly limit: number;
  }): Promise<readonly FactoryExternalPullRequestRepairExecutionCandidate[]>;
  listActive(input: {
    readonly repositoryId: string;
    readonly repairExecutionPolicyDigest: Sha256Digest;
    readonly limit: number;
  }): Promise<readonly FactoryExternalPullRequestRepairExecutionJournalSnapshot[]>;
  findCandidateByAuthorization(
    authorizationDigest: Sha256Digest
  ): Promise<FactoryExternalPullRequestRepairExecutionCandidate | null>;
  register(
    admissionPolicy: CanonicalFactoryDocument<FactoryExternalPullRequestRepairAdmissionPolicy>,
    executionPolicy: CanonicalFactoryDocument<FactoryExternalPullRequestRepairExecutionPolicy>,
    run: CanonicalFactoryDocument<FactoryExternalPullRequestRepairExecutionRun>,
    event: CanonicalFactoryDocument<FactoryExternalPullRequestRepairExecutionEvent>,
    candidate: FactoryExternalPullRequestRepairExecutionCandidate
  ): Promise<FactoryExternalPullRequestRepairExecutionJournalSnapshot>;
  findByAuthorization(
    authorizationDigest: Sha256Digest,
    repairExecutionPolicyDigest: Sha256Digest
  ): Promise<FactoryExternalPullRequestRepairExecutionJournalSnapshot | null>;
  append(
    event: CanonicalFactoryDocument<FactoryExternalPullRequestRepairExecutionEvent>
  ): Promise<FactoryExternalPullRequestRepairExecutionJournalSnapshot | null>;
  recordBundle(
    event: CanonicalFactoryDocument<FactoryExternalPullRequestRepairExecutionEvent>,
    bundle: CanonicalFactoryDocument<FactoryExternalPullRequestRepairBundle>
  ): Promise<FactoryExternalPullRequestRepairExecutionJournalSnapshot | null>;
  close(): void;
}
