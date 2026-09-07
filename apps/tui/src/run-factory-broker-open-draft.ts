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
  return executeFactoryBrokerOpenDraft(
    configPath,
    taskId,
    expectedPolicyBundleDigest,
    { taskId },
    null,
    dependencies
  );
}

interface CanaryBrokerCoordinates {
  readonly reservationDigest: Sha256Digest;
  readonly schedulePolicyDigest: Sha256Digest;
  readonly roleIdentityPolicyDigest: Sha256Digest;
}

/** Uses evaluated canary authority instead of a per-task human confirmation. */
export async function runFactoryBrokerOpenCanaryDraft(
  configPath: string,
  taskId: string,
  reservationDigest: string,
  schedulePolicyDigest: string,
  roleIdentityPolicyDigest: string,
  expectedPolicyBundleDigest: string,
  dependencies: FactoryBrokerOpenDraftRunnerDependencies = defaultDependencies
): Promise<number> {
  const canary = assertCanaryCommandInput(
    configPath,
    taskId,
    reservationDigest,
    schedulePolicyDigest,
    roleIdentityPolicyDigest,
    expectedPolicyBundleDigest
  );
  return executeFactoryBrokerOpenDraft(
    configPath,
    taskId,
    expectedPolicyBundleDigest,
    { taskId, canary },
    canary,
    dependencies
  );
}

async function executeFactoryBrokerOpenDraft(
  configPath: string,
  taskId: string,
  expectedPolicyBundleDigest: Sha256Digest,
  command: Readonly<Record<string, unknown>>,
  canary: CanaryBrokerCoordinates | null,
  dependencies: FactoryBrokerOpenDraftRunnerDependencies
): Promise<number> {
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
      const outcome = await runtime.commands.openDraft(command);
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
  dependencies.write(`${serializeResult(preflight, taskId, result, canary)}\n`);
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

function assertCanaryCommandInput(
  configPath: string,
  taskId: string,
  reservationDigest: string,
  schedulePolicyDigest: string,
  roleIdentityPolicyDigest: string,
  expectedPolicyBundleDigest: string
): CanaryBrokerCoordinates {
  if (!isNormalizedAbsolutePath(configPath)) {
    throw new Error("Factory canary broker command requires a normalized absolute config path.");
  }
  if (!isFactoryTaskId(taskId)) throw new Error("Factory canary broker task ID is invalid.");
  for (const [label, digest] of [
    ["reservation", reservationDigest],
    ["schedule policy", schedulePolicyDigest],
    ["role policy", roleIdentityPolicyDigest],
    ["factory policy", expectedPolicyBundleDigest]
  ] as const) {
    if (!isSha256Digest(digest)) {
      throw new Error(`Factory canary broker ${label} digest is invalid.`);
    }
  }
  return {
    reservationDigest,
    schedulePolicyDigest,
    roleIdentityPolicyDigest
  };
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
  result: BrokerDraftResult,
  canary: CanaryBrokerCoordinates | null
): string {
  const opened = result.outcome?.status === "opened" ? result.outcome.record : null;
  return JSON.stringify({
    schemaVersion:
      canary === null
        ? "agentlab.broker-open-draft-result.v1"
        : "agentlab.broker-open-canary-draft-result.v1",
    status: result.status,
    taskId,
    policyBundleDigest: preflight.policyBundleDigest,
    repository: {
      repositoryId: preflight.repository.repositoryId,
      baseBranch: preflight.repository.baseBranch,
      baseRevision: preflight.repository.baseRevision
    },
    reasonCodes: [...new Set(result.reasonCodes)].sort(),
    ...(canary === null ? {} : { canary }),
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
