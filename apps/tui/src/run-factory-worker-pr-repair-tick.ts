import {
  createConfiguredLocalFactoryWorker,
  loadLocalFactoryWorkerConfig,
  type FactoryCanaryPullRequestRepairTickReport,
  type LocalFactoryWorkerConfig,
  type LocalFactoryWorkerRuntime
} from "@agentlab/runtime/factory-worker";

import { isNormalizedAbsolutePath, isSha256Digest } from "./factory-cli-input.js";

export interface FactoryWorkerPullRequestRepairTickRunnerDependencies {
  readonly loadConfig: (path: string) => Promise<LocalFactoryWorkerConfig>;
  readonly createRuntime: (config: LocalFactoryWorkerConfig) => LocalFactoryWorkerRuntime;
  readonly write: (message: string) => void;
}

const defaultDependencies: FactoryWorkerPullRequestRepairTickRunnerDependencies = {
  loadConfig: loadLocalFactoryWorkerConfig,
  createRuntime: createConfiguredLocalFactoryWorker,
  write: (message) => process.stdout.write(message)
};

/** Recovers interrupted repair work, then consumes bounded exact canary repair authority. */
export async function runFactoryWorkerPullRequestRepairTick(
  configPath: string,
  expectedSchedulePolicyDigest: string,
  expectedRoleIdentityPolicyDigest: string,
  expectedFactoryPolicyBundleDigest: string,
  dependencies: FactoryWorkerPullRequestRepairTickRunnerDependencies = defaultDependencies
): Promise<number> {
  assertInput(
    configPath,
    expectedSchedulePolicyDigest,
    expectedRoleIdentityPolicyDigest,
    expectedFactoryPolicyBundleDigest
  );
  const config = await dependencies.loadConfig(configPath);
  if (
    config.schemaVersion !== "agentlab.local-factory-worker.v3" ||
    config.schedulePolicy === undefined ||
    config.roleIdentityPolicy === undefined
  ) {
    throw new Error(
      "Factory PR repair tick requires worker config v3 with schedule and role policies."
    );
  }
  const runtime = dependencies.createRuntime(config);
  let report: FactoryCanaryPullRequestRepairTickReport;
  try {
    report = await runtime.commands.runCanaryPullRequestRepairTick({
      expectedSchedulePolicyDigest,
      expectedRoleIdentityPolicyDigest,
      expectedFactoryPolicyBundleDigest
    });
    assertReportIdentity(
      report,
      expectedSchedulePolicyDigest,
      expectedRoleIdentityPolicyDigest,
      expectedFactoryPolicyBundleDigest
    );
  } catch (error: unknown) {
    return closeAfterFailure(runtime, error);
  }
  await runtime.close();
  dependencies.write(`${JSON.stringify(report)}\n`);
  return report.status === "idle" || report.status === "completed" ? 0 : 2;
}

function assertInput(
  configPath: string,
  expectedSchedulePolicyDigest: string,
  expectedRoleIdentityPolicyDigest: string,
  expectedFactoryPolicyBundleDigest: string
): void {
  if (!isNormalizedAbsolutePath(configPath)) {
    throw new Error("Factory PR repair tick requires a normalized absolute config path.");
  }
  for (const [label, digest] of [
    ["schedule policy", expectedSchedulePolicyDigest],
    ["role policy", expectedRoleIdentityPolicyDigest],
    ["factory policy", expectedFactoryPolicyBundleDigest]
  ] as const) {
    if (!isSha256Digest(digest)) {
      throw new Error(`Factory PR repair tick ${label} digest is invalid.`);
    }
  }
}

function assertReportIdentity(
  report: FactoryCanaryPullRequestRepairTickReport,
  schedulePolicyDigest: string,
  roleIdentityPolicyDigest: string,
  factoryPolicyBundleDigest: string
): void {
  if (
    report.schedulePolicyDigest !== schedulePolicyDigest ||
    report.roleIdentityPolicyDigest !== roleIdentityPolicyDigest ||
    report.factoryPolicyBundleDigest !== factoryPolicyBundleDigest
  ) {
    throw new Error("Factory PR repair tick returned different reviewed policy coordinates.");
  }
}

async function closeAfterFailure(
  runtime: LocalFactoryWorkerRuntime,
  primaryError: unknown
): Promise<never> {
  try {
    await runtime.close();
  } catch (cleanupError: unknown) {
    throw new AggregateError(
      [primaryError, cleanupError],
      "Factory PR repair tick and cleanup both failed.",
      { cause: primaryError }
    );
  }
  throw primaryError;
}
