import type { FactoryEvalProductionJob, Sha256Digest } from "@agentlab/contracts";
import {
  createConfiguredLocalFactoryEvalProducer,
  loadLocalFactoryEvalProducerConfig,
  loadLocalFactoryEvalProductionJob,
  type LocalFactoryEvalProducerConfig,
  type LocalFactoryEvalProducerRuntime
} from "@agentlab/runtime/factory-eval-producer";

import { isNormalizedAbsolutePath, isSha256Digest } from "./factory-cli-input.js";

export interface FactoryEvalProducerRunnerDependencies {
  readonly loadConfig: (path: string) => Promise<LocalFactoryEvalProducerConfig>;
  readonly loadJob: (path: string) => Promise<FactoryEvalProductionJob>;
  readonly createRuntime: (
    config: LocalFactoryEvalProducerConfig
  ) => LocalFactoryEvalProducerRuntime;
  readonly write: (message: string) => void;
}

const defaultDependencies: FactoryEvalProducerRunnerDependencies = {
  loadConfig: loadLocalFactoryEvalProducerConfig,
  loadJob: loadLocalFactoryEvalProductionJob,
  createRuntime: createConfiguredLocalFactoryEvalProducer,
  write: (message) => process.stdout.write(message)
};

export async function runFactoryEvalProducerPreflight(
  configPath: string,
  jobPath: string,
  expectedJobDigest: string,
  dependencies: FactoryEvalProducerRunnerDependencies = defaultDependencies
): Promise<number> {
  const input = validateInput(configPath, jobPath, expectedJobDigest);
  const [config, job] = await Promise.all([
    dependencies.loadConfig(input.configPath),
    dependencies.loadJob(input.jobPath)
  ]);
  const runtime = dependencies.createRuntime(config);
  const result = await runtime.commands
    .preflight(job, input.expectedJobDigest)
    .catch((error: unknown) => closeAfterFailure(runtime, error));
  await runtime.close();
  dependencies.write(
    `${JSON.stringify({ schemaVersion: "agentlab.eval-producer-preflight-result.v1", status: "ready", ...result })}\n`
  );
  return 0;
}

export async function runFactoryEvalProduce(
  configPath: string,
  jobPath: string,
  expectedJobDigest: string,
  dependencies: FactoryEvalProducerRunnerDependencies = defaultDependencies
): Promise<number> {
  const input = validateInput(configPath, jobPath, expectedJobDigest);
  const [config, job] = await Promise.all([
    dependencies.loadConfig(input.configPath),
    dependencies.loadJob(input.jobPath)
  ]);
  const runtime = dependencies.createRuntime(config);
  const result = await runtime.commands
    .produce(job, input.expectedJobDigest)
    .catch((error: unknown) => closeAfterFailure(runtime, error));
  await runtime.close();
  dependencies.write(`${JSON.stringify(result)}\n`);
  return result.state === "completed" ? 0 : 1;
}

function validateInput(configPath: string, jobPath: string, expectedJobDigest: string) {
  if (!isNormalizedAbsolutePath(configPath)) {
    throw new Error("Factory eval production requires a normalized absolute config path.");
  }
  if (!isNormalizedAbsolutePath(jobPath)) {
    throw new Error("Factory eval production requires a normalized absolute job path.");
  }
  if (!isSha256Digest(expectedJobDigest)) {
    throw new Error("Factory eval production expected job digest is invalid.");
  }
  return {
    configPath,
    jobPath,
    expectedJobDigest: expectedJobDigest as Sha256Digest
  };
}

async function closeAfterFailure(
  runtime: LocalFactoryEvalProducerRuntime,
  primaryError: unknown
): Promise<never> {
  try {
    await runtime.close();
  } catch (cleanupError: unknown) {
    throw new AggregateError(
      [primaryError, cleanupError],
      "Factory eval production and cleanup both failed.",
      { cause: primaryError }
    );
  }
  throw primaryError;
}
