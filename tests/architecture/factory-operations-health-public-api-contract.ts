import type {
  FactoryOperationsHealthPolicy,
  FactoryOperationsHealthReport
} from "@agentlab/contracts";
import {
  createConfiguredLocalFactoryOperationsHealth,
  createLocalFactoryOperationsHealth,
  loadLocalFactoryOperationsHealthConfig,
  loadLocalFactoryOperationsHealthPolicy,
  type FactoryOperationsHealthCommandPort,
  type LocalFactoryOperationsHealthConfig,
  type LocalFactoryOperationsHealthOptions,
  type LocalFactoryOperationsHealthRuntime
} from "@agentlab/runtime/factory-operations-health";

export const factoryOperationsHealthPublicApiContract = {
  createConfiguredLocalFactoryOperationsHealth,
  createLocalFactoryOperationsHealth,
  loadLocalFactoryOperationsHealthConfig,
  loadLocalFactoryOperationsHealthPolicy
};

export interface FactoryOperationsHealthPublicApiTypes {
  readonly policy: FactoryOperationsHealthPolicy;
  readonly report: FactoryOperationsHealthReport;
  readonly config: LocalFactoryOperationsHealthConfig;
  readonly options: LocalFactoryOperationsHealthOptions;
  readonly commands: FactoryOperationsHealthCommandPort;
  readonly runtime: LocalFactoryOperationsHealthRuntime;
}
