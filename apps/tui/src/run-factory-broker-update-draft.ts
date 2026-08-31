import type { Sha256Digest } from "@agentlab/contracts";
import {
  createConfiguredLocalFactoryBroker,
  loadLocalFactoryBrokerConfig,
  type FactoryBrokerPreflight,
  type LocalFactoryBrokerConfig,
  type LocalFactoryBrokerRuntime
} from "@agentlab/runtime/factory-broker";

import { isFactoryTaskId, isNormalizedAbsolutePath, isSha256Digest } from "./factory-cli-input.js";

type UpdateOutcome = Awaited<
  ReturnType<LocalFactoryBrokerRuntime["commands"]["updatePullRequest"]>
>;

export interface FactoryBrokerUpdateDraftRunnerDependencies {
  readonly loadConfig: (path: string) => Promise<LocalFactoryBrokerConfig>;
  readonly createRuntime: (config: LocalFactoryBrokerConfig) => LocalFactoryBrokerRuntime;
  readonly write: (message: string) => void;
}

const defaultDependencies: FactoryBrokerUpdateDraftRunnerDependencies = {
  loadConfig: loadLocalFactoryBrokerConfig,
  createRuntime: createConfiguredLocalFactoryBroker,
  write: (message) => process.stdout.write(message)
};

interface CommandResult {
  readonly status: "updated" | "blocked" | "denied" | "needs-human";
  readonly reasonCodes: readonly string[];
  readonly outcome: UpdateOutcome | null;
}

/** Advances one exact repaired draft branch after clean readiness and literal confirmation. */
export async function runFactoryBrokerUpdateDraft(
  configPath: string,
  taskId: string,
  authorizationDigest: string,
  expectedPolicyBundleDigest: string,
  confirmation: string,
  dependencies: FactoryBrokerUpdateDraftRunnerDependencies = defaultDependencies
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
  let preflight: FactoryBrokerPreflight;
  let result: CommandResult;
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
      const outcome = await runtime.commands.updatePullRequest({
        taskId,
        authorizationDigest
      });
      assertOutcomeIdentity(outcome, preflight, taskId, authorizationDigest);
      result = {
        status: outcome.status,
        reasonCodes: outcome.status === "updated" ? [] : outcome.reasonCodes,
        outcome
      };
    }
  } catch (error: unknown) {
    return closeAfterFailure(runtime, error);
  }
  await runtime.close();
  dependencies.write(`${serializeResult(preflight, taskId, authorizationDigest, result)}\n`);
  return result.status === "updated" ? 0 : 2;
}

function assertCommandInput(
  configPath: string,
  taskId: string,
  authorizationDigest: string,
  expectedPolicyBundleDigest: string,
  confirmation: string
): asserts authorizationDigest is Sha256Digest {
  if (!isNormalizedAbsolutePath(configPath)) {
    throw new Error("Factory broker update requires a normalized absolute config path.");
  }
  if (!isFactoryTaskId(taskId)) throw new Error("Factory broker update task ID is invalid.");
  if (!isSha256Digest(authorizationDigest)) {
    throw new Error("Factory broker update authorization digest is invalid.");
  }
  if (!isSha256Digest(expectedPolicyBundleDigest)) {
    throw new Error("Factory broker update policy digest is invalid.");
  }
  if (confirmation !== "confirm-update") {
    throw new Error("Factory broker update requires explicit update confirmation.");
  }
}

function assertOutcomeIdentity(
  outcome: UpdateOutcome,
  preflight: FactoryBrokerPreflight,
  taskId: string,
  authorizationDigest: Sha256Digest
): void {
  if (
    outcome.status === "updated" &&
    (outcome.record.taskId !== taskId ||
      outcome.record.repositoryId !== preflight.repository.repositoryId ||
      outcome.record.repairAuthorizationDigest !== authorizationDigest)
  ) {
    throw new Error("Factory broker update result does not match its confirmed command.");
  }
}

function serializeResult(
  preflight: FactoryBrokerPreflight,
  taskId: string,
  authorizationDigest: Sha256Digest,
  result: CommandResult
): string {
  const updated = result.outcome?.status === "updated" ? result.outcome.record : null;
  return JSON.stringify({
    schemaVersion: "agentlab.broker-update-draft-result.v1",
    status: result.status,
    taskId,
    authorizationDigest,
    policyBundleDigest: preflight.policyBundleDigest,
    repositoryId: preflight.repository.repositoryId,
    reasonCodes: [...new Set(result.reasonCodes)].sort(),
    pullRequest:
      updated === null
        ? null
        : {
            number: updated.number,
            url: updated.url,
            branchName: updated.branchName,
            baseRevision: updated.baseRevision,
            priorHeadRevision: updated.priorHeadRevision,
            headRevision: updated.headRevision,
            updateProposalDigest: updated.updateProposalDigest,
            repairedPatchProposalDigest: updated.repairedPatchProposalDigest,
            contractRepairAttempt: updated.contractRepairAttempt,
            draft: updated.draft
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
      "Factory broker update and cleanup both failed.",
      { cause: primaryError }
    );
  }
  throw primaryError;
}
