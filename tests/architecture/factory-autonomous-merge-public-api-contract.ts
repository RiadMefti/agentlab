import {
  createConfiguredLocalFactoryAutonomousMergeAdmission,
  createLocalFactoryAutonomousMergeAdmission,
  loadLocalFactoryAutonomousMergeAdmissionConfig,
  type FactoryAutonomousMergeAdmissionCommandPort,
  type LocalFactoryAutonomousMergeAdmissionConfig,
  type LocalFactoryAutonomousMergeAdmissionOptions,
  type LocalFactoryAutonomousMergeAdmissionRuntime
} from "@agentlab/runtime/factory-autonomous-merge-admission";
import {
  createConfiguredLocalFactoryAutonomousMerger,
  createLocalFactoryAutonomousMerger,
  loadLocalFactoryAutonomousMergerConfig,
  type FactoryAutonomousMergerCommandPort,
  type LocalFactoryAutonomousMergerConfig,
  type LocalFactoryAutonomousMergerOptions,
  type LocalFactoryAutonomousMergerRuntime
} from "@agentlab/runtime/factory-autonomous-merger";
// @ts-expect-error Autonomous merge admission must not be exported by the interactive runtime.
import { createLocalFactoryAutonomousMergeAdmission as forbiddenInteractiveAdmission } from "@agentlab/runtime";
// @ts-expect-error The merger must not be exported by the model-bearing worker.
import { createLocalFactoryAutonomousMerger as forbiddenWorkerMerger } from "@agentlab/runtime/factory-worker";
// @ts-expect-error The merger must not be exported by the PR broker.
import { createLocalFactoryAutonomousMerger as forbiddenPrBrokerMerger } from "@agentlab/runtime/factory-broker";
// @ts-expect-error Credentialless admission must not expose merger construction.
import { createLocalFactoryAutonomousMerger as forbiddenAdmissionMerger } from "@agentlab/runtime/factory-autonomous-merge-admission";

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

export type FactoryAutonomousMergePublicApiAssertions = [
  Assert<Equal<keyof FactoryAutonomousMergeAdmissionCommandPort, "preflight" | "admit" | "tick">>,
  Assert<Equal<keyof LocalFactoryAutonomousMergeAdmissionRuntime, "commands" | "close">>,
  Assert<Equal<keyof FactoryAutonomousMergerCommandPort, "preflight" | "tick">>,
  Assert<Equal<keyof LocalFactoryAutonomousMergerRuntime, "commands" | "close">>,
  Assert<
    Equal<
      typeof createLocalFactoryAutonomousMergeAdmission,
      (
        options: LocalFactoryAutonomousMergeAdmissionOptions
      ) => LocalFactoryAutonomousMergeAdmissionRuntime
    >
  >,
  Assert<
    Equal<
      typeof createConfiguredLocalFactoryAutonomousMergeAdmission,
      (
        config: LocalFactoryAutonomousMergeAdmissionConfig
      ) => LocalFactoryAutonomousMergeAdmissionRuntime
    >
  >,
  Assert<
    Equal<
      typeof loadLocalFactoryAutonomousMergeAdmissionConfig,
      (pathInput: string) => Promise<LocalFactoryAutonomousMergeAdmissionConfig>
    >
  >,
  Assert<
    Equal<
      typeof createLocalFactoryAutonomousMerger,
      (options: LocalFactoryAutonomousMergerOptions) => LocalFactoryAutonomousMergerRuntime
    >
  >,
  Assert<
    Equal<
      typeof createConfiguredLocalFactoryAutonomousMerger,
      (config: LocalFactoryAutonomousMergerConfig) => LocalFactoryAutonomousMergerRuntime
    >
  >,
  Assert<
    Equal<
      typeof loadLocalFactoryAutonomousMergerConfig,
      (pathInput: string) => Promise<LocalFactoryAutonomousMergerConfig>
    >
  >
];

void forbiddenInteractiveAdmission;
void forbiddenWorkerMerger;
void forbiddenPrBrokerMerger;
void forbiddenAdmissionMerger;
