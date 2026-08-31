import {
  factoryCanaryRequestSchema,
  factoryIdentifierSchema,
  factoryTimestampSchema,
  sha256DigestSchema,
  type FactoryCanaryApproval,
  type FactoryCanaryCohort,
  type Sha256Digest
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
import type { FactoryEvalAttestationService } from "./factory-eval-attestation-service.js";

const authorizeCommandSchema = z
  .object({
    attestationDigest: sha256DigestSchema,
    request: factoryCanaryRequestSchema,
    confirmation: z.literal("authorize-canary")
  })
  .strict();

export type FactoryCanaryAuthorityCommand = z.infer<typeof authorizeCommandSchema>;

type FactoryAttestedCanaryApproval = Extract<
  FactoryCanaryApproval,
  { readonly schemaVersion: "agentlab.canary-approval.v2" }
>;
type FactoryAttestedCanaryCohort = Extract<
  FactoryCanaryCohort,
  { readonly schemaVersion: "agentlab.canary-cohort.v2" }
>;

export interface FactoryCanaryAuthorityResult {
  readonly schemaVersion: "agentlab.canary-authority-result.v2";
  readonly status: "authorized" | "existing";
  readonly approval: FactoryAttestedCanaryApproval;
  readonly approvalDigest: Sha256Digest;
  readonly cohort: FactoryAttestedCanaryCohort;
  readonly cohortDigest: Sha256Digest;
}

export interface FactoryCanaryAuthorityServiceDependencies {
  readonly operatorId: string;
  readonly evaluations: Pick<FactoryEvaluationRepository, "findByAssessmentDigest">;
  readonly attestations: Pick<FactoryEvalAttestationService, "requireVerifiedAttestation">;
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
    const attestation = await this.dependencies.attestations.requireVerifiedAttestation(
      command.attestationDigest
    );
    const evaluation = await this.dependencies.evaluations.findByAssessmentDigest(
      attestation.attestation.assessmentDigest
    );
    if (evaluation === null) {
      throw new NotFoundError(
        `Factory eval assessment ${attestation.attestation.assessmentDigest} does not exist.`
      );
    }
    const occurredAt = factoryTimestampSchema.parse(this.dependencies.now());
    const predicate = attestation.attestation.signedAttestation.statement.predicate;
    if (occurredAt < predicate.issuedAt || occurredAt >= predicate.expiresAt) {
      throw new ConflictError("Verified factory eval attestation is no longer currently valid.");
    }
    const existing = await this.dependencies.canaries.findByAssessmentDigest(
      evaluation.assessmentDigest
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
      schemaVersion: "agentlab.canary-approval.v2",
      approvalId: this.dependencies.createId(),
      assessmentDigest: evaluation.assessmentDigest,
      attestationDigest: attestation.attestationDigest,
      roleIdentityPolicyDigest: predicate.roleIdentityPolicyDigest,
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
      schemaVersion: "agentlab.canary-cohort.v2",
      cohortId: this.dependencies.createId(),
      assessmentDigest: evaluation.assessmentDigest,
      attestationDigest: attestation.attestationDigest,
      roleIdentityPolicyDigest: predicate.roleIdentityPolicyDigest,
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
    assertFactoryCanaryAuthorization(
      evaluation,
      attestation,
      approval,
      cohort,
      this.dependencies.documents
    );
    return result("authorized", await this.dependencies.canaries.authorize(approval, cohort));
  }

  #assertExisting(existing: FactoryCanarySnapshot, command: FactoryCanaryAuthorityCommand): void {
    const approval = existing.approval;
    const request = command.request;
    if (
      approval.schemaVersion !== "agentlab.canary-approval.v2" ||
      approval.attestationDigest !== command.attestationDigest ||
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
  const approval = snapshot.approval;
  const cohort = snapshot.cohort;
  if (
    approval.schemaVersion !== "agentlab.canary-approval.v2" ||
    cohort.schemaVersion !== "agentlab.canary-cohort.v2"
  ) {
    throw new Error("Factory canary authority cannot return legacy un-attested authority.");
  }
  return {
    schemaVersion: "agentlab.canary-authority-result.v2",
    status,
    approval,
    approvalDigest: snapshot.approvalDigest,
    cohort,
    cohortDigest: snapshot.cohortDigest
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
