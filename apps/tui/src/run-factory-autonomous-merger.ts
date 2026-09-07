import type { Sha256Digest } from "@agentlab/contracts";
import {
  createConfiguredLocalFactoryAutonomousMerger,
  loadLocalFactoryAutonomousMergerConfig,
  type FactoryAutonomousMergePreflight,
  type FactoryAutonomousMergeTickReport,
  type LocalFactoryAutonomousMergerConfig,
  type LocalFactoryAutonomousMergerRuntime
} from "@agentlab/runtime/factory-autonomous-merger";

export interface FactoryAutonomousMergerRunnerDependencies {
  readonly loadConfig: (path: string) => Promise<LocalFactoryAutonomousMergerConfig>;
  readonly createRuntime: (
    config: LocalFactoryAutonomousMergerConfig
  ) => LocalFactoryAutonomousMergerRuntime;
  readonly write: (message: string) => void;
}

const defaultDependencies: FactoryAutonomousMergerRunnerDependencies = {
  loadConfig: loadLocalFactoryAutonomousMergerConfig,
  createRuntime: createConfiguredLocalFactoryAutonomousMerger,
  write: (message) => process.stdout.write(message)
};

/** Reports merge-queue broker readiness without mutating GitHub. */
export async function runFactoryAutonomousMergerPreflight(
  configPath: string,
  dependencies: FactoryAutonomousMergerRunnerDependencies = defaultDependencies
): Promise<number> {
  const runtime = dependencies.createRuntime(await dependencies.loadConfig(configPath));
  const preflight = await runtime.commands
    .preflight()
    .catch((error: unknown) => closeAfterFailure(runtime, error));
  await runtime.close();
  dependencies.write(`${JSON.stringify(preflight)}\n`);
  return preflight.status === "ready" ? 0 : 2;
}

/** Reconciles and advances one bounded recovery-first page through GitHub's merge queue. */
export async function runFactoryAutonomousMergerTick(
  input: {
    readonly configPath: string;
    readonly expectedMergePolicyDigest: Sha256Digest;
    readonly expectedFactoryPolicyBundleDigest: Sha256Digest;
    readonly expectedSchedulePolicyDigest: Sha256Digest;
    readonly expectedDailyQuotaPolicyDigest: Sha256Digest;
    readonly expectedRoleIdentityPolicyDigest: Sha256Digest;
  },
  dependencies: FactoryAutonomousMergerRunnerDependencies = defaultDependencies
): Promise<number> {
  const runtime = dependencies.createRuntime(await dependencies.loadConfig(input.configPath));
  let preflight: FactoryAutonomousMergePreflight;
  let report: FactoryAutonomousMergeTickReport;
  try {
    preflight = await runtime.commands.preflight();
    // Reconcile queued effects even when switches block new mutations.
    report = await runtime.commands.tick({
      expectedMergePolicyDigest: input.expectedMergePolicyDigest,
      expectedFactoryPolicyBundleDigest: input.expectedFactoryPolicyBundleDigest,
      expectedSchedulePolicyDigest: input.expectedSchedulePolicyDigest,
      expectedDailyQuotaPolicyDigest: input.expectedDailyQuotaPolicyDigest,
      expectedRoleIdentityPolicyDigest: input.expectedRoleIdentityPolicyDigest
    });
  } catch (error: unknown) {
    return closeAfterFailure(runtime, error);
  }
  await runtime.close();
  dependencies.write(
    `${JSON.stringify({
      schemaVersion: "agentlab.autonomous-merger-command-result.v1",
      status: report.status,
      preflight,
      report
    })}\n`
  );
  return ["completed", "idle", "pending"].includes(report.status) ? 0 : 2;
}

async function closeAfterFailure(
  runtime: LocalFactoryAutonomousMergerRuntime,
  primaryError: unknown
): Promise<never> {
  try {
    await runtime.close();
  } catch (cleanupError: unknown) {
    throw new AggregateError(
      [primaryError, cleanupError],
      "Autonomous merger and cleanup both failed.",
      { cause: primaryError }
    );
  }
  throw primaryError;
}
