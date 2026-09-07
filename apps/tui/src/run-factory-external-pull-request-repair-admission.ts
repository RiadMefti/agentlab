import {
  createConfiguredLocalFactoryExternalPullRequestRepairAdmission,
  loadLocalFactoryExternalPullRequestRepairAdmissionConfig,
  type FactoryExternalPullRequestRepairAdmissionPreflight,
  type FactoryExternalPullRequestRepairAdmissionTickReport,
  type LocalFactoryExternalPullRequestRepairAdmissionConfig,
  type LocalFactoryExternalPullRequestRepairAdmissionRuntime
} from "@agentlab/runtime/factory-external-pull-request-repair-admission";

import { isNormalizedAbsolutePath, isSha256Digest } from "./factory-cli-input.js";

export interface FactoryExternalPullRequestRepairAdmissionRunnerDependencies {
  readonly loadConfig: (
    path: string
  ) => Promise<LocalFactoryExternalPullRequestRepairAdmissionConfig>;
  readonly createRuntime: (
    config: LocalFactoryExternalPullRequestRepairAdmissionConfig
  ) => LocalFactoryExternalPullRequestRepairAdmissionRuntime;
  readonly write: (message: string) => void;
}

const defaultDependencies: FactoryExternalPullRequestRepairAdmissionRunnerDependencies = {
  loadConfig: loadLocalFactoryExternalPullRequestRepairAdmissionConfig,
  createRuntime: createConfiguredLocalFactoryExternalPullRequestRepairAdmission,
  write: (message) => process.stdout.write(message)
};

export async function runFactoryExternalPullRequestRepairAdmissionPreflight(
  configPath: string,
  dependencies: FactoryExternalPullRequestRepairAdmissionRunnerDependencies = defaultDependencies
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

export async function runFactoryExternalPullRequestRepairAdmissionTick(
  configPath: string,
  pins: {
    readonly expectedAdmissionPolicyDigest: string;
    readonly expectedReviewPolicyDigest: string;
    readonly expectedFeedbackPolicyDigest: string;
    readonly expectedRepairExecutionPolicyDigest: string;
    readonly expectedCostPolicyDigest: string;
    readonly expectedRoleIdentityPolicyDigest: string;
    readonly expectedGateProfileDigest: string;
  },
  dependencies: FactoryExternalPullRequestRepairAdmissionRunnerDependencies = defaultDependencies
): Promise<number> {
  assertConfigPath(configPath);
  for (const [name, digest] of Object.entries(pins)) {
    if (!isSha256Digest(digest)) throw new Error(`External repair ${name} is invalid.`);
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
    | FactoryExternalPullRequestRepairAdmissionPreflight
    | FactoryExternalPullRequestRepairAdmissionTickReport
): string {
  return JSON.stringify({ ...report, reasonCodes: [...report.reasonCodes].sort() });
}

function assertConfigPath(configPath: string): void {
  if (!isNormalizedAbsolutePath(configPath)) {
    throw new Error("External repair admission requires a normalized absolute config path.");
  }
}

async function closeAfterFailure(
  runtime: LocalFactoryExternalPullRequestRepairAdmissionRuntime,
  primaryError: unknown
): Promise<never> {
  try {
    await runtime.close();
  } catch (cleanupError: unknown) {
    throw new AggregateError(
      [primaryError, cleanupError],
      "External repair admission and cleanup both failed.",
      { cause: primaryError }
    );
  }
  throw primaryError;
}
