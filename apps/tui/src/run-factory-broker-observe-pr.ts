import type { Sha256Digest } from "@agentlab/contracts";
import {
  createConfiguredLocalFactoryBroker,
  loadLocalFactoryBrokerConfig,
  type FactoryBrokerPreflight,
  type LocalFactoryBrokerConfig,
  type LocalFactoryBrokerRuntime
} from "@agentlab/runtime/factory-broker";

import { isFactoryTaskId, isNormalizedAbsolutePath, isSha256Digest } from "./factory-cli-input.js";

type ObservationOutcome = Awaited<
  ReturnType<LocalFactoryBrokerRuntime["commands"]["observePullRequest"]>
>;

export interface FactoryBrokerObservePullRequestRunnerDependencies {
  readonly loadConfig: (path: string) => Promise<LocalFactoryBrokerConfig>;
  readonly createRuntime: (config: LocalFactoryBrokerConfig) => LocalFactoryBrokerRuntime;
  readonly write: (message: string) => void;
}

const defaultDependencies: FactoryBrokerObservePullRequestRunnerDependencies = {
  loadConfig: loadLocalFactoryBrokerConfig,
  createRuntime: createConfiguredLocalFactoryBroker,
  write: (message) => process.stdout.write(message)
};

/** Records bounded remote facts without printing feedback text or invoking a repair worker. */
export async function runFactoryBrokerObservePullRequest(
  configPath: string,
  taskId: string,
  expectedPolicyBundleDigest: string,
  confirmation: string,
  dependencies: FactoryBrokerObservePullRequestRunnerDependencies = defaultDependencies
): Promise<number> {
  assertCommandInput(configPath, taskId, expectedPolicyBundleDigest, confirmation);
  const config = await dependencies.loadConfig(configPath);
  const runtime = dependencies.createRuntime(config);
  let preflight: FactoryBrokerPreflight;
  let outcome: ObservationOutcome | null = null;
  let reasonCodes: readonly string[] = [];
  try {
    preflight = await runtime.commands.preflight();
    if (preflight.policyBundleDigest !== expectedPolicyBundleDigest) {
      reasonCodes = ["policy-bundle-digest-mismatch"];
    } else if (preflight.status !== "ready") {
      reasonCodes = preflight.reasonCodes;
    } else {
      outcome = await runtime.commands.observePullRequest({ taskId });
      reasonCodes =
        outcome.status === "observed" ? outcome.assessment.reasonCodes : outcome.reasonCodes;
      assertOutcomeIdentity(outcome, preflight, taskId);
    }
  } catch (error: unknown) {
    return closeAfterFailure(runtime, error);
  }
  await runtime.close();
  dependencies.write(`${serializeResult(preflight, taskId, outcome, reasonCodes)}\n`);
  return outcome?.status === "observed" ? 0 : 2;
}

function assertCommandInput(
  configPath: string,
  taskId: string,
  expectedPolicyBundleDigest: string,
  confirmation: string
): asserts expectedPolicyBundleDigest is Sha256Digest {
  if (!isNormalizedAbsolutePath(configPath)) {
    throw new Error("Factory broker observation requires a normalized absolute config path.");
  }
  if (!isFactoryTaskId(taskId)) throw new Error("Factory broker observation task ID is invalid.");
  if (!isSha256Digest(expectedPolicyBundleDigest)) {
    throw new Error("Factory broker observation policy digest is invalid.");
  }
  if (confirmation !== "confirm-observe") {
    throw new Error("Factory broker observation requires explicit confirmation.");
  }
}

function assertOutcomeIdentity(
  outcome: ObservationOutcome,
  preflight: FactoryBrokerPreflight,
  taskId: string
): void {
  if (
    outcome.status === "observed" &&
    (outcome.observation.taskId !== taskId ||
      outcome.observation.repositoryId !== preflight.repository.repositoryId)
  ) {
    throw new Error("Factory PR observation does not match the confirmed task or preflight.");
  }
}

function serializeResult(
  preflight: FactoryBrokerPreflight,
  taskId: string,
  outcome: ObservationOutcome | null,
  reasonCodes: readonly string[]
): string {
  const observed = outcome?.status === "observed" ? outcome : null;
  return JSON.stringify({
    schemaVersion: "agentlab.broker-observe-pr-result.v1",
    status: observed === null ? "blocked" : "observed",
    taskId,
    policyBundleDigest: preflight.policyBundleDigest,
    repositoryId: preflight.repository.repositoryId,
    reasonCodes: [...new Set(reasonCodes)].sort(),
    observation:
      observed === null
        ? null
        : {
            digest: observed.observationDigest,
            evidenceBundleDigest: observed.evidenceBundleDigest,
            disposition: observed.assessment.disposition,
            pullRequestNumber: observed.observation.pullRequestNumber,
            remoteBaseRevision: observed.observation.remoteBaseRevision,
            remoteHeadRevision: observed.observation.remoteHeadRevision,
            trustedChecks: observed.observation.trustedChecks.length,
            reviews: observed.observation.reviews.length,
            reviewComments: observed.observation.reviewComments.length,
            conversationComments: observed.observation.conversationComments.length,
            observedAt: observed.observation.observedAt
          }
  });
}

async function closeAfterFailure(
  runtime: LocalFactoryBrokerRuntime,
  primaryError: unknown
): Promise<never> {
  try {
    await runtime.close();
  } catch (cleanupError: unknown) {
    throw new AggregateError(
      [primaryError, cleanupError],
      "Factory PR observation and cleanup both failed.",
      { cause: primaryError }
    );
  }
  throw primaryError;
}
