import type {
  FactoryCanaryTaskReservation,
  FactoryConfigurationCandidate
} from "@agentlab/contracts";

import { factoryBudgetFits, factoryRiskRank } from "./factory-authority-limits.js";
import type { FactoryCanarySnapshot } from "./factory-canary-repository.js";
import type { CanonicalFactoryDocument, FactoryDocumentCodec } from "./factory-documents.js";
import type { FactoryEvalSnapshot } from "./factory-evaluation-repository.js";
import type { FactoryPreparationSnapshot } from "./factory-preparation-repository.js";

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
