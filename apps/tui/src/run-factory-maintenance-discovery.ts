import {
  createConfiguredLocalFactoryMaintenanceDiscovery,
  loadLocalFactoryMaintenanceDiscoveryConfig,
  type FactoryMaintenanceDiscoveryPreflight,
  type FactoryMaintenanceDiscoveryTickReport,
  type LocalFactoryMaintenanceDiscoveryConfig,
  type LocalFactoryMaintenanceDiscoveryRuntime
} from "@agentlab/runtime/factory-maintenance-discovery";

import { isNormalizedAbsolutePath, isSha256Digest } from "./factory-cli-input.js";

export interface FactoryMaintenanceDiscoveryRunnerDependencies {
  readonly loadConfig: (path: string) => Promise<LocalFactoryMaintenanceDiscoveryConfig>;
  readonly createRuntime: (
    config: LocalFactoryMaintenanceDiscoveryConfig
  ) => LocalFactoryMaintenanceDiscoveryRuntime;
  readonly write: (message: string) => void;
}

const defaultDependencies: FactoryMaintenanceDiscoveryRunnerDependencies = {
  loadConfig: loadLocalFactoryMaintenanceDiscoveryConfig,
  createRuntime: createConfiguredLocalFactoryMaintenanceDiscovery,
  write: (message) => process.stdout.write(message)
};

export async function runFactoryMaintenanceDiscoveryPreflight(
  configPath: string,
  dependencies: FactoryMaintenanceDiscoveryRunnerDependencies = defaultDependencies
): Promise<number> {
  assertConfigPath(configPath);
  const runtime = dependencies.createRuntime(await dependencies.loadConfig(configPath));
  const report = await runtime.commands
    .preflight()
    .catch((error: unknown) => closeAfterFailure(runtime, error));
  await runtime.close();
  dependencies.write(`${serializePreflight(report)}\n`);
  return report.status === "ready" ? 0 : 2;
}

export async function runFactoryMaintenanceDiscoveryTick(
  configPath: string,
  expectedDiscoveryPolicyDigest: string,
  expectedSchedulePolicyDigest: string,
  expectedFactoryPolicyBundleDigest: string,
  expectedPreparationGrantDigest: string,
  expectedRoleIdentityPolicyDigest: string,
  dependencies: FactoryMaintenanceDiscoveryRunnerDependencies = defaultDependencies
): Promise<number> {
  assertConfigPath(configPath);
  for (const [digest, label] of [
    [expectedDiscoveryPolicyDigest, "discovery policy"],
    [expectedSchedulePolicyDigest, "schedule policy"],
    [expectedFactoryPolicyBundleDigest, "factory policy"],
    [expectedPreparationGrantDigest, "preparation grant"],
    [expectedRoleIdentityPolicyDigest, "role policy"]
  ] as const) {
    if (!isSha256Digest(digest))
      throw new Error(`Maintenance discovery ${label} digest is invalid.`);
  }
  const runtime = dependencies.createRuntime(await dependencies.loadConfig(configPath));
  const report = await runtime.commands
    .tick({
      expectedDiscoveryPolicyDigest,
      expectedSchedulePolicyDigest,
      expectedFactoryPolicyBundleDigest,
      expectedPreparationGrantDigest,
      expectedRoleIdentityPolicyDigest
    })
    .catch((error: unknown) => closeAfterFailure(runtime, error));
  await runtime.close();
  dependencies.write(`${serializeTick(report)}\n`);
  return report.status === "completed" || report.status === "already-completed"
    ? 0
    : report.status === "blocked" || report.status === "missed-deadline"
      ? 2
      : 1;
}

function serializePreflight(report: FactoryMaintenanceDiscoveryPreflight): string {
  return JSON.stringify({ ...report, reasonCodes: [...report.reasonCodes].sort() });
}

function serializeTick(report: FactoryMaintenanceDiscoveryTickReport): string {
  return JSON.stringify({ ...report, reasonCodes: [...report.reasonCodes].sort() });
}

function assertConfigPath(configPath: string): void {
  if (!isNormalizedAbsolutePath(configPath)) {
    throw new Error("Maintenance discovery requires a normalized absolute config path.");
  }
}

async function closeAfterFailure(
  runtime: LocalFactoryMaintenanceDiscoveryRuntime,
  primaryError: unknown
): Promise<never> {
  try {
    await runtime.close();
  } catch (cleanupError: unknown) {
    throw new AggregateError(
      [primaryError, cleanupError],
      "Maintenance discovery and cleanup both failed.",
      { cause: primaryError }
    );
  }
  throw primaryError;
}
