import {
  createConfiguredLocalFactoryExternalPullRequestRepairQualification,
  loadLocalFactoryExternalPullRequestRepairQualificationConfig,
  type FactoryExternalPullRequestRepairQualificationPreflight,
  type FactoryExternalPullRequestRepairQualificationTickReport,
  type LocalFactoryExternalPullRequestRepairQualificationConfig,
  type LocalFactoryExternalPullRequestRepairQualificationRuntime
} from "@agentlab/runtime/factory-external-pull-request-repair-qualification";

import { isNormalizedAbsolutePath, isSha256Digest } from "./factory-cli-input.js";

export interface FactoryExternalPullRequestRepairQualificationRunnerDependencies {
  readonly loadConfig: (
    path: string
  ) => Promise<LocalFactoryExternalPullRequestRepairQualificationConfig>;
  readonly createRuntime: (
    config: LocalFactoryExternalPullRequestRepairQualificationConfig
  ) => LocalFactoryExternalPullRequestRepairQualificationRuntime;
  readonly write: (message: string) => void;
}

const defaultDependencies: FactoryExternalPullRequestRepairQualificationRunnerDependencies = {
  loadConfig: loadLocalFactoryExternalPullRequestRepairQualificationConfig,
  createRuntime: createConfiguredLocalFactoryExternalPullRequestRepairQualification,
  write: (message) => process.stdout.write(message)
};

export async function runFactoryExternalPullRequestRepairQualificationPreflight(
  configPath: string,
  dependencies: FactoryExternalPullRequestRepairQualificationRunnerDependencies = defaultDependencies
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

export async function runFactoryExternalPullRequestRepairQualificationTick(
  configPath: string,
  pins: {
    readonly expectedQualificationPolicyDigest: string;
    readonly expectedRepairExecutionPolicyDigest: string;
    readonly expectedCostPolicyDigest: string;
    readonly expectedRoleIdentityPolicyDigest: string;
    readonly expectedGateProfileDigest: string;
  },
  dependencies: FactoryExternalPullRequestRepairQualificationRunnerDependencies = defaultDependencies
): Promise<number> {
  assertConfigPath(configPath);
  for (const [name, digest] of Object.entries(pins)) {
    if (!isSha256Digest(digest))
      throw new Error(`External repair qualification ${name} is invalid.`);
  }
  const runtime = dependencies.createRuntime(await dependencies.loadConfig(configPath));
  const report = await runtime.commands
    .tick(pins)
    .catch((error: unknown) => closeAfterFailure(runtime, error));
  await runtime.close();
  dependencies.write(`${serialize(report)}\n`);
  return report.status === "completed" || report.status === "idle"
    ? 0
    : report.status === "blocked"
      ? 2
      : 1;
}

function serialize(
  report:
    | FactoryExternalPullRequestRepairQualificationPreflight
    | FactoryExternalPullRequestRepairQualificationTickReport
): string {
  return JSON.stringify({ ...report, reasonCodes: [...report.reasonCodes].sort() });
}

function assertConfigPath(configPath: string): void {
  if (!isNormalizedAbsolutePath(configPath)) {
    throw new Error("External repair qualification requires a normalized absolute config path.");
  }
}

async function closeAfterFailure(
  runtime: LocalFactoryExternalPullRequestRepairQualificationRuntime,
  primaryError: unknown
): Promise<never> {
  try {
    await runtime.close();
  } catch (cleanupError: unknown) {
    throw new AggregateError(
      [primaryError, cleanupError],
      "External repair qualification and cleanup both failed.",
      { cause: primaryError }
    );
  }
  throw primaryError;
}
