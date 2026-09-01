import {
  createConfiguredLocalFactoryExternalPullRequestDiscovery,
  createLocalFactoryExternalPullRequestDiscovery,
  loadLocalFactoryExternalPullRequestDiscoveryConfig,
  type FactoryExternalPullRequestDiscoveryCommandPort,
  type LocalFactoryExternalPullRequestDiscoveryConfig,
  type LocalFactoryExternalPullRequestDiscoveryOptions,
  type LocalFactoryExternalPullRequestDiscoveryRuntime
} from "@agentlab/runtime/factory-external-pull-request-discovery";
// @ts-expect-error PR discovery must not be exported by the interactive runtime.
import { createLocalFactoryExternalPullRequestDiscovery as forbiddenInteractiveReader } from "@agentlab/runtime";
// @ts-expect-error Read inventory must not be exported by the write-capable broker.
import { createLocalFactoryExternalPullRequestDiscovery as forbiddenBrokerReader } from "@agentlab/runtime/factory-broker";
// @ts-expect-error Remote credentials must not be exported by a model-bearing worker.
import { createLocalFactoryExternalPullRequestDiscovery as forbiddenWorkerReader } from "@agentlab/runtime/factory-worker";
// @ts-expect-error External PR discovery must not expose broker draft creation.
import { createLocalFactoryBroker as forbiddenBroker } from "@agentlab/runtime/factory-external-pull-request-discovery";

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

export type FactoryExternalPullRequestDiscoveryPublicApiAssertions = [
  Assert<Equal<keyof FactoryExternalPullRequestDiscoveryCommandPort, "preflight" | "tick">>,
  Assert<Equal<keyof LocalFactoryExternalPullRequestDiscoveryRuntime, "commands" | "close">>,
  Assert<
    Equal<
      typeof createLocalFactoryExternalPullRequestDiscovery,
      (
        options: LocalFactoryExternalPullRequestDiscoveryOptions
      ) => LocalFactoryExternalPullRequestDiscoveryRuntime
    >
  >,
  Assert<
    Equal<
      typeof createConfiguredLocalFactoryExternalPullRequestDiscovery,
      (
        config: LocalFactoryExternalPullRequestDiscoveryConfig
      ) => LocalFactoryExternalPullRequestDiscoveryRuntime
    >
  >,
  Assert<
    Equal<
      typeof loadLocalFactoryExternalPullRequestDiscoveryConfig,
      (pathInput: string) => Promise<LocalFactoryExternalPullRequestDiscoveryConfig>
    >
  >
];

void forbiddenInteractiveReader;
void forbiddenBrokerReader;
void forbiddenWorkerReader;
void forbiddenBroker;
