import type {
  FactoryEvalProductionJob,
  FactoryEvalProductionResult,
  Sha256Digest
} from "@agentlab/contracts";
import {
  createConfiguredLocalFactoryEvalProducer,
  createLocalFactoryEvalProducer,
  loadLocalFactoryEvalProducerConfig,
  loadLocalFactoryEvalProductionJob,
  type FactoryEvalProducerCommandPort,
  type LocalFactoryEvalProducerConfig,
  type LocalFactoryEvalProducerOptions,
  type LocalFactoryEvalProducerRuntime
} from "@agentlab/runtime/factory-eval-producer";
// @ts-expect-error Eval execution must not be exported by the interactive runtime.
import { createLocalFactoryEvalProducer as forbiddenInteractiveProducer } from "@agentlab/runtime";
// @ts-expect-error Eval execution must not be exported by the credential-bearing broker.
import { createLocalFactoryEvalProducer as forbiddenBrokerProducer } from "@agentlab/runtime/factory-broker";
// @ts-expect-error Eval execution must not be exported by the model-bearing worker.
import { createLocalFactoryEvalProducer as forbiddenWorkerProducer } from "@agentlab/runtime/factory-worker";
// @ts-expect-error Signing authority must not be reachable through the producer.
import { createLocalFactoryEvalAttestor as forbiddenAttestor } from "@agentlab/runtime/factory-eval-producer";
// @ts-expect-error Human canary authority must not be reachable through the producer.
import { createLocalFactoryCanaryAuthority as forbiddenCanaryAuthority } from "@agentlab/runtime/factory-eval-producer";

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

export type FactoryEvalProducerPublicApiAssertions = [
  Assert<Equal<keyof FactoryEvalProducerCommandPort, "preflight" | "produce">>,
  Assert<Equal<keyof LocalFactoryEvalProducerRuntime, "commands" | "close">>,
  Assert<
    Equal<
      FactoryEvalProducerCommandPort["preflight"],
      (
        job: unknown,
        expectedJobDigest: Sha256Digest
      ) => Promise<{ readonly jobId: string; readonly jobDigest: Sha256Digest }>
    >
  >,
  Assert<
    Equal<
      FactoryEvalProducerCommandPort["produce"],
      (job: unknown, expectedJobDigest: Sha256Digest) => Promise<FactoryEvalProductionResult>
    >
  >,
  Assert<
    Equal<
      typeof createLocalFactoryEvalProducer,
      (options: LocalFactoryEvalProducerOptions) => LocalFactoryEvalProducerRuntime
    >
  >,
  Assert<
    Equal<
      typeof createConfiguredLocalFactoryEvalProducer,
      (config: LocalFactoryEvalProducerConfig) => LocalFactoryEvalProducerRuntime
    >
  >,
  Assert<
    Equal<
      typeof loadLocalFactoryEvalProducerConfig,
      (pathInput: string) => Promise<LocalFactoryEvalProducerConfig>
    >
  >,
  Assert<
    Equal<
      typeof loadLocalFactoryEvalProductionJob,
      (pathInput: string) => Promise<FactoryEvalProductionJob>
    >
  >
];

void forbiddenInteractiveProducer;
void forbiddenBrokerProducer;
void forbiddenWorkerProducer;
void forbiddenAttestor;
void forbiddenCanaryAuthority;
