import {
  createConfiguredLocalFactoryWorker,
  loadLocalFactoryWorkerConfig,
  type FactoryWorkerPreflight,
  type LocalFactoryWorkerConfig,
  type LocalFactoryWorkerRuntime
} from "@agentlab/runtime/factory-worker";

import { isNormalizedAbsolutePath } from "./factory-cli-input.js";

export interface FactoryWorkerPreflightRunnerDependencies {
  readonly loadConfig: (path: string) => Promise<LocalFactoryWorkerConfig>;
  readonly createRuntime: (config: LocalFactoryWorkerConfig) => LocalFactoryWorkerRuntime;
  readonly write: (message: string) => void;
}

const defaultDependencies: FactoryWorkerPreflightRunnerDependencies = {
  loadConfig: loadLocalFactoryWorkerConfig,
  createRuntime: createConfiguredLocalFactoryWorker,
  write: (message) => process.stdout.write(message)
};

/** Reports worker readiness without granting authority or invoking provider work. */
export async function runFactoryWorkerPreflight(
  configPath: string,
  dependencies: FactoryWorkerPreflightRunnerDependencies = defaultDependencies
): Promise<number> {
  if (!isNormalizedAbsolutePath(configPath)) {
    throw new Error("Factory worker preflight requires a normalized absolute config path.");
  }
  const config = await dependencies.loadConfig(configPath);
  const runtime = dependencies.createRuntime(config);
  const report: FactoryWorkerPreflight = await runtime.commands
    .preflight()
    .catch((error: unknown) => closeAfterFailure(runtime, error));
  await runtime.close();
  dependencies.write(`${serializePreflight(report)}\n`);
  return report.status === "ready" ? 0 : 2;
}

function serializePreflight(report: FactoryWorkerPreflight): string {
  return JSON.stringify({
    schemaVersion: report.schemaVersion,
    status: report.status,
    policyBundleDigest: report.policyBundleDigest,
    schedulerEnabled: report.schedulerEnabled,
    costPolicyConfigured: report.costPolicyConfigured,
    hostReady: report.hostReady,
    configuredProviders: [...report.configuredProviders].sort(),
    gateIds: [...report.gateIds].sort(),
    reasonCodes: [...report.reasonCodes].sort()
  });
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
      "Factory worker preflight and cleanup both failed.",
      { cause: primaryError }
    );
  }
  throw primaryError;
}
