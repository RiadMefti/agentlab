import type { Sha256Digest } from "@agentlab/contracts";
import {
  createConfiguredLocalFactoryBroker,
  loadLocalFactoryBrokerConfig,
  type FactoryBrokerPreflight,
  type LocalFactoryBrokerConfig,
  type LocalFactoryBrokerRuntime
} from "@agentlab/runtime/factory-broker";

import { isFactoryTaskId, isNormalizedAbsolutePath, isSha256Digest } from "./factory-cli-input.js";

type AdmissionOutcome = Awaited<
  ReturnType<LocalFactoryBrokerRuntime["commands"]["admitPullRequestRepair"]>
>;

export interface FactoryBrokerAuthorizeRepairRunnerDependencies {
  readonly loadConfig: (path: string) => Promise<LocalFactoryBrokerConfig>;
  readonly createRuntime: (config: LocalFactoryBrokerConfig) => LocalFactoryBrokerRuntime;
  readonly write: (message: string) => void;
}

const defaultDependencies: FactoryBrokerAuthorizeRepairRunnerDependencies = {
  loadConfig: loadLocalFactoryBrokerConfig,
  createRuntime: createConfiguredLocalFactoryBroker,
  write: (message) => process.stdout.write(message)
};

/** Reserves a structural repair selection and emits only IDs, counts, and digests. */
export async function runFactoryBrokerAuthorizeRepair(
  configPath: string,
  taskId: string,
  observationDigest: string,
  expectedPolicyBundleDigest: string,
  confirmation: string,
  dependencies: FactoryBrokerAuthorizeRepairRunnerDependencies = defaultDependencies
): Promise<number> {
  assertCommandInput(
    configPath,
    taskId,
    observationDigest,
    expectedPolicyBundleDigest,
    confirmation
  );
  const config = await dependencies.loadConfig(configPath);
  const runtime = dependencies.createRuntime(config);
  let preflight: FactoryBrokerPreflight;
  let outcome: AdmissionOutcome | null = null;
  let reasonCodes: readonly string[] = [];
  try {
    preflight = await runtime.commands.preflight();
    if (preflight.policyBundleDigest !== expectedPolicyBundleDigest) {
      reasonCodes = ["policy-bundle-digest-mismatch"];
    } else if (preflight.status !== "ready") {
      reasonCodes = preflight.reasonCodes;
    } else {
      outcome = await runtime.commands.admitPullRequestRepair({ taskId, observationDigest });
      reasonCodes =
        outcome.status === "authorized" ? outcome.authorization.reasonCodes : outcome.reasonCodes;
      assertOutcomeIdentity(outcome, preflight, taskId, observationDigest);
    }
  } catch (error: unknown) {
    return closeAfterFailure(runtime, error);
  }
  await runtime.close();
  dependencies.write(`${serializeResult(preflight, taskId, outcome, reasonCodes)}\n`);
  return outcome?.status === "authorized" ? 0 : 2;
}

function assertCommandInput(
  configPath: string,
  taskId: string,
  observationDigest: string,
  expectedPolicyBundleDigest: string,
  confirmation: string
): asserts observationDigest is Sha256Digest {
  if (!isNormalizedAbsolutePath(configPath)) {
    throw new Error("Factory repair admission requires a normalized absolute config path.");
  }
  if (!isFactoryTaskId(taskId)) throw new Error("Factory repair admission task ID is invalid.");
  if (!isSha256Digest(observationDigest)) {
    throw new Error("Factory repair admission observation digest is invalid.");
  }
  if (!isSha256Digest(expectedPolicyBundleDigest)) {
    throw new Error("Factory repair admission policy digest is invalid.");
  }
  if (confirmation !== "authorize-repair") {
    throw new Error("Factory repair admission requires explicit confirmation.");
  }
}

function assertOutcomeIdentity(
  outcome: AdmissionOutcome,
  preflight: FactoryBrokerPreflight,
  taskId: string,
  observationDigest: Sha256Digest
): void {
  if (
    outcome.status === "authorized" &&
    (outcome.authorization.taskId !== taskId ||
      outcome.authorization.observationDigest !== observationDigest ||
      outcome.authorization.repositoryId !== preflight.repository.repositoryId)
  ) {
    throw new Error("Factory repair authorization does not match confirmed command identity.");
  }
}

function serializeResult(
  preflight: FactoryBrokerPreflight,
  taskId: string,
  outcome: AdmissionOutcome | null,
  reasonCodes: readonly string[]
): string {
  const authorized = outcome?.status === "authorized" ? outcome : null;
  return JSON.stringify({
    schemaVersion: "agentlab.broker-authorize-repair-result.v1",
    status: authorized === null ? "blocked" : "authorized",
    taskId,
    policyBundleDigest: preflight.policyBundleDigest,
    repositoryId: preflight.repository.repositoryId,
    reasonCodes: [...new Set(reasonCodes)].sort(),
    authorization:
      authorized === null
        ? null
        : {
            digest: authorized.authorizationDigest,
            evidenceBundleDigest: authorized.evidenceBundleDigest,
            created: authorized.created,
            authorizationId: authorized.authorization.authorizationId,
            observationDigest: authorized.authorization.observationDigest,
            pullRequestNumber: authorized.authorization.pullRequestNumber,
            headRevision: authorized.authorization.headRevision,
            contractRepairAttempt: authorized.authorization.contractRepairAttempt,
            selectedReviews: authorized.authorization.selectedReviewIds.length,
            selectedReviewComments: authorized.authorization.selectedReviewCommentIds.length,
            failedChecks: authorized.authorization.failedChecks.length,
            expiresAt: authorized.authorization.expiresAt
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
      "Factory repair admission and cleanup both failed.",
      { cause: primaryError }
    );
  }
  throw primaryError;
}
