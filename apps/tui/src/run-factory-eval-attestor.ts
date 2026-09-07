import type { FactoryEvalRun, FactorySignedEvalAttestation } from "@agentlab/contracts";
import {
  createConfiguredLocalFactoryEvalAttestor,
  loadLocalFactoryEvalAttestorConfig,
  loadLocalFactoryEvalRun,
  type LocalFactoryEvalAttestorConfig,
  type LocalFactoryEvalAttestorRuntime
} from "@agentlab/runtime/factory-eval-attestor";

import { isNormalizedAbsolutePath } from "./factory-cli-input.js";

export interface FactoryEvalAttestorRunnerDependencies {
  readonly loadConfig: (path: string) => Promise<LocalFactoryEvalAttestorConfig>;
  readonly loadRun: (path: string) => Promise<FactoryEvalRun>;
  readonly createRuntime: (
    config: LocalFactoryEvalAttestorConfig
  ) => LocalFactoryEvalAttestorRuntime;
  readonly write: (message: string) => void;
}

const defaultDependencies: FactoryEvalAttestorRunnerDependencies = {
  loadConfig: loadLocalFactoryEvalAttestorConfig,
  loadRun: loadLocalFactoryEvalRun,
  createRuntime: createConfiguredLocalFactoryEvalAttestor,
  write: (message) => process.stdout.write(message)
};

/** Emits one portable signed artifact; the isolated runtime has no ledger or remote capability. */
export async function runFactoryEvalSign(
  configPath: string,
  runPath: string,
  confirmation: string,
  dependencies: FactoryEvalAttestorRunnerDependencies = defaultDependencies
): Promise<number> {
  if (!isNormalizedAbsolutePath(configPath)) {
    throw new Error("Factory eval signing requires a normalized absolute config path.");
  }
  if (!isNormalizedAbsolutePath(runPath)) {
    throw new Error("Factory eval signing requires a normalized absolute run path.");
  }
  if (confirmation !== "sign-eval") {
    throw new Error("Factory eval signing requires explicit confirmation.");
  }
  const [config, run] = await Promise.all([
    dependencies.loadConfig(configPath),
    dependencies.loadRun(runPath)
  ]);
  const runtime = dependencies.createRuntime(config);
  const signed = await runtime.commands
    .sign(run)
    .catch((error: unknown) => closeAfterFailure(runtime, error));
  await runtime.close();
  dependencies.write(`${serializeSignedAttestation(signed)}\n`);
  return 0;
}

function serializeSignedAttestation(attestation: FactorySignedEvalAttestation): string {
  return JSON.stringify(attestation);
}

async function closeAfterFailure(
  runtime: LocalFactoryEvalAttestorRuntime,
  primaryError: unknown
): Promise<never> {
  try {
    await runtime.close();
  } catch (cleanupError: unknown) {
    throw new AggregateError(
      [primaryError, cleanupError],
      "Factory eval signing and cleanup both failed.",
      { cause: primaryError }
    );
  }
  throw primaryError;
}
