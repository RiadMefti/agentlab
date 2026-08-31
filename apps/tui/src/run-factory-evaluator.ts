import {
  createConfiguredLocalFactoryEvaluator,
  loadLocalFactoryEvalRun,
  loadLocalFactoryEvaluatorConfig,
  type FactoryEvalSnapshot,
  type LocalFactoryEvaluatorConfig,
  type LocalFactoryEvaluatorRuntime
} from "@agentlab/runtime/factory-evaluator";
import type { FactoryEvalRun } from "@agentlab/contracts";

import { isNormalizedAbsolutePath, isSha256Digest } from "./factory-cli-input.js";

export interface FactoryEvaluatorRunnerDependencies {
  readonly loadConfig: (path: string) => Promise<LocalFactoryEvaluatorConfig>;
  readonly loadRun: (path: string) => Promise<FactoryEvalRun>;
  readonly createRuntime: (config: LocalFactoryEvaluatorConfig) => LocalFactoryEvaluatorRuntime;
  readonly write: (message: string) => void;
}

const defaultDependencies: FactoryEvaluatorRunnerDependencies = {
  loadConfig: loadLocalFactoryEvaluatorConfig,
  loadRun: loadLocalFactoryEvalRun,
  createRuntime: createConfiguredLocalFactoryEvaluator,
  write: (message) => process.stdout.write(message)
};

/** Records and assesses one complete owner-confirmed matched eval report. */
export async function runFactoryEvalAssess(
  configPath: string,
  runPath: string,
  confirmation: string,
  dependencies: FactoryEvaluatorRunnerDependencies = defaultDependencies
): Promise<number> {
  if (!isNormalizedAbsolutePath(configPath)) {
    throw new Error("Factory eval assessment requires a normalized absolute config path.");
  }
  if (!isNormalizedAbsolutePath(runPath)) {
    throw new Error("Factory eval assessment requires a normalized absolute run path.");
  }
  if (confirmation !== "assess-eval") {
    throw new Error("Factory eval assessment requires explicit confirmation.");
  }
  const [config, run] = await Promise.all([
    dependencies.loadConfig(configPath),
    dependencies.loadRun(runPath)
  ]);
  const runtime = dependencies.createRuntime(config);
  const snapshot = await runtime.commands
    .assess(run)
    .catch((error: unknown) => closeAfterFailure(runtime, error));
  await runtime.close();
  dependencies.write(`${serializeEvaluation("assessed", snapshot)}\n`);
  return 0;
}

/** Reads one deterministic assessment without loading run samples into command output. */
export async function runFactoryEvalInspect(
  configPath: string,
  assessmentDigest: string,
  dependencies: Omit<FactoryEvaluatorRunnerDependencies, "loadRun"> = defaultDependencies
): Promise<number> {
  if (!isNormalizedAbsolutePath(configPath)) {
    throw new Error("Factory eval inspection requires a normalized absolute config path.");
  }
  if (!isSha256Digest(assessmentDigest)) {
    throw new Error("Factory eval inspection assessment digest is invalid.");
  }
  const config = await dependencies.loadConfig(configPath);
  const runtime = dependencies.createRuntime(config);
  const snapshot = await runtime.commands
    .inspect({ assessmentDigest })
    .catch((error: unknown) => closeAfterFailure(runtime, error));
  await runtime.close();
  dependencies.write(`${serializeEvaluation("inspected", snapshot)}\n`);
  return 0;
}

function serializeEvaluation(status: "assessed" | "inspected", snapshot: FactoryEvalSnapshot) {
  return JSON.stringify({
    schemaVersion: "agentlab.eval-command-result.v1",
    status,
    run: {
      runId: snapshot.run.runId,
      runDigest: snapshot.runDigest,
      suiteDigest: snapshot.run.suiteDigest,
      repositoryId: snapshot.run.challengerCandidate.repositoryId,
      baseRevision: snapshot.run.challengerCandidate.baseRevision,
      baselineCandidate: {
        id: snapshot.run.baselineCandidate.candidateId,
        version: snapshot.run.baselineCandidate.version,
        digest: snapshot.run.baselineCandidateDigest
      },
      challengerCandidate: {
        id: snapshot.run.challengerCandidate.candidateId,
        version: snapshot.run.challengerCandidate.version,
        digest: snapshot.run.challengerCandidateDigest
      },
      sampleCount: snapshot.run.samples.length,
      startedAt: snapshot.run.startedAt,
      completedAt: snapshot.run.completedAt,
      correlationId: snapshot.run.correlationId
    },
    assessment: {
      assessmentId: snapshot.assessment.assessmentId,
      assessmentDigest: snapshot.assessmentDigest,
      assessedAt: snapshot.assessment.assessedAt,
      decision: snapshot.assessment.decision,
      maximumEligibleStage: snapshot.assessment.maximumEligibleStage,
      metrics: snapshot.assessment.metrics,
      reasonCodes: snapshot.assessment.reasonCodes
    }
  });
}

async function closeAfterFailure(
  runtime: LocalFactoryEvaluatorRuntime,
  primaryError: unknown
): Promise<never> {
  try {
    await runtime.close();
  } catch (cleanupError: unknown) {
    throw new AggregateError(
      [primaryError, cleanupError],
      "Factory evaluator operation and cleanup both failed.",
      { cause: primaryError }
    );
  }
  throw primaryError;
}
