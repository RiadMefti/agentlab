import type { Sha256Digest } from "@agentlab/contracts";
import {
  createConfiguredLocalFactoryAutonomousMergeAdmission,
  loadLocalFactoryAutonomousMergeAdmissionConfig,
  type FactoryAutonomousMergeAdmissionOutcome,
  type FactoryAutonomousMergeAdmissionPreflight,
  type FactoryAutonomousMergeAdmissionTickReport,
  type LocalFactoryAutonomousMergeAdmissionConfig,
  type LocalFactoryAutonomousMergeAdmissionRuntime
} from "@agentlab/runtime/factory-autonomous-merge-admission";

export interface FactoryAutonomousMergeAdmissionRunnerDependencies {
  readonly loadConfig: (path: string) => Promise<LocalFactoryAutonomousMergeAdmissionConfig>;
  readonly createRuntime: (
    config: LocalFactoryAutonomousMergeAdmissionConfig
  ) => LocalFactoryAutonomousMergeAdmissionRuntime;
  readonly write: (message: string) => void;
}

const defaultDependencies: FactoryAutonomousMergeAdmissionRunnerDependencies = {
  loadConfig: loadLocalFactoryAutonomousMergeAdmissionConfig,
  createRuntime: createConfiguredLocalFactoryAutonomousMergeAdmission,
  write: (message) => process.stdout.write(message)
};

/** Reports credentialless autonomous-merge admission readiness without creating authority. */
export async function runFactoryAutonomousMergeAdmissionPreflight(
  configPath: string,
  dependencies: FactoryAutonomousMergeAdmissionRunnerDependencies = defaultDependencies
): Promise<number> {
  const runtime = dependencies.createRuntime(await dependencies.loadConfig(configPath));
  const preflight = await runtime.commands
    .preflight()
    .catch((error: unknown) => closeAfterFailure(runtime, error));
  await runtime.close();
  dependencies.write(`${serializePreflight(preflight)}\n`);
  return preflight.status === "ready" ? 0 : 2;
}

/** Creates one short-lived exact-head merge authorization; it has no remote-write capability. */
export async function runFactoryAutonomousMergeAdmission(
  input: {
    readonly configPath: string;
    readonly taskId: string;
    readonly observationDigest: Sha256Digest;
    readonly canaryReservationDigest: Sha256Digest;
    readonly expectedMergePolicyDigest: Sha256Digest;
    readonly expectedFactoryPolicyBundleDigest: Sha256Digest;
    readonly expectedSchedulePolicyDigest: Sha256Digest;
    readonly expectedDailyQuotaPolicyDigest: Sha256Digest;
    readonly expectedRoleIdentityPolicyDigest: Sha256Digest;
  },
  dependencies: FactoryAutonomousMergeAdmissionRunnerDependencies = defaultDependencies
): Promise<number> {
  const runtime = dependencies.createRuntime(await dependencies.loadConfig(input.configPath));
  const outcome = await runtime.commands
    .admit({
      taskId: input.taskId,
      observationDigest: input.observationDigest,
      canaryReservationDigest: input.canaryReservationDigest,
      expectedMergePolicyDigest: input.expectedMergePolicyDigest,
      expectedFactoryPolicyBundleDigest: input.expectedFactoryPolicyBundleDigest,
      expectedSchedulePolicyDigest: input.expectedSchedulePolicyDigest,
      expectedDailyQuotaPolicyDigest: input.expectedDailyQuotaPolicyDigest,
      expectedRoleIdentityPolicyDigest: input.expectedRoleIdentityPolicyDigest
    })
    .catch((error: unknown) => closeAfterFailure(runtime, error));
  await runtime.close();
  dependencies.write(`${serializeOutcome(outcome)}\n`);
  return outcome.status === "authorized" ? 0 : 2;
}

/** Projects one bounded page of clear scheduled PRs into short-lived merge authorizations. */
export async function runFactoryAutonomousMergeAdmissionTick(
  input: {
    readonly configPath: string;
    readonly expectedMergePolicyDigest: Sha256Digest;
    readonly expectedFactoryPolicyBundleDigest: Sha256Digest;
    readonly expectedSchedulePolicyDigest: Sha256Digest;
    readonly expectedDailyQuotaPolicyDigest: Sha256Digest;
    readonly expectedRoleIdentityPolicyDigest: Sha256Digest;
  },
  dependencies: FactoryAutonomousMergeAdmissionRunnerDependencies = defaultDependencies
): Promise<number> {
  const runtime = dependencies.createRuntime(await dependencies.loadConfig(input.configPath));
  let preflight: FactoryAutonomousMergeAdmissionPreflight;
  let report: FactoryAutonomousMergeAdmissionTickReport | null = null;
  try {
    preflight = await runtime.commands.preflight();
    if (preflight.status === "ready") {
      report = await runtime.commands.tick({
        expectedMergePolicyDigest: input.expectedMergePolicyDigest,
        expectedFactoryPolicyBundleDigest: input.expectedFactoryPolicyBundleDigest,
        expectedSchedulePolicyDigest: input.expectedSchedulePolicyDigest,
        expectedDailyQuotaPolicyDigest: input.expectedDailyQuotaPolicyDigest,
        expectedRoleIdentityPolicyDigest: input.expectedRoleIdentityPolicyDigest
      });
    }
  } catch (error: unknown) {
    return closeAfterFailure(runtime, error);
  }
  await runtime.close();
  dependencies.write(
    `${JSON.stringify({
      schemaVersion: "agentlab.autonomous-merge-admission-tick-command-result.v1",
      status: report?.status ?? "blocked",
      preflight,
      report
    })}\n`
  );
  return report !== null && ["completed", "idle"].includes(report.status) ? 0 : 2;
}

function serializePreflight(preflight: FactoryAutonomousMergeAdmissionPreflight): string {
  return JSON.stringify(preflight);
}

function serializeOutcome(outcome: FactoryAutonomousMergeAdmissionOutcome): string {
  return JSON.stringify({
    schemaVersion: "agentlab.autonomous-merge-admission-command-result.v1",
    ...outcome
  });
}

async function closeAfterFailure(
  runtime: LocalFactoryAutonomousMergeAdmissionRuntime,
  primaryError: unknown
): Promise<never> {
  try {
    await runtime.close();
  } catch (cleanupError: unknown) {
    throw new AggregateError(
      [primaryError, cleanupError],
      "Autonomous merge admission and cleanup both failed.",
      { cause: primaryError }
    );
  }
  throw primaryError;
}
