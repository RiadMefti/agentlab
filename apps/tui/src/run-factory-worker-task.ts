import { randomUUID } from "node:crypto";

import type { Sha256Digest } from "@agentlab/contracts";
import {
  createConfiguredLocalFactoryWorker,
  loadLocalFactoryWorkerConfig,
  type FactoryWorkerPreflight,
  type FactoryWorkerTaskRunReport,
  type LocalFactoryWorkerConfig,
  type LocalFactoryWorkerRuntime
} from "@agentlab/runtime/factory-worker";

import { isFactoryTaskId, isNormalizedAbsolutePath, isSha256Digest } from "./factory-cli-input.js";

export interface FactoryWorkerTaskRunnerDependencies {
  readonly loadConfig: (path: string) => Promise<LocalFactoryWorkerConfig>;
  readonly createRuntime: (config: LocalFactoryWorkerConfig) => LocalFactoryWorkerRuntime;
  readonly createCorrelationId: () => string;
  readonly write: (message: string) => void;
}

const defaultDependencies: FactoryWorkerTaskRunnerDependencies = {
  loadConfig: loadLocalFactoryWorkerConfig,
  createRuntime: createConfiguredLocalFactoryWorker,
  createCorrelationId: randomUUID,
  write: (message) => process.stdout.write(message)
};

/** Runs one confirmed local task to a broker-ready proposal without any remote-write capability. */
export async function runFactoryWorkerTask(
  configPath: string,
  taskId: string,
  expectedPolicyBundleDigest: string,
  confirmation: string,
  dependencies: FactoryWorkerTaskRunnerDependencies = defaultDependencies
): Promise<number> {
  assertCommandInput(configPath, taskId, expectedPolicyBundleDigest, confirmation);
  const config = await dependencies.loadConfig(configPath);
  const runtime = dependencies.createRuntime(config);
  let preflight: FactoryWorkerPreflight;
  let report: FactoryWorkerTaskRunReport | null = null;
  let reasonCodes: readonly string[];
  try {
    preflight = await runtime.commands.preflight();
    reasonCodes = [
      ...preflight.reasonCodes.filter((reasonCode) => reasonCode !== "scheduler-disabled"),
      ...(preflight.policyBundleDigest === expectedPolicyBundleDigest
        ? []
        : ["policy-bundle-digest-mismatch"])
    ];
    if (reasonCodes.length === 0) {
      const correlationId = dependencies.createCorrelationId();
      report = await runtime.commands.runTask({
        taskId,
        correlationId,
        expectedPolicyBundleDigest
      });
      assertReportIdentity(report, preflight, taskId, correlationId);
      reasonCodes = report.reasonCodes;
    }
  } catch (error: unknown) {
    return closeAfterFailure(runtime, error);
  }
  await runtime.close();
  dependencies.write(`${serializeResult(preflight, taskId, report, reasonCodes)}\n`);
  return report?.status === "ready-for-broker" || report?.status === "already-advanced" ? 0 : 2;
}

function assertCommandInput(
  configPath: string,
  taskId: string,
  expectedPolicyBundleDigest: string,
  confirmation: string
): asserts expectedPolicyBundleDigest is Sha256Digest {
  if (!isNormalizedAbsolutePath(configPath)) {
    throw new Error("Factory worker command requires a normalized absolute config path.");
  }
  if (!isFactoryTaskId(taskId)) throw new Error("Factory worker command task ID is invalid.");
  if (!isSha256Digest(expectedPolicyBundleDigest)) {
    throw new Error("Factory worker command policy digest is invalid.");
  }
  if (confirmation !== "run-task") {
    throw new Error("Factory worker command requires explicit run confirmation.");
  }
}

function assertReportIdentity(
  report: FactoryWorkerTaskRunReport,
  preflight: FactoryWorkerPreflight,
  taskId: string,
  correlationId: string
): void {
  if (
    report.taskId !== taskId ||
    report.correlationId !== correlationId ||
    report.policyBundleDigest !== preflight.policyBundleDigest ||
    (report.taskState === null) !== (report.contractDigest === null)
  ) {
    throw new Error("Factory worker result does not match the confirmed command or preflight.");
  }
}

function serializeResult(
  preflight: FactoryWorkerPreflight,
  taskId: string,
  report: FactoryWorkerTaskRunReport | null,
  reasonCodes: readonly string[]
): string {
  return JSON.stringify({
    schemaVersion: "agentlab.worker-run-command-result.v1",
    status: report?.status ?? "blocked",
    taskId,
    policyBundleDigest: preflight.policyBundleDigest,
    reasonCodes: [...new Set(reasonCodes)].sort(),
    run:
      report === null
        ? null
        : {
            schemaVersion: report.schemaVersion,
            correlationId: report.correlationId,
            preparationState: report.preparationState,
            taskState: report.taskState,
            contractDigest: report.contractDigest
          }
  });
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
      "Factory worker command and cleanup both failed.",
      { cause: primaryError }
    );
  }
  throw primaryError;
}
