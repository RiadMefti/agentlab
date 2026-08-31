import type { FactoryEvalRun } from "@agentlab/contracts";
import {
  createConfiguredLocalFactoryEvaluator,
  createLocalFactoryEvaluator,
  loadLocalFactoryEvalRun,
  loadLocalFactoryEvaluatorConfig,
  type FactoryEvaluatorCommandPort,
  type LocalFactoryEvaluatorConfig,
  type LocalFactoryEvaluatorOptions,
  type LocalFactoryEvaluatorRuntime
} from "@agentlab/runtime/factory-evaluator";
// @ts-expect-error Eval assessment must not be exported by the interactive runtime.
import { createLocalFactoryEvaluator as forbiddenInteractiveEvaluator } from "@agentlab/runtime";
// @ts-expect-error Eval assessment must not be exported by the credential-bearing broker.
import { createLocalFactoryEvaluator as forbiddenBrokerEvaluator } from "@agentlab/runtime/factory-broker";
// @ts-expect-error Eval assessment must not be exported by the model-bearing worker.
import { createLocalFactoryEvaluator as forbiddenWorkerEvaluator } from "@agentlab/runtime/factory-worker";
// @ts-expect-error Human canary authority must not be reachable through the evaluator.
import { createLocalFactoryCanaryAuthority as forbiddenCanaryAuthority } from "@agentlab/runtime/factory-evaluator";

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
  schemaVersion: "agentlab.local-factory-evaluator.v2";
  databasePath: string;
  runnerId: string;
  trustedPublicKeyPath: string;
  trustedKeyId: string;
  maximumIssuanceDelaySeconds: number;
  maximumAttestationLifetimeSeconds: number;
}

interface ExpectedOptions {
  readonly databasePath: string;
  readonly runnerId: string;
  readonly trustedPublicKeyPath: string;
  readonly trustedKeyId: string;
  readonly maximumIssuanceDelaySeconds: number;
  readonly maximumAttestationLifetimeSeconds: number;
  readonly now?: () => string;
  readonly createId?: () => string;
}

export type FactoryEvaluatorPublicApiAssertions = [
  Assert<Equal<LocalFactoryEvaluatorConfig, ExpectedConfig>>,
  Assert<Equal<LocalFactoryEvaluatorOptions, ExpectedOptions>>,
  Assert<Equal<keyof FactoryEvaluatorCommandPort, "assess" | "attest" | "inspect">>,
  Assert<Equal<keyof LocalFactoryEvaluatorRuntime, "commands" | "close">>,
  Assert<
    Equal<
      typeof createLocalFactoryEvaluator,
      (options: LocalFactoryEvaluatorOptions) => LocalFactoryEvaluatorRuntime
    >
  >,
  Assert<
    Equal<
      typeof createConfiguredLocalFactoryEvaluator,
      (config: LocalFactoryEvaluatorConfig) => LocalFactoryEvaluatorRuntime
    >
  >,
  Assert<
    Equal<
      typeof loadLocalFactoryEvaluatorConfig,
      (pathInput: string) => Promise<LocalFactoryEvaluatorConfig>
    >
  >,
  Assert<Equal<typeof loadLocalFactoryEvalRun, (pathInput: string) => Promise<FactoryEvalRun>>>
];

void forbiddenInteractiveEvaluator;
void forbiddenBrokerEvaluator;
void forbiddenWorkerEvaluator;
void forbiddenCanaryAuthority;
