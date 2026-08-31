import type { FactoryCanaryRequest } from "@agentlab/contracts";
import {
  createConfiguredLocalFactoryCanaryAuthority,
  loadLocalFactoryCanaryAuthorityConfig,
  loadLocalFactoryCanaryRequest,
  type FactoryCanaryAuthorityResult,
  type LocalFactoryCanaryAuthorityConfig,
  type LocalFactoryCanaryAuthorityRuntime
} from "@agentlab/runtime/factory-canary-authority";

import { isNormalizedAbsolutePath, isSha256Digest } from "./factory-cli-input.js";

export interface FactoryCanaryAuthorityRunnerDependencies {
  readonly loadConfig: (path: string) => Promise<LocalFactoryCanaryAuthorityConfig>;
  readonly loadRequest: (path: string) => Promise<FactoryCanaryRequest>;
  readonly createRuntime: (
    config: LocalFactoryCanaryAuthorityConfig
  ) => LocalFactoryCanaryAuthorityRuntime;
  readonly write: (message: string) => void;
}

const defaultDependencies: FactoryCanaryAuthorityRunnerDependencies = {
  loadConfig: loadLocalFactoryCanaryAuthorityConfig,
  loadRequest: loadLocalFactoryCanaryRequest,
  createRuntime: createConfiguredLocalFactoryCanaryAuthority,
  write: (message) => process.stdout.write(message)
};

/** Issues only one bounded human-reviewed cohort; it cannot execute, merge, or release. */
export async function runFactoryCanaryAuthorize(
  configPath: string,
  assessmentDigest: string,
  requestPath: string,
  confirmation: string,
  dependencies: FactoryCanaryAuthorityRunnerDependencies = defaultDependencies
): Promise<number> {
  if (!isNormalizedAbsolutePath(configPath)) {
    throw new Error("Factory canary authority requires a normalized absolute config path.");
  }
  if (!isSha256Digest(assessmentDigest)) {
    throw new Error("Factory canary authority assessment digest is invalid.");
  }
  if (!isNormalizedAbsolutePath(requestPath)) {
    throw new Error("Factory canary authority requires a normalized absolute request path.");
  }
  if (confirmation !== "authorize-canary") {
    throw new Error("Factory canary authority requires explicit confirmation.");
  }
  const [config, request] = await Promise.all([
    dependencies.loadConfig(configPath),
    dependencies.loadRequest(requestPath)
  ]);
  const runtime = dependencies.createRuntime(config);
  const result = await runtime.commands
    .authorize({ assessmentDigest, request, confirmation })
    .catch((error: unknown) => closeAfterFailure(runtime, error));
  await runtime.close();
  dependencies.write(`${serializeAuthority(result)}\n`);
  return 0;
}

function serializeAuthority(result: FactoryCanaryAuthorityResult): string {
  return JSON.stringify({
    schemaVersion: "agentlab.canary-authority-command-result.v1",
    status: result.status,
    approval: {
      approvalId: result.approval.approvalId,
      approvalDigest: result.approvalDigest,
      assessmentDigest: result.approval.assessmentDigest,
      challengerCandidateDigest: result.approval.challengerCandidateDigest,
      stage: result.approval.stage,
      repositoryIds: result.approval.repositoryIds,
      maximumRiskTier: result.approval.maximumRiskTier,
      maximumTasks: result.approval.maximumTasks,
      budget: result.approval.budget,
      humanSampleReviewDigest: result.approval.humanSampleReviewDigest,
      humanSampleSize: result.approval.humanSampleSize,
      operatorId: result.approval.actor.id,
      occurredAt: result.approval.occurredAt,
      expiresAt: result.approval.expiresAt
    },
    cohort: {
      cohortId: result.cohort.cohortId,
      cohortDigest: result.cohortDigest,
      runDigest: result.cohort.runDigest,
      autoMerge: result.cohort.autoMerge,
      release: result.cohort.release
    }
  });
}

async function closeAfterFailure(
  runtime: LocalFactoryCanaryAuthorityRuntime,
  primaryError: unknown
): Promise<never> {
  try {
    await runtime.close();
  } catch (cleanupError: unknown) {
    throw new AggregateError(
      [primaryError, cleanupError],
      "Factory canary authority operation and cleanup both failed.",
      { cause: primaryError }
    );
  }
  throw primaryError;
}
