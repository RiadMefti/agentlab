import {
  factoryTimestampSchema,
  sha256DigestSchema,
  type FactoryCanaryTaskReservation,
  type Sha256Digest
} from "@agentlab/contracts";
import { z } from "zod";

import { ConflictError, NotFoundError } from "../domain/errors.js";
import { assertFactoryCanaryTaskReservation } from "../domain/factory-canary-reservation-integrity.js";
import type {
  FactoryCanaryReservationRepository,
  FactoryCanaryReservationWriteResult
} from "../domain/factory-canary-reservation-repository.js";
import type { FactoryCanaryRepository } from "../domain/factory-canary-repository.js";
import type { FactoryDocumentCodec } from "../domain/factory-documents.js";
import { assertFactoryCanarySnapshot } from "../domain/factory-evaluation-integrity.js";
import type { FactoryEvaluationRepository } from "../domain/factory-evaluation-repository.js";
import type { FactoryPreparationRepository } from "../domain/factory-preparation-repository.js";
import type { FactoryEvalAttestationService } from "./factory-eval-attestation-service.js";

const reserveCommandSchema = z
  .object({
    taskId: z.uuid(),
    expectedCohortDigest: sha256DigestSchema,
    expectedCandidateDigest: sha256DigestSchema,
    expectedSchedulePolicyDigest: sha256DigestSchema,
    expectedPolicyBundleDigest: sha256DigestSchema,
    expectedRoleIdentityPolicyDigest: sha256DigestSchema
  })
  .strict();

export type FactoryCanaryAdmissionCommand = z.infer<typeof reserveCommandSchema>;
type FactoryCanaryAdmissionPins = Omit<FactoryCanaryAdmissionCommand, "taskId">;

export interface FactoryCanaryAdmissionResult extends FactoryCanaryReservationWriteResult {
  readonly schemaVersion: "agentlab.canary-admission-result.v1";
}

export interface FactoryCanaryAdmissionServiceDependencies {
  readonly expectedCohortDigest: Sha256Digest;
  readonly expectedCandidateDigest: Sha256Digest;
  readonly expectedSchedulePolicyDigest: Sha256Digest;
  readonly expectedPolicyBundleDigest: Sha256Digest;
  readonly expectedRoleIdentityPolicyDigest: Sha256Digest;
  readonly canaries: Pick<FactoryCanaryRepository, "findByCohortDigest">;
  readonly evaluations: Pick<FactoryEvaluationRepository, "findByAssessmentDigest">;
  readonly attestations: Pick<FactoryEvalAttestationService, "requireVerifiedAttestation">;
  readonly preparations: Pick<FactoryPreparationRepository, "findById">;
  readonly reservations: Pick<FactoryCanaryReservationRepository, "reserve" | "findByTaskId">;
  readonly documents: Pick<
    FactoryDocumentCodec,
    "canaryApproval" | "canaryCohort" | "configurationCandidate" | "canaryTaskReservation"
  >;
  readonly now: () => string;
  readonly createId: () => string;
}

/** Re-verifies one attested cohort and reserves one exact scheduled task; it executes nothing. */
export class FactoryCanaryAdmissionService {
  readonly #pins: FactoryCanaryAdmissionPins;

  public constructor(private readonly dependencies: FactoryCanaryAdmissionServiceDependencies) {
    this.#pins = reserveCommandSchema.omit({ taskId: true }).parse({
      expectedCohortDigest: dependencies.expectedCohortDigest,
      expectedCandidateDigest: dependencies.expectedCandidateDigest,
      expectedSchedulePolicyDigest: dependencies.expectedSchedulePolicyDigest,
      expectedPolicyBundleDigest: dependencies.expectedPolicyBundleDigest,
      expectedRoleIdentityPolicyDigest: dependencies.expectedRoleIdentityPolicyDigest
    });
  }

  public async reserve(input: unknown): Promise<FactoryCanaryAdmissionResult> {
    const command = reserveCommandSchema.parse(input);
    this.#assertReviewedPins(command);
    const canary = await this.dependencies.canaries.findByCohortDigest(
      command.expectedCohortDigest
    );
    if (canary === null) {
      throw new NotFoundError(
        `Factory canary cohort ${command.expectedCohortDigest} does not exist.`
      );
    }
    if (
      canary.cohortDigest !== command.expectedCohortDigest ||
      canary.cohort.schemaVersion !== "agentlab.canary-cohort.v2" ||
      canary.approval.schemaVersion !== "agentlab.canary-approval.v2"
    ) {
      throw new ConflictError("Only exact attested v2 canary authority may reserve work.");
    }
    const [evaluation, preparation, attestation] = await Promise.all([
      this.dependencies.evaluations.findByAssessmentDigest(canary.cohort.assessmentDigest),
      this.dependencies.preparations.findById(command.taskId),
      this.dependencies.attestations.requireVerifiedAttestation(canary.cohort.attestationDigest)
    ]);
    if (evaluation === null) {
      throw new NotFoundError("Factory canary cohort is missing its exact evaluated candidate.");
    }
    if (preparation === null) {
      throw new NotFoundError(`Factory preparation ${command.taskId} does not exist.`);
    }
    assertFactoryCanarySnapshot(evaluation, attestation, canary, this.dependencies.documents);
    const candidate = this.dependencies.documents.configurationCandidate(
      evaluation.run.challengerCandidate
    );
    const reservedAt = factoryTimestampSchema.parse(this.dependencies.now());
    const predicate = attestation.attestation.signedAttestation.statement.predicate;
    if (
      attestation.attestationDigest !== canary.cohort.attestationDigest ||
      candidate.digest !== command.expectedCandidateDigest ||
      candidate.value.schedulePolicyDigest !== command.expectedSchedulePolicyDigest ||
      candidate.value.policyBundleDigest !== command.expectedPolicyBundleDigest ||
      canary.cohort.roleIdentityPolicyDigest !== command.expectedRoleIdentityPolicyDigest ||
      predicate.roleIdentityPolicyDigest !== command.expectedRoleIdentityPolicyDigest
    ) {
      throw new ConflictError("Factory canary admission configuration changed after review.");
    }
    if (
      reservedAt < predicate.issuedAt ||
      reservedAt >= predicate.expiresAt ||
      reservedAt < canary.cohort.issuedAt ||
      reservedAt >= canary.cohort.expiresAt ||
      reservedAt < preparation.authority.issuedAt ||
      reservedAt >= preparation.authority.expiresAt
    ) {
      throw new ConflictError("Factory canary or task authority is not currently valid.");
    }
    const maximumRiskTier = preparation.authority.maximumRiskTier;
    if (maximumRiskTier !== "R0" && maximumRiskTier !== "R1") {
      throw new ConflictError("Factory canary admission permits only R0 or R1 task authority.");
    }
    const existing = await this.dependencies.reservations.findByTaskId(command.taskId);
    if (existing !== null) {
      const document = this.dependencies.documents.canaryTaskReservation(existing.reservation);
      if (document.digest !== existing.reservationDigest) {
        throw new ConflictError(
          "Existing factory canary reservation failed canonical verification."
        );
      }
      assertFactoryCanaryTaskReservation(
        evaluation,
        canary,
        preparation,
        document,
        this.dependencies.documents
      );
      return {
        schemaVersion: "agentlab.canary-admission-result.v1",
        status: "existing",
        ...existing
      };
    }
    const reservation = this.dependencies.documents.canaryTaskReservation({
      schemaVersion: "agentlab.canary-task-reservation.v1",
      reservationId: this.dependencies.createId(),
      cohortId: canary.cohort.cohortId,
      cohortDigest: canary.cohortDigest,
      approvalDigest: canary.approvalDigest,
      assessmentDigest: canary.cohort.assessmentDigest,
      attestationDigest: canary.cohort.attestationDigest,
      roleIdentityPolicyDigest: canary.cohort.roleIdentityPolicyDigest,
      challengerCandidateDigest: candidate.digest,
      schedulePolicyDigest: command.expectedSchedulePolicyDigest,
      policyBundleDigest: command.expectedPolicyBundleDigest,
      stage: canary.cohort.stage,
      repository: preparation.request.repository,
      taskId: preparation.request.taskId,
      requestDigest: preparation.requestDigest,
      preparationAuthorityDigest: preparation.authorityDigest,
      maximumRiskTier,
      budget: preparation.authority.budgetCeiling,
      reservedAt,
      expiresAt: earliest(canary.cohort.expiresAt, preparation.authority.expiresAt),
      actor: admissionActor(),
      autoMerge: false,
      release: false
    } satisfies FactoryCanaryTaskReservation);
    assertFactoryCanaryTaskReservation(
      evaluation,
      canary,
      preparation,
      reservation,
      this.dependencies.documents
    );
    return {
      schemaVersion: "agentlab.canary-admission-result.v1",
      ...(await this.dependencies.reservations.reserve(reservation))
    };
  }

  #assertReviewedPins(command: FactoryCanaryAdmissionCommand): void {
    for (const key of Object.keys(this.#pins) as (keyof FactoryCanaryAdmissionPins)[]) {
      if (command[key] !== this.#pins[key]) {
        throw new ConflictError("Factory canary admission pin changed after operator review.");
      }
    }
  }
}

function earliest(left: string, right: string): string {
  return left < right ? left : right;
}

function admissionActor() {
  return {
    kind: "control-plane" as const,
    role: "policy-engine" as const,
    id: "agentlab-canary-admission",
    sessionId: null
  };
}
