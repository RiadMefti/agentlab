import type { FactoryEvalRun } from "@agentlab/contracts";
import {
  createConfiguredLocalFactoryEvalAttestor,
  createLocalFactoryEvalAttestor,
  loadLocalFactoryEvalAttestorConfig,
  loadLocalFactoryEvalRun,
  type FactoryEvalAttestorCommandPort,
  type LocalFactoryEvalAttestorConfig,
  type LocalFactoryEvalAttestorOptions,
  type LocalFactoryEvalAttestorRuntime
} from "@agentlab/runtime/factory-eval-attestor";
// @ts-expect-error Signing must not be exported by the interactive runtime.
import { createLocalFactoryEvalAttestor as forbiddenInteractiveAttestor } from "@agentlab/runtime";
// @ts-expect-error Signing must not be exported by the verifier/evaluator runtime.
import { createLocalFactoryEvalAttestor as forbiddenEvaluatorAttestor } from "@agentlab/runtime/factory-evaluator";
// @ts-expect-error Database-backed evaluation must not be reachable through the signer.
import { createLocalFactoryEvaluator as forbiddenAttestorEvaluator } from "@agentlab/runtime/factory-eval-attestor";

type Equal<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? [keyof Left] extends [keyof Right]
      ? [keyof Right] extends [keyof Left]
        ? true
        : false
      : false
    : false
  : false;
type Assert<Value extends true> = Value;

interface ExpectedConfig {
  schemaVersion: "agentlab.local-factory-eval-attestor.v1";
  runnerId: string;
  privateKeyPath: string;
  keyId: string;
  attestationLifetimeSeconds: number;
  maximumIssuanceDelaySeconds: number;
}

interface ExpectedOptions {
  readonly runnerId: string;
  readonly privateKeyPath: string;
  readonly keyId: string;
  readonly attestationLifetimeSeconds: number;
  readonly maximumIssuanceDelaySeconds: number;
  readonly now?: () => string;
}

export type FactoryEvalAttestorPublicApiAssertions = [
  Assert<Equal<LocalFactoryEvalAttestorConfig, ExpectedConfig>>,
  Assert<Equal<LocalFactoryEvalAttestorOptions, ExpectedOptions>>,
  Assert<Equal<keyof FactoryEvalAttestorCommandPort, "sign">>,
  Assert<Equal<keyof LocalFactoryEvalAttestorRuntime, "commands" | "close">>,
  Assert<
    Equal<
      typeof createLocalFactoryEvalAttestor,
      (options: LocalFactoryEvalAttestorOptions) => LocalFactoryEvalAttestorRuntime
    >
  >,
  Assert<
    Equal<
      typeof createConfiguredLocalFactoryEvalAttestor,
      (config: LocalFactoryEvalAttestorConfig) => LocalFactoryEvalAttestorRuntime
    >
  >,
  Assert<
    Equal<
      typeof loadLocalFactoryEvalAttestorConfig,
      (pathInput: string) => Promise<LocalFactoryEvalAttestorConfig>
    >
  >,
  Assert<Equal<typeof loadLocalFactoryEvalRun, (pathInput: string) => Promise<FactoryEvalRun>>>
];

void forbiddenInteractiveAttestor;
void forbiddenEvaluatorAttestor;
void forbiddenAttestorEvaluator;
