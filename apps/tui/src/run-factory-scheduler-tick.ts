import {
  createConfiguredLocalFactoryWorker,
  loadLocalFactoryWorkerConfig,
  type FactorySchedulerTickReport,
  type LocalFactoryWorkerConfig,
  type LocalFactoryWorkerRuntime
} from "@agentlab/runtime/factory-worker";

import { isNormalizedAbsolutePath, isSha256Digest } from "./factory-cli-input.js";

export interface FactorySchedulerTickRunnerDependencies {
  readonly loadConfig: (path: string) => Promise<LocalFactoryWorkerConfig>;
  readonly createRuntime: (config: LocalFactoryWorkerConfig) => LocalFactoryWorkerRuntime;
  readonly write: (message: string) => void;
}

const defaultDependencies: FactorySchedulerTickRunnerDependencies = {
  loadConfig: loadLocalFactoryWorkerConfig,
  createRuntime: createConfiguredLocalFactoryWorker,
  write: (message) => process.stdout.write(message)
};

/** Runs one idempotent policy-pinned daily slot and closes all worker resources before output. */
export async function runFactorySchedulerTick(
  configPath: string,
  expectedSchedulePolicyDigest: string,
  expectedFactoryPolicyBundleDigest: string,
  dependencies: FactorySchedulerTickRunnerDependencies = defaultDependencies
): Promise<number> {
  if (!isNormalizedAbsolutePath(configPath)) {
    throw new Error("Factory scheduler requires a normalized absolute config path.");
  }
  if (!isSha256Digest(expectedSchedulePolicyDigest)) {
    throw new Error("Factory scheduler expected schedule policy digest is invalid.");
  }
  if (!isSha256Digest(expectedFactoryPolicyBundleDigest)) {
    throw new Error("Factory scheduler expected factory policy digest is invalid.");
  }
  const config = await dependencies.loadConfig(configPath);
  if (
    config.schemaVersion !== "agentlab.local-factory-worker.v2" ||
    config.schedulePolicy === undefined
  ) {
    throw new Error("Factory scheduler requires a v2 worker config with a schedule policy.");
  }
  const runtime = dependencies.createRuntime(config);
  let report: FactorySchedulerTickReport;
  try {
    report = await runtime.commands.runScheduledTick({
      expectedSchedulePolicyDigest,
      expectedFactoryPolicyBundleDigest
    });
  } catch (error: unknown) {
    return closeAfterFailure(runtime, error);
  }
  await runtime.close();
  dependencies.write(`${JSON.stringify(report)}\n`);
  return report.status === "completed" || report.status === "already-completed" ? 0 : 2;
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
      "Factory scheduler tick and cleanup both failed.",
      { cause: primaryError }
    );
  }
  throw primaryError;
}
