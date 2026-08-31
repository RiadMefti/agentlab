import type { FactoryCanaryApproval, FactoryCanaryCohort, Sha256Digest } from "@agentlab/contracts";

import type { CanonicalFactoryDocument } from "./factory-documents.js";

export interface FactoryCanarySnapshot {
  readonly approval: FactoryCanaryApproval;
  readonly approvalDigest: Sha256Digest;
  readonly cohort: FactoryCanaryCohort;
  readonly cohortDigest: Sha256Digest;
}

/** One human approval can issue one immutable, bounded, non-release canary cohort. */
export interface FactoryCanaryRepository {
  authorize(
    approval: CanonicalFactoryDocument<FactoryCanaryApproval>,
    cohort: CanonicalFactoryDocument<FactoryCanaryCohort>
  ): Promise<FactoryCanarySnapshot>;
  findByAssessmentDigest(assessmentDigest: Sha256Digest): Promise<FactoryCanarySnapshot | null>;
  findByCohortDigest(cohortDigest: Sha256Digest): Promise<FactoryCanarySnapshot | null>;
  close(): void;
}
