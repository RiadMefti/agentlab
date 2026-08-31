import {
  factoryCanaryRequestSchema,
  factoryIdentifierSchema,
  factoryTimestampSchema,
  sha256DigestSchema
} from "@agentlab/contracts";
import { z } from "zod";

import { ConflictError, NotFoundError } from "../domain/errors.js";
import type {
  FactoryCanaryRepository,
  FactoryCanarySnapshot
} from "../domain/factory-canary-repository.js";
import type { FactoryDocumentCodec } from "../domain/factory-documents.js";
import { assertFactoryCanaryAuthorization } from "../domain/factory-evaluation-integrity.js";
import type { FactoryEvaluationRepository } from "../domain/factory-evaluation-repository.js";

const authorizeCommandSchema = z
  .object({
    assessmentDigest: sha256DigestSchema,
    request: factoryCanaryRequestSchema,
    confirmation: z.literal("authorize-canary")
  })
  .strict();

export type FactoryCanaryAuthorityCommand = z.infer<typeof authorizeCommandSchema>;

export interface FactoryCanaryAuthorityResult extends FactoryCanarySnapshot {
  readonly schemaVersion: "agentlab.canary-authority-result.v1";
  readonly status: "authorized" | "existing";
}

export interface FactoryCanaryAuthorityServiceDependencies {
  readonly operatorId: string;
  readonly evaluations: Pick<FactoryEvaluationRepository, "findByAssessmentDigest">;
  readonly canaries: FactoryCanaryRepository;
  readonly documents: Pick<FactoryDocumentCodec, "canaryApproval" | "canaryCohort">;
  readonly now: () => string;
  readonly createId: () => string;
}

/** Human-only cohort issuance; it grants no execution, broker, merge, or release capability. */
export class FactoryCanaryAuthorityService {
  readonly #operatorId: string;

  public constructor(private readonly dependencies: FactoryCanaryAuthorityServiceDependencies) {
    this.#operatorId = factoryIdentifierSchema.parse(dependencies.operatorId);
  }

  public async authorize(input: unknown): Promise<FactoryCanaryAuthorityResult> {
    const command = authorizeCommandSchema.parse(input);
    const evaluation = await this.dependencies.evaluations.findByAssessmentDigest(
      command.assessmentDigest
    );
    if (evaluation === null) {
      throw new NotFoundError(
        `Factory eval assessment ${command.assessmentDigest} does not exist.`
      );
    }
    const occurredAt = factoryTimestampSchema.parse(this.dependencies.now());
    const existing = await this.dependencies.canaries.findByAssessmentDigest(
      command.assessmentDigest
    );
    if (existing !== null) {
      if (existing.cohort.expiresAt <= occurredAt) {
        throw new ConflictError("Existing factory canary authority has expired.");
      }
      this.#assertExisting(existing, command);
      return result("existing", existing);
    }
    if (command.request.expiresAt <= occurredAt) {
      throw new ConflictError("Factory canary authority request is already expired.");
    }
    const approval = this.dependencies.documents.canaryApproval({
      schemaVersion: "agentlab.canary-approval.v1",
      approvalId: this.dependencies.createId(),
      assessmentDigest: command.assessmentDigest,
      challengerCandidateDigest: evaluation.run.challengerCandidateDigest,
      stage: command.request.stage,
      repositoryIds: command.request.repositoryIds,
      maximumRiskTier: command.request.maximumRiskTier,
      maximumTasks: command.request.maximumTasks,
      budget: command.request.budget,
      humanSampleReviewDigest: command.request.humanSampleReviewDigest,
      humanSampleSize: command.request.humanSampleSize,
      actor: {
        kind: "human",
        role: "release-controller",
        id: this.#operatorId,
        sessionId: null
      },
      occurredAt,
      expiresAt: command.request.expiresAt,
      reason: command.request.reason
    });
    const cohort = this.dependencies.documents.canaryCohort({
      schemaVersion: "agentlab.canary-cohort.v1",
      cohortId: this.dependencies.createId(),
      assessmentDigest: command.assessmentDigest,
      runDigest: evaluation.runDigest,
      challengerCandidateDigest: evaluation.run.challengerCandidateDigest,
      approvalDigest: approval.digest,
      stage: approval.value.stage,
      repositoryIds: approval.value.repositoryIds,
      maximumRiskTier: approval.value.maximumRiskTier,
      maximumTasks: approval.value.maximumTasks,
      budget: approval.value.budget,
      issuedAt: occurredAt,
      expiresAt: approval.value.expiresAt,
      autoMerge: false,
      release: false
    });
    assertFactoryCanaryAuthorization(evaluation, approval, cohort, this.dependencies.documents);
    return result("authorized", await this.dependencies.canaries.authorize(approval, cohort));
  }

  #assertExisting(existing: FactoryCanarySnapshot, command: FactoryCanaryAuthorityCommand): void {
    const approval = existing.approval;
    const request = command.request;
    if (
      approval.assessmentDigest !== command.assessmentDigest ||
      approval.stage !== request.stage ||
      approval.repositoryIds[0] !== request.repositoryIds[0] ||
      approval.maximumRiskTier !== request.maximumRiskTier ||
      approval.maximumTasks !== request.maximumTasks ||
      !sameBudget(approval.budget, request.budget) ||
      approval.humanSampleReviewDigest !== request.humanSampleReviewDigest ||
      approval.humanSampleSize !== request.humanSampleSize ||
      approval.expiresAt !== request.expiresAt ||
      approval.reason !== request.reason ||
      approval.actor.id !== this.#operatorId
    ) {
      throw new ConflictError(
        "Factory eval assessment already has different immutable canary authority."
      );
    }
  }
}

function result(
  status: FactoryCanaryAuthorityResult["status"],
  snapshot: FactoryCanarySnapshot
): FactoryCanaryAuthorityResult {
  return {
    schemaVersion: "agentlab.canary-authority-result.v1",
    status,
    ...snapshot
  };
}

function sameBudget(
  left: FactoryCanaryAuthorityCommand["request"]["budget"],
  right: FactoryCanaryAuthorityCommand["request"]["budget"]
): boolean {
  return (
    left.wallClockSeconds === right.wallClockSeconds &&
    left.maxAgentTurns === right.maxAgentTurns &&
    left.maxToolCalls === right.maxToolCalls &&
    left.maxInputTokens === right.maxInputTokens &&
    left.maxOutputTokens === right.maxOutputTokens &&
    left.maxCostMicrousd === right.maxCostMicrousd &&
    left.maxProcesses === right.maxProcesses &&
    left.maxOutputBytes === right.maxOutputBytes &&
    left.maxWorkers === right.maxWorkers &&
    left.maxRepairAttempts === right.maxRepairAttempts &&
    left.maxChangedFiles === right.maxChangedFiles &&
    left.maxChangedLines === right.maxChangedLines
  );
}
