import {
  createConfiguredLocalFactoryMaintenanceDiscovery,
  createLocalFactoryMaintenanceDiscovery,
  loadLocalFactoryMaintenanceDiscoveryConfig,
  type FactoryMaintenanceDiscoveryCommandPort,
  type LocalFactoryMaintenanceDiscoveryConfig,
  type LocalFactoryMaintenanceDiscoveryOptions,
  type LocalFactoryMaintenanceDiscoveryRuntime
} from "@agentlab/runtime/factory-maintenance-discovery";
// @ts-expect-error Discovery must not be exported by the interactive runtime.
import { createLocalFactoryMaintenanceDiscovery as forbiddenInteractiveDiscovery } from "@agentlab/runtime";
// @ts-expect-error Discovery must not be exported by the credential-bearing broker.
import { createLocalFactoryMaintenanceDiscovery as forbiddenBrokerDiscovery } from "@agentlab/runtime/factory-broker";
// @ts-expect-error Discovery must not be exported by the execution worker.
import { createLocalFactoryMaintenanceDiscovery as forbiddenWorkerDiscovery } from "@agentlab/runtime/factory-worker";
// @ts-expect-error Discovery must not be exported by human authority issuance.
import { createLocalFactoryMaintenanceDiscovery as forbiddenAuthorityDiscovery } from "@agentlab/runtime/factory-authority";

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

export type FactoryMaintenanceDiscoveryPublicApiAssertions = [
  Assert<Equal<keyof FactoryMaintenanceDiscoveryCommandPort, "preflight" | "tick">>,
  Assert<Equal<keyof LocalFactoryMaintenanceDiscoveryRuntime, "commands" | "close">>,
  Assert<
    Equal<
      typeof createLocalFactoryMaintenanceDiscovery,
      (options: LocalFactoryMaintenanceDiscoveryOptions) => LocalFactoryMaintenanceDiscoveryRuntime
    >
  >,
  Assert<
    Equal<
      typeof createConfiguredLocalFactoryMaintenanceDiscovery,
      (config: LocalFactoryMaintenanceDiscoveryConfig) => LocalFactoryMaintenanceDiscoveryRuntime
    >
  >,
  Assert<
    Equal<
      typeof loadLocalFactoryMaintenanceDiscoveryConfig,
      (pathInput: string) => Promise<LocalFactoryMaintenanceDiscoveryConfig>
    >
  >
];

void forbiddenInteractiveDiscovery;
void forbiddenBrokerDiscovery;
void forbiddenWorkerDiscovery;
void forbiddenAuthorityDiscovery;
