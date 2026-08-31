import {
  factoryIdentifierSchema,
  factoryTimestampSchema,
  sha256DigestSchema
} from "@agentlab/contracts";
import { z } from "zod";

import { ConflictError, NotFoundError } from "../domain/errors.js";
import type { FactoryDocumentCodec } from "../domain/factory-documents.js";
import {
  assertFactoryEvalAssessment,
  assertFactoryEvalRun
} from "../domain/factory-evaluation-integrity.js";
import { evaluateFactoryEvalRun } from "../domain/factory-evaluation-policy.js";
import type {
  FactoryEvaluationRepository,
  FactoryEvalSnapshot
} from "../domain/factory-evaluation-repository.js";

const inspectCommandSchema = z.object({ assessmentDigest: sha256DigestSchema }).strict();

export interface FactoryEvaluationServiceDependencies {
  readonly runnerId: string;
  readonly evaluations: FactoryEvaluationRepository;
  readonly documents: Pick<
    FactoryDocumentCodec,
    "configurationCandidate" | "evalSuite" | "evalRun" | "evalAssessment"
  >;
  readonly now: () => string;
  readonly createId: () => string;
}

/** Records complete matched trials and computes one deterministic promotion assessment. */
export class FactoryEvaluationService {
  readonly #runnerId: string;

  public constructor(private readonly dependencies: FactoryEvaluationServiceDependencies) {
    this.#runnerId = factoryIdentifierSchema.parse(dependencies.runnerId);
  }

  public async assess(input: unknown): Promise<FactoryEvalSnapshot> {
    const run = this.dependencies.documents.evalRun(input);
    assertFactoryEvalRun(run, this.dependencies.documents);
    if (run.value.actor.id !== this.#runnerId) {
      throw new ConflictError("Factory eval run actor does not match this evaluator identity.");
    }
    const existing = await this.dependencies.evaluations.findByRunId(run.value.runId);
    if (existing !== null) {
      if (existing.runDigest !== run.digest) {
        throw new ConflictError(
          "Factory eval run ID already exists with different immutable data."
        );
      }
      return existing;
    }
    const assessedAt = factoryTimestampSchema.parse(this.dependencies.now());
    if (assessedAt < run.value.completedAt) {
      throw new ConflictError("Factory eval assessment time precedes the completed run.");
    }
    const result = evaluateFactoryEvalRun(run.value);
    const assessment = this.dependencies.documents.evalAssessment({
      schemaVersion: "agentlab.eval-assessment.v1",
      assessmentId: this.dependencies.createId(),
      runId: run.value.runId,
      runDigest: run.digest,
      suiteDigest: run.value.suiteDigest,
      baselineCandidateDigest: run.value.baselineCandidateDigest,
      challengerCandidateDigest: run.value.challengerCandidateDigest,
      assessedAt,
      metrics: result.metrics,
      decision: result.decision,
      maximumEligibleStage: result.maximumEligibleStage,
      reasonCodes: result.reasonCodes,
      actor: {
        kind: "control-plane",
        role: "policy-engine",
        id: "agentlab-eval-policy",
        sessionId: null
      }
    });
    assertFactoryEvalAssessment(run, assessment, this.dependencies.documents);
    return this.dependencies.evaluations.record(run, assessment);
  }

  public async inspect(input: unknown): Promise<FactoryEvalSnapshot> {
    const command = inspectCommandSchema.parse(input);
    const snapshot = await this.dependencies.evaluations.findByAssessmentDigest(
      command.assessmentDigest
    );
    if (snapshot === null) {
      throw new NotFoundError(
        `Factory eval assessment ${command.assessmentDigest} does not exist.`
      );
    }
    return snapshot;
  }
}
