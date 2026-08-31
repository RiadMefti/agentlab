import type { FactoryEvalAssessment, FactoryEvalRun, Sha256Digest } from "@agentlab/contracts";

import type { CanonicalFactoryDocument } from "./factory-documents.js";

export interface FactoryEvalSnapshot {
  readonly run: FactoryEvalRun;
  readonly runDigest: Sha256Digest;
  readonly assessment: FactoryEvalAssessment;
  readonly assessmentDigest: Sha256Digest;
}

/** Immutable matched eval run and its one deterministic assessment. */
export interface FactoryEvaluationRepository {
  record(
    run: CanonicalFactoryDocument<FactoryEvalRun>,
    assessment: CanonicalFactoryDocument<FactoryEvalAssessment>
  ): Promise<FactoryEvalSnapshot>;
  findByRunId(runId: string): Promise<FactoryEvalSnapshot | null>;
  findByAssessmentDigest(assessmentDigest: Sha256Digest): Promise<FactoryEvalSnapshot | null>;
  close(): void;
}
