import { randomUUID } from "node:crypto";

import type { Sha256Digest } from "@agentlab/contracts";
import {
  createConfiguredLocalFactoryWorker,
  loadLocalFactoryWorkerConfig,
  type FactoryPullRequestRepairExecutionOutcome,
  type FactoryWorkerPreflight,
  type LocalFactoryWorkerConfig,
  type LocalFactoryWorkerRuntime
} from "@agentlab/runtime/factory-worker";

import { isFactoryTaskId, isNormalizedAbsolutePath, isSha256Digest } from "./factory-cli-input.js";

export interface FactoryWorkerRepairRunnerDependencies {
  readonly loadConfig: (path: string) => Promise<LocalFactoryWorkerConfig>;
  readonly createRuntime: (config: LocalFactoryWorkerConfig) => LocalFactoryWorkerRuntime;
  readonly createCorrelationId: () => string;
  readonly write: (message: string) => void;
}

const defaultDependencies: FactoryWorkerRepairRunnerDependencies = {
  loadConfig: loadLocalFactoryWorkerConfig,
  createRuntime: createConfiguredLocalFactoryWorker,
  createCorrelationId: randomUUID,
  write: (message) => process.stdout.write(message)
};

/** Consumes one exact repair authorization without any remote-repository capability. */
export async function runFactoryWorkerRepairPullRequest(
  configPath: string,
  taskId: string,
  authorizationDigest: string,
  expectedPolicyBundleDigest: string,
  confirmation: string,
  dependencies: FactoryWorkerRepairRunnerDependencies = defaultDependencies
): Promise<number> {
  assertCommandInput(
    configPath,
    taskId,
    authorizationDigest,
    expectedPolicyBundleDigest,
    confirmation
  );
  const config = await dependencies.loadConfig(configPath);
  const runtime = dependencies.createRuntime(config);
  let preflight: FactoryWorkerPreflight;
  let result: FactoryPullRequestRepairExecutionOutcome | null = null;
  let reasonCodes: readonly string[];
  try {
    preflight = await runtime.commands.preflight();
    reasonCodes = [
      ...preflight.reasonCodes.filter(
        (reasonCode) =>
          reasonCode !== "scheduler-disabled" && reasonCode !== "schedule-policy-unconfigured"
      ),
      ...(preflight.policyBundleDigest === expectedPolicyBundleDigest
        ? []
        : ["policy-bundle-digest-mismatch"])
    ];
    if (reasonCodes.length === 0) {
      result = await runtime.commands.executePullRequestRepair({
        taskId,
        authorizationDigest,
        correlationId: dependencies.createCorrelationId()
      });
      assertResultIdentity(result, taskId, authorizationDigest);
      reasonCodes =
        result.status === "pr-proposed" || result.status === "already-advanced"
          ? []
          : [`pr-repair-${result.status}`];
    }
  } catch (error: unknown) {
    return closeAfterFailure(runtime, error);
  }
  await runtime.close();
  dependencies.write(
    `${JSON.stringify({
      schemaVersion: "agentlab.worker-repair-command-result.v1",
      status: result?.status ?? "blocked",
      taskId,
      policyBundleDigest: preflight.policyBundleDigest,
      authorizationDigest,
      reasonCodes: [...new Set(reasonCodes)].sort(),
      result:
        result === null
          ? null
          : {
              contractDigest: result.task.contractDigest,
              taskState: result.task.state,
              repairRunDigest: result.repairRunDigest,
              patchProposalDigest: result.patch?.digest ?? null,
              independentReviews: result.reviews.length,
              usageComplete: result.usageComplete,
              created: result.created
            }
    })}\n`
  );
  return result?.status === "pr-proposed" || result?.status === "already-advanced" ? 0 : 2;
}

function assertCommandInput(
  configPath: string,
  taskId: string,
  authorizationDigest: string,
  expectedPolicyBundleDigest: string,
  confirmation: string
): asserts authorizationDigest is Sha256Digest {
  if (!isNormalizedAbsolutePath(configPath)) {
    throw new Error("Factory worker repair command requires a normalized absolute config path.");
  }
  if (!isFactoryTaskId(taskId)) throw new Error("Factory worker repair task ID is invalid.");
  if (!isSha256Digest(authorizationDigest)) {
    throw new Error("Factory worker repair authorization digest is invalid.");
  }
  if (!isSha256Digest(expectedPolicyBundleDigest)) {
    throw new Error("Factory worker repair policy digest is invalid.");
  }
  if (confirmation !== "repair-pr") {
    throw new Error("Factory worker repair command requires explicit repair confirmation.");
  }
}

function assertResultIdentity(
  result: FactoryPullRequestRepairExecutionOutcome,
  taskId: string,
  authorizationDigest: string
): void {
  if (
    result.task.contract.taskId !== taskId ||
    result.authorizationDigest !== authorizationDigest ||
    (result.status === "already-advanced"
      ? result.task.state !== "pr-open"
      : result.status !== result.task.state)
  ) {
    throw new Error("Factory worker repair result does not match its confirmed command.");
  }
}

async function closeAfterFailure(
  runtime: LocalFactoryWorkerRuntime,
  primaryError: unknown
): Promise<never> {
  try {
    await runtime.close();
  } catch (cleanupError: unknown) {
    throw new AggregateError(
      [primaryError, cleanupError],
      "Factory worker repair command and cleanup both failed.",
      { cause: primaryError }
    );
  }
  throw primaryError;
}
