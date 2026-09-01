import {
  createConfiguredLocalFactoryExternalPullRequestFeedback,
  loadLocalFactoryExternalPullRequestFeedbackConfig,
  type FactoryExternalPullRequestFeedbackPreflight,
  type FactoryExternalPullRequestFeedbackTickReport,
  type LocalFactoryExternalPullRequestFeedbackConfig,
  type LocalFactoryExternalPullRequestFeedbackRuntime
} from "@agentlab/runtime/factory-external-pull-request-feedback";

import { isNormalizedAbsolutePath, isSha256Digest } from "./factory-cli-input.js";

export interface FactoryExternalPullRequestFeedbackRunnerDependencies {
  readonly loadConfig: (path: string) => Promise<LocalFactoryExternalPullRequestFeedbackConfig>;
  readonly createRuntime: (
    config: LocalFactoryExternalPullRequestFeedbackConfig
  ) => LocalFactoryExternalPullRequestFeedbackRuntime;
  readonly write: (message: string) => void;
}

const defaultDependencies: FactoryExternalPullRequestFeedbackRunnerDependencies = {
  loadConfig: loadLocalFactoryExternalPullRequestFeedbackConfig,
  createRuntime: createConfiguredLocalFactoryExternalPullRequestFeedback,
  write: (message) => process.stdout.write(message)
};

export async function runFactoryExternalPullRequestFeedbackPreflight(
  configPath: string,
  dependencies: FactoryExternalPullRequestFeedbackRunnerDependencies = defaultDependencies
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

export async function runFactoryExternalPullRequestFeedbackTick(
  configPath: string,
  expectedFeedbackPolicyDigest: string,
  expectedReviewPolicyDigest: string,
  dependencies: FactoryExternalPullRequestFeedbackRunnerDependencies = defaultDependencies
): Promise<number> {
  assertConfigPath(configPath);
  if (!isSha256Digest(expectedFeedbackPolicyDigest)) {
    throw new Error("External PR feedback policy digest is invalid.");
  }
  if (!isSha256Digest(expectedReviewPolicyDigest)) {
    throw new Error("External PR review policy digest is invalid.");
  }
  const runtime = dependencies.createRuntime(await dependencies.loadConfig(configPath));
  const report = await runtime.commands
    .tick({ expectedFeedbackPolicyDigest, expectedReviewPolicyDigest })
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
  report: FactoryExternalPullRequestFeedbackPreflight | FactoryExternalPullRequestFeedbackTickReport
): string {
  return JSON.stringify({ ...report, reasonCodes: [...report.reasonCodes].sort() });
}

function assertConfigPath(configPath: string): void {
  if (!isNormalizedAbsolutePath(configPath)) {
    throw new Error("External PR feedback requires a normalized absolute config path.");
  }
}

async function closeAfterFailure(
  runtime: LocalFactoryExternalPullRequestFeedbackRuntime,
  primaryError: unknown
): Promise<never> {
  try {
    await runtime.close();
  } catch (cleanupError: unknown) {
    throw new AggregateError(
      [primaryError, cleanupError],
      "External PR feedback and cleanup both failed.",
      { cause: primaryError }
    );
  }
  throw primaryError;
}
