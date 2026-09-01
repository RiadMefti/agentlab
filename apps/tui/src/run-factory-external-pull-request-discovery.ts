import {
  createConfiguredLocalFactoryExternalPullRequestDiscovery,
  loadLocalFactoryExternalPullRequestDiscoveryConfig,
  type FactoryExternalPullRequestDiscoveryPreflight,
  type FactoryExternalPullRequestDiscoveryTickReport,
  type LocalFactoryExternalPullRequestDiscoveryConfig,
  type LocalFactoryExternalPullRequestDiscoveryRuntime
} from "@agentlab/runtime/factory-external-pull-request-discovery";

import { isNormalizedAbsolutePath, isSha256Digest } from "./factory-cli-input.js";

export interface FactoryExternalPullRequestDiscoveryRunnerDependencies {
  readonly loadConfig: (path: string) => Promise<LocalFactoryExternalPullRequestDiscoveryConfig>;
  readonly createRuntime: (
    config: LocalFactoryExternalPullRequestDiscoveryConfig
  ) => LocalFactoryExternalPullRequestDiscoveryRuntime;
  readonly write: (message: string) => void;
}

const defaultDependencies: FactoryExternalPullRequestDiscoveryRunnerDependencies = {
  loadConfig: loadLocalFactoryExternalPullRequestDiscoveryConfig,
  createRuntime: createConfiguredLocalFactoryExternalPullRequestDiscovery,
  write: (message) => process.stdout.write(message)
};

export async function runFactoryExternalPullRequestDiscoveryPreflight(
  configPath: string,
  dependencies: FactoryExternalPullRequestDiscoveryRunnerDependencies = defaultDependencies
): Promise<number> {
  assertConfigPath(configPath);
  const runtime = dependencies.createRuntime(await dependencies.loadConfig(configPath));
  const report = await runtime.commands
    .preflight()
    .catch((error: unknown) => closeAfterFailure(runtime, error));
  await runtime.close();
  dependencies.write(`${serialize(report)}\n`);
  return report.status === "ready" ? 0 : 2;
}

export async function runFactoryExternalPullRequestDiscoveryTick(
  configPath: string,
  expectedDiscoveryPolicyDigest: string,
  expectedSchedulePolicyDigest: string,
  dependencies: FactoryExternalPullRequestDiscoveryRunnerDependencies = defaultDependencies
): Promise<number> {
  assertConfigPath(configPath);
  if (!isSha256Digest(expectedDiscoveryPolicyDigest)) {
    throw new Error("External PR discovery policy digest is invalid.");
  }
  if (!isSha256Digest(expectedSchedulePolicyDigest)) {
    throw new Error("External PR discovery schedule policy digest is invalid.");
  }
  const runtime = dependencies.createRuntime(await dependencies.loadConfig(configPath));
  const report = await runtime.commands
    .tick({ expectedDiscoveryPolicyDigest, expectedSchedulePolicyDigest })
    .catch((error: unknown) => closeAfterFailure(runtime, error));
  await runtime.close();
  dependencies.write(`${serialize(report)}\n`);
  return report.status === "completed" || report.status === "already-completed"
    ? 0
    : report.status === "blocked"
      ? 2
      : 1;
}

function serialize(
  report:
    FactoryExternalPullRequestDiscoveryPreflight | FactoryExternalPullRequestDiscoveryTickReport
): string {
  return JSON.stringify({ ...report, reasonCodes: [...report.reasonCodes].sort() });
}

function assertConfigPath(configPath: string): void {
  if (!isNormalizedAbsolutePath(configPath)) {
    throw new Error("External PR discovery requires a normalized absolute config path.");
  }
}

async function closeAfterFailure(
  runtime: LocalFactoryExternalPullRequestDiscoveryRuntime,
  primaryError: unknown
): Promise<never> {
  try {
    await runtime.close();
  } catch (cleanupError: unknown) {
    throw new AggregateError(
      [primaryError, cleanupError],
      "External PR discovery and cleanup both failed.",
      { cause: primaryError }
    );
  }
  throw primaryError;
}
