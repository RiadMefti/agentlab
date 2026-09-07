import type {
  FactoryExternalPullRequestFeedbackRecord,
  FactoryExternalPullRequestFeedbackRun,
  FactoryExternalPullRequestRepairAdmissionPolicy,
  FactoryExternalPullRequestRepairAuthorization,
  FactoryExternalPullRequestRepairDecision,
  Sha256Digest
} from "@agentlab/contracts";

import type { CanonicalFactoryDocument } from "./factory-documents.js";

export interface FactoryExternalPullRequestRepairAdmissionCandidate {
  readonly feedbackRun: CanonicalFactoryDocument<FactoryExternalPullRequestFeedbackRun>;
  readonly feedbackRecord: CanonicalFactoryDocument<FactoryExternalPullRequestFeedbackRecord>;
}

export interface FactoryExternalPullRequestRepairAdmissionSnapshot {
  readonly decision: FactoryExternalPullRequestRepairDecision;
  readonly decisionDigest: Sha256Digest;
  readonly authorization: FactoryExternalPullRequestRepairAuthorization | null;
  readonly authorizationDigest: Sha256Digest | null;
}

export interface FactoryExternalPullRequestRepairAdmissionWriteResult extends FactoryExternalPullRequestRepairAdmissionSnapshot {
  readonly status: "created" | "existing";
}

/** Immutable completed-feedback projection and atomic external-repair admission store. */
export interface FactoryExternalPullRequestRepairAdmissionRepository {
  listCandidates(input: {
    readonly repositoryId: string;
    readonly reviewPolicyDigest: Sha256Digest;
    readonly feedbackPolicyDigest: Sha256Digest;
    readonly admissionPolicyDigest: Sha256Digest;
    readonly limit: number;
  }): Promise<readonly FactoryExternalPullRequestRepairAdmissionCandidate[]>;
  findByBundle(
    bundleDigest: Sha256Digest,
    admissionPolicyDigest: Sha256Digest
  ): Promise<FactoryExternalPullRequestRepairAdmissionSnapshot | null>;
  decide(
    policy: CanonicalFactoryDocument<FactoryExternalPullRequestRepairAdmissionPolicy>,
    decision: CanonicalFactoryDocument<FactoryExternalPullRequestRepairDecision>,
    authorization: CanonicalFactoryDocument<FactoryExternalPullRequestRepairAuthorization> | null,
    candidate: FactoryExternalPullRequestRepairAdmissionCandidate
  ): Promise<FactoryExternalPullRequestRepairAdmissionWriteResult>;
  close(): void;
}
