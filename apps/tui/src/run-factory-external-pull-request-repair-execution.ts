import {
  createConfiguredLocalFactoryExternalPullRequestRepairExecution,
  loadLocalFactoryExternalPullRequestRepairExecutionConfig,
  type FactoryExternalPullRequestRepairExecutionPreflight,
  type FactoryExternalPullRequestRepairExecutionTickReport,
  type LocalFactoryExternalPullRequestRepairExecutionConfig,
  type LocalFactoryExternalPullRequestRepairExecutionRuntime
} from "@agentlab/runtime/factory-external-pull-request-repair-execution";

import { isNormalizedAbsolutePath, isSha256Digest } from "./factory-cli-input.js";

export interface FactoryExternalPullRequestRepairExecutionRunnerDependencies {
  readonly loadConfig: (
    path: string
  ) => Promise<LocalFactoryExternalPullRequestRepairExecutionConfig>;
  readonly createRuntime: (
    config: LocalFactoryExternalPullRequestRepairExecutionConfig
  ) => LocalFactoryExternalPullRequestRepairExecutionRuntime;
  readonly write: (message: string) => void;
}

const defaultDependencies: FactoryExternalPullRequestRepairExecutionRunnerDependencies = {
  loadConfig: loadLocalFactoryExternalPullRequestRepairExecutionConfig,
  createRuntime: createConfiguredLocalFactoryExternalPullRequestRepairExecution,
  write: (message) => process.stdout.write(message)
};

export async function runFactoryExternalPullRequestRepairExecutionPreflight(
  configPath: string,
  dependencies: FactoryExternalPullRequestRepairExecutionRunnerDependencies = defaultDependencies
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

export async function runFactoryExternalPullRequestRepairExecutionTick(
  configPath: string,
  pins: {
    readonly expectedRepairExecutionPolicyDigest: string;
    readonly expectedAdmissionPolicyDigest: string;
    readonly expectedReviewPolicyDigest: string;
    readonly expectedFeedbackPolicyDigest: string;
    readonly expectedCostPolicyDigest: string;
    readonly expectedRoleIdentityPolicyDigest: string;
    readonly expectedGateProfileDigest: string;
  },
  dependencies: FactoryExternalPullRequestRepairExecutionRunnerDependencies = defaultDependencies
): Promise<number> {
  assertConfigPath(configPath);
  for (const [name, digest] of Object.entries(pins)) {
    if (!isSha256Digest(digest)) throw new Error(`External repair execution ${name} is invalid.`);
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
    | FactoryExternalPullRequestRepairExecutionPreflight
    | FactoryExternalPullRequestRepairExecutionTickReport
): string {
  return JSON.stringify({ ...report, reasonCodes: [...report.reasonCodes].sort() });
}

function assertConfigPath(configPath: string): void {
  if (!isNormalizedAbsolutePath(configPath)) {
    throw new Error("External repair execution requires a normalized absolute config path.");
  }
}

async function closeAfterFailure(
  runtime: LocalFactoryExternalPullRequestRepairExecutionRuntime,
  primaryError: unknown
): Promise<never> {
  try {
    await runtime.close();
  } catch (cleanupError: unknown) {
    throw new AggregateError(
      [primaryError, cleanupError],
      "External repair execution and cleanup both failed.",
      { cause: primaryError }
    );
  }
  throw primaryError;
}
