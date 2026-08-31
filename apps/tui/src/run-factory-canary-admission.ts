import {
  createConfiguredLocalFactoryCanaryAdmission,
  loadLocalFactoryCanaryAdmissionConfig,
  type FactoryCanaryAdmissionResult,
  type LocalFactoryCanaryAdmissionConfig,
  type LocalFactoryCanaryAdmissionRuntime
} from "@agentlab/runtime/factory-canary-admission";

import { isFactoryTaskId, isNormalizedAbsolutePath } from "./factory-cli-input.js";

export interface FactoryCanaryAdmissionRunnerDependencies {
  readonly loadConfig: (path: string) => Promise<LocalFactoryCanaryAdmissionConfig>;
  readonly createRuntime: (
    config: LocalFactoryCanaryAdmissionConfig
  ) => LocalFactoryCanaryAdmissionRuntime;
  readonly write: (message: string) => void;
}

const defaultDependencies: FactoryCanaryAdmissionRunnerDependencies = {
  loadConfig: loadLocalFactoryCanaryAdmissionConfig,
  createRuntime: createConfiguredLocalFactoryCanaryAdmission,
  write: (message) => process.stdout.write(message)
};

/** Reserves one scheduled task from pre-reviewed cohort authority; it executes no task. */
export async function runFactoryCanaryReserve(
  configPath: string,
  taskId: string,
  dependencies: FactoryCanaryAdmissionRunnerDependencies = defaultDependencies
): Promise<number> {
  if (!isNormalizedAbsolutePath(configPath)) {
    throw new Error("Factory canary admission requires a normalized absolute config path.");
  }
  if (!isFactoryTaskId(taskId)) {
    throw new Error("Factory canary admission task ID is invalid.");
  }
  const config = await dependencies.loadConfig(configPath);
  const runtime = dependencies.createRuntime(config);
  const result = await runtime.commands
    .reserve({
      taskId,
      expectedCohortDigest: config.expectedCohortDigest,
      expectedCandidateDigest: config.expectedCandidateDigest,
      expectedSchedulePolicyDigest: config.expectedSchedulePolicyDigest,
      expectedPolicyBundleDigest: config.expectedPolicyBundleDigest,
      expectedRoleIdentityPolicyDigest: config.expectedRoleIdentityPolicyDigest
    })
    .catch((error: unknown) => closeAfterFailure(runtime, error));
  await runtime.close();
  dependencies.write(`${serializeReservation(result)}\n`);
  return 0;
}

function serializeReservation(result: FactoryCanaryAdmissionResult): string {
  const reservation = result.reservation;
  return JSON.stringify({
    schemaVersion: "agentlab.canary-admission-command-result.v1",
    status: result.status,
    reservationId: reservation.reservationId,
    reservationDigest: result.reservationDigest,
    cohortDigest: reservation.cohortDigest,
    attestationDigest: reservation.attestationDigest,
    roleIdentityPolicyDigest: reservation.roleIdentityPolicyDigest,
    challengerCandidateDigest: reservation.challengerCandidateDigest,
    schedulePolicyDigest: reservation.schedulePolicyDigest,
    policyBundleDigest: reservation.policyBundleDigest,
    stage: reservation.stage,
    repositoryId: reservation.repository.id,
    baseRevision: reservation.repository.baseRevision,
    taskId: reservation.taskId,
    requestDigest: reservation.requestDigest,
    preparationAuthorityDigest: reservation.preparationAuthorityDigest,
    maximumRiskTier: reservation.maximumRiskTier,
    budget: reservation.budget,
    reservedAt: reservation.reservedAt,
    expiresAt: reservation.expiresAt,
    autoMerge: reservation.autoMerge,
    release: reservation.release
  });
}

async function closeAfterFailure(
  runtime: LocalFactoryCanaryAdmissionRuntime,
  primaryError: unknown
): Promise<never> {
  try {
    await runtime.close();
  } catch (cleanupError: unknown) {
    throw new AggregateError(
      [primaryError, cleanupError],
      "Factory canary admission and cleanup both failed.",
      { cause: primaryError }
    );
  }
  throw primaryError;
}
