import {
  createConfiguredLocalFactoryExternalPullRequestReview,
  loadLocalFactoryExternalPullRequestReviewConfig,
  type FactoryExternalPullRequestReviewPreflight,
  type FactoryExternalPullRequestReviewTickReport,
  type LocalFactoryExternalPullRequestReviewConfig,
  type LocalFactoryExternalPullRequestReviewRuntime
} from "@agentlab/runtime/factory-external-pull-request-review";

import { isNormalizedAbsolutePath, isSha256Digest } from "./factory-cli-input.js";

export interface FactoryExternalPullRequestReviewRunnerDependencies {
  readonly loadConfig: (path: string) => Promise<LocalFactoryExternalPullRequestReviewConfig>;
  readonly createRuntime: (
    config: LocalFactoryExternalPullRequestReviewConfig
  ) => LocalFactoryExternalPullRequestReviewRuntime;
  readonly write: (message: string) => void;
}

const defaultDependencies: FactoryExternalPullRequestReviewRunnerDependencies = {
  loadConfig: loadLocalFactoryExternalPullRequestReviewConfig,
  createRuntime: createConfiguredLocalFactoryExternalPullRequestReview,
  write: (message) => process.stdout.write(message)
};

export async function runFactoryExternalPullRequestReviewPreflight(
  configPath: string,
  dependencies: FactoryExternalPullRequestReviewRunnerDependencies = defaultDependencies
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

export async function runFactoryExternalPullRequestReviewTick(
  configPath: string,
  expectedReviewPolicyDigest: string,
  expectedDiscoveryPolicyDigest: string,
  expectedCostPolicyDigest: string,
  dependencies: FactoryExternalPullRequestReviewRunnerDependencies = defaultDependencies
): Promise<number> {
  assertConfigPath(configPath);
  for (const [digest, label] of [
    [expectedReviewPolicyDigest, "review"],
    [expectedDiscoveryPolicyDigest, "discovery"],
    [expectedCostPolicyDigest, "cost"]
  ] as const) {
    if (!isSha256Digest(digest)) throw new Error(`External PR ${label} policy digest is invalid.`);
  }
  const runtime = dependencies.createRuntime(await dependencies.loadConfig(configPath));
  const report = await runtime.commands
    .tick({
      expectedReviewPolicyDigest,
      expectedDiscoveryPolicyDigest,
      expectedCostPolicyDigest
    })
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
  report: FactoryExternalPullRequestReviewPreflight | FactoryExternalPullRequestReviewTickReport
): string {
  return JSON.stringify({ ...report, reasonCodes: [...report.reasonCodes].sort() });
}

function assertConfigPath(configPath: string): void {
  if (!isNormalizedAbsolutePath(configPath)) {
    throw new Error("External PR review requires a normalized absolute config path.");
  }
}

async function closeAfterFailure(
  runtime: LocalFactoryExternalPullRequestReviewRuntime,
  primaryError: unknown
): Promise<never> {
  try {
    await runtime.close();
  } catch (cleanupError: unknown) {
    throw new AggregateError(
      [primaryError, cleanupError],
      "External PR review and cleanup both failed.",
      { cause: primaryError }
    );
  }
  throw primaryError;
}
