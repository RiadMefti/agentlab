import type { Sha256Digest } from "@agentlab/contracts";
import {
  createConfiguredLocalFactoryBroker,
  loadLocalFactoryBrokerConfig,
  type FactoryBrokerPreflight,
  type LocalFactoryBrokerConfig,
  type LocalFactoryBrokerRuntime
} from "@agentlab/runtime/factory-broker";

import { isFactoryTaskId, isNormalizedAbsolutePath, isSha256Digest } from "./factory-cli-input.js";

type BrokerDraftOutcome = Awaited<ReturnType<LocalFactoryBrokerRuntime["commands"]["openDraft"]>>;

export interface FactoryBrokerOpenDraftRunnerDependencies {
  readonly loadConfig: (path: string) => Promise<LocalFactoryBrokerConfig>;
  readonly createRuntime: (config: LocalFactoryBrokerConfig) => LocalFactoryBrokerRuntime;
  readonly write: (message: string) => void;
}

const defaultDependencies: FactoryBrokerOpenDraftRunnerDependencies = {
  loadConfig: loadLocalFactoryBrokerConfig,
  createRuntime: createConfiguredLocalFactoryBroker,
  write: (message) => process.stdout.write(message)
};

interface BrokerDraftResult {
  readonly status: "opened" | "blocked" | "denied" | "needs-human";
  readonly reasonCodes: readonly string[];
  readonly outcome: BrokerDraftOutcome | null;
}

/** Runs the sole explicit remote-write command after readiness and policy-pin verification. */
export async function runFactoryBrokerOpenDraft(
  configPath: string,
  taskId: string,
  expectedPolicyBundleDigest: string,
  confirmation: string,
  dependencies: FactoryBrokerOpenDraftRunnerDependencies = defaultDependencies
): Promise<number> {
  assertCommandInput(configPath, taskId, expectedPolicyBundleDigest, confirmation);
  const config = await dependencies.loadConfig(configPath);
  const runtime = dependencies.createRuntime(config);
  let preflight: FactoryBrokerPreflight;
  let result: BrokerDraftResult;
  try {
    preflight = await runtime.commands.preflight();
    if (preflight.policyBundleDigest !== expectedPolicyBundleDigest) {
      result = {
        status: "blocked",
        reasonCodes: ["policy-bundle-digest-mismatch"],
        outcome: null
      };
    } else if (preflight.status !== "ready") {
      result = { status: "blocked", reasonCodes: preflight.reasonCodes, outcome: null };
    } else {
      const outcome = await runtime.commands.openDraft({ taskId });
      assertOutcomeIdentity(outcome, preflight, taskId);
      result = {
        status: outcome.status,
        reasonCodes: outcome.status === "opened" ? [] : outcome.reasonCodes,
        outcome
      };
    }
  } catch (error: unknown) {
    return closeAfterFailure(runtime, error);
  }
  await runtime.close();
  dependencies.write(`${serializeResult(preflight, taskId, result)}\n`);
  return result.status === "opened" ? 0 : 2;
}

function assertCommandInput(
  configPath: string,
  taskId: string,
  expectedPolicyBundleDigest: string,
  confirmation: string
): asserts expectedPolicyBundleDigest is Sha256Digest {
  if (!isNormalizedAbsolutePath(configPath)) {
    throw new Error("Factory broker command requires a normalized absolute config path.");
  }
  if (!isFactoryTaskId(taskId)) throw new Error("Factory broker command task ID is invalid.");
  if (!isSha256Digest(expectedPolicyBundleDigest)) {
    throw new Error("Factory broker command policy digest is invalid.");
  }
  if (confirmation !== "confirm-draft") {
    throw new Error("Factory broker command requires explicit draft confirmation.");
  }
}

function assertOutcomeIdentity(
  outcome: BrokerDraftOutcome,
  preflight: FactoryBrokerPreflight,
  taskId: string
): void {
  if (
    outcome.status === "opened" &&
    (outcome.record.taskId !== taskId ||
      outcome.record.repositoryId !== preflight.repository.repositoryId)
  ) {
    throw new Error("Factory broker result does not match the confirmed command or preflight.");
  }
}

function serializeResult(
  preflight: FactoryBrokerPreflight,
  taskId: string,
  result: BrokerDraftResult
): string {
  const opened = result.outcome?.status === "opened" ? result.outcome.record : null;
  return JSON.stringify({
    schemaVersion: "agentlab.broker-open-draft-result.v1",
    status: result.status,
    taskId,
    policyBundleDigest: preflight.policyBundleDigest,
    repository: {
      repositoryId: preflight.repository.repositoryId,
      baseBranch: preflight.repository.baseBranch,
      baseRevision: preflight.repository.baseRevision
    },
    reasonCodes: [...new Set(result.reasonCodes)].sort(),
    pullRequest:
      opened === null
        ? null
        : {
            number: opened.number,
            url: opened.url,
            branchName: opened.branchName,
            baseRevision: opened.baseRevision,
            headRevision: opened.headRevision,
            proposalDigest: opened.proposalDigest,
            draft: opened.draft
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
      "Factory broker command and cleanup both failed.",
      { cause: primaryError }
    );
  }
  throw primaryError;
}
