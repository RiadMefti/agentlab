import type {
  FactoryBudget,
  FactoryCanaryTaskReservation,
  FactoryConfigurationCandidate,
  Sha256Digest
} from "@agentlab/contracts";

import { factoryBudgetFits, factoryRiskRank } from "./factory-authority-limits.js";
import type { FactoryCanarySnapshot } from "./factory-canary-repository.js";
import type { FactoryCanaryReservationSnapshot } from "./factory-canary-reservation-repository.js";
import type { CanonicalFactoryDocument, FactoryDocumentCodec } from "./factory-documents.js";
import type { FactoryEvalSnapshot } from "./factory-evaluation-repository.js";
import type { FactoryPreparationSnapshot } from "./factory-preparation-repository.js";
import { factoryTimestampAddSeconds } from "./factory-timestamp.js";

export interface FactoryScheduledTaskReservationPins {
  readonly schedulePolicyDigest: Sha256Digest;
  readonly policyBundleDigest: Sha256Digest;
  readonly roleIdentityPolicyDigest: Sha256Digest;
}

/** Independently checks the immutable task/configuration projection needed by a worker. */
export function assertFactoryScheduledTaskReservation(
  snapshot: FactoryCanaryReservationSnapshot,
  preparation: FactoryPreparationSnapshot,
  pins: FactoryScheduledTaskReservationPins,
  documents: Pick<FactoryDocumentCodec, "canaryTaskReservation">
): CanonicalFactoryDocument<FactoryCanaryTaskReservation> {
  const reservation = documents.canaryTaskReservation(snapshot.reservation);
  const value = reservation.value;
  const request = preparation.request;
  const authority = preparation.authority;
  if (
    reservation.digest !== snapshot.reservationDigest ||
    value.taskId !== request.taskId ||
    value.requestDigest !== preparation.requestDigest ||
    value.preparationAuthorityDigest !== preparation.authorityDigest ||
    value.repository.id !== request.repository.id ||
    value.repository.baseRevision !== request.repository.baseRevision ||
    value.policyBundleDigest !== pins.policyBundleDigest ||
    value.policyBundleDigest !== authority.policyBundleDigest ||
    value.schedulePolicyDigest !== pins.schedulePolicyDigest ||
    value.roleIdentityPolicyDigest !== pins.roleIdentityPolicyDigest ||
    value.maximumRiskTier !== authority.maximumRiskTier ||
    request.trigger !== "scheduled" ||
    !sameBudget(value.budget, authority.budgetCeiling) ||
    value.reservedAt < authority.issuedAt ||
    value.expiresAt > authority.expiresAt
  ) {
    throw new Error("Factory scheduled task does not match its canary reservation authority.");
  }
  return reservation;
}

/** A fresh execution must fit its complete wall-clock ceiling inside remaining authority. */
export function isFactoryCanaryReservationExecutableAt(
  reservation: FactoryCanaryTaskReservation,
  now: string
): boolean {
  return (
    reservation.stage !== "read-only-shadow" &&
    now >= reservation.reservedAt &&
    now < reservation.expiresAt &&
    factoryTimestampAddSeconds(now, reservation.budget.wallClockSeconds) <= reservation.expiresAt
  );
}

export function assertFactoryCanaryTaskReservation(
  evaluation: FactoryEvalSnapshot,
  canary: FactoryCanarySnapshot,
  preparation: FactoryPreparationSnapshot,
  reservation: CanonicalFactoryDocument<FactoryCanaryTaskReservation>,
  documents: Pick<FactoryDocumentCodec, "configurationCandidate" | "canaryTaskReservation">
): void {
  const cohort = canary.cohort;
  if (cohort.schemaVersion !== "agentlab.canary-cohort.v2") {
    throw new Error("Legacy canary cohorts cannot reserve autonomous work.");
  }
  const candidate = documents.configurationCandidate(evaluation.run.challengerCandidate);
  const request = preparation.request;
  const authority = preparation.authority;
  if (
    evaluation.runDigest !== cohort.runDigest ||
    evaluation.assessmentDigest !== cohort.assessmentDigest ||
    candidate.digest !== cohort.challengerCandidateDigest ||
    evaluation.run.challengerCandidateDigest !== candidate.digest
  ) {
    throw new Error("Canary reservation candidate does not match its evaluated cohort.");
  }
  const schedulePolicyDigest = candidate.value.schedulePolicyDigest;
  if (schedulePolicyDigest === null) {
    throw new Error("Evaluated factory candidate has no autonomous schedule policy.");
  }
  assertCandidateAuthorizesPreparation(candidate.value, preparation);
  if (
    request.trigger !== "scheduled" ||
    authority.taskId !== request.taskId ||
    authority.requestDigest !== preparation.requestDigest ||
    authority.repository.id !== request.repository.id ||
    authority.repository.baseRevision !== request.repository.baseRevision ||
    authority.maximumRiskTier === "R2" ||
    authority.maximumRiskTier === "R3" ||
    authority.maximumRiskTier === "R4" ||
    factoryRiskRank(authority.maximumRiskTier) > factoryRiskRank(cohort.maximumRiskTier) ||
    !factoryBudgetFits(authority.budgetCeiling, cohort.budget)
  ) {
    throw new Error("Scheduled preparation exceeds its canary cohort authority.");
  }
  const expiresAt = authority.expiresAt < cohort.expiresAt ? authority.expiresAt : cohort.expiresAt;
  const expected = documents.canaryTaskReservation({
    schemaVersion: "agentlab.canary-task-reservation.v1",
    reservationId: reservation.value.reservationId,
    cohortId: cohort.cohortId,
    cohortDigest: canary.cohortDigest,
    approvalDigest: canary.approvalDigest,
    assessmentDigest: cohort.assessmentDigest,
    attestationDigest: cohort.attestationDigest,
    roleIdentityPolicyDigest: cohort.roleIdentityPolicyDigest,
    challengerCandidateDigest: cohort.challengerCandidateDigest,
    schedulePolicyDigest,
    policyBundleDigest: candidate.value.policyBundleDigest,
    stage: cohort.stage,
    repository: request.repository,
    taskId: request.taskId,
    requestDigest: preparation.requestDigest,
    preparationAuthorityDigest: preparation.authorityDigest,
    maximumRiskTier: authority.maximumRiskTier,
    budget: authority.budgetCeiling,
    reservedAt: reservation.value.reservedAt,
    expiresAt,
    actor: {
      kind: "control-plane",
      role: "policy-engine",
      id: "agentlab-canary-admission",
      sessionId: null
    },
    autoMerge: false,
    release: false
  });
  if (
    reservation.value.reservedAt < cohort.issuedAt ||
    reservation.value.reservedAt < authority.issuedAt ||
    reservation.value.reservedAt < candidate.value.createdAt ||
    factoryTimestampAddSeconds(
      reservation.value.reservedAt,
      reservation.value.budget.wallClockSeconds
    ) > reservation.value.expiresAt ||
    expected.digest !== reservation.digest ||
    expected.json !== reservation.json
  ) {
    throw new Error("Canary task reservation does not exactly project its immutable authority.");
  }
}

function assertCandidateAuthorizesPreparation(
  candidate: FactoryConfigurationCandidate,
  preparation: FactoryPreparationSnapshot
): void {
  const request = preparation.request;
  const authority = preparation.authority;
  if (
    candidate.repositoryId !== request.repository.id ||
    candidate.baseRevision !== request.repository.baseRevision ||
    candidate.policyBundleDigest !== authority.policyBundleDigest ||
    !sameSet(
      candidate.skillPackageDigests,
      authority.skills.map(({ manifest }) => manifest.packageDigest)
    )
  ) {
    throw new Error("Evaluated factory candidate does not match the scheduled preparation.");
  }
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const values = new Set(left);
  return right.every((value) => values.has(value));
}

function sameBudget(left: FactoryBudget, right: FactoryBudget): boolean {
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
