import type { FactoryControlEvent, Sha256Digest } from "@agentlab/contracts";
import {
  createConfiguredLocalFactoryAuthority,
  createLocalFactoryAuthority,
  loadLocalFactoryAuthorityConfig,
  type FactoryAuthorityCommandPort,
  type FactoryAuthorityInspection,
  type FactoryBrokerAuthorityChange,
  type FactoryBrokerAuthorityCommand,
  type FactorySchedulerAuthorityChange,
  type FactorySchedulerAuthorityCommand,
  type LocalFactoryAuthorityConfig,
  type LocalFactoryAuthorityOptions,
  type LocalFactoryAuthorityRuntime
} from "@agentlab/runtime/factory-authority";
// @ts-expect-error Human authority mutation must not be exported by the interactive runtime.
import { createLocalFactoryAuthority as forbiddenInteractiveAuthority } from "@agentlab/runtime";
// @ts-expect-error Human authority mutation must not be exported by the credential-bearing broker.
import { createLocalFactoryAuthority as forbiddenBrokerAuthority } from "@agentlab/runtime/factory-broker";
// @ts-expect-error Human authority mutation must not be exported by the model-bearing worker.
import { createLocalFactoryAuthority as forbiddenWorkerAuthority } from "@agentlab/runtime/factory-worker";

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
  schemaVersion: "agentlab.local-factory-authority.v1";
  databasePath: string;
  operatorId: string;
}

interface ExpectedOptions {
  readonly databasePath: string;
  readonly operatorId: string;
  readonly now?: () => string;
  readonly createId?: () => string;
}

interface ExpectedCommand {
  expectedEnabled: boolean;
  enabled: boolean;
  reason: string;
  confirmation: "enable-draft-broker" | "disable-draft-broker";
}

interface ExpectedInspection {
  readonly schemaVersion: "agentlab.authority-inspection.v2";
  readonly schedulerEnabled: boolean;
  readonly prBrokerEnabled: boolean;
  readonly recentSchedulerEvents: readonly FactoryControlEvent[];
  readonly recentBrokerEvents: readonly FactoryControlEvent[];
}

interface ExpectedChange {
  readonly schemaVersion: "agentlab.authority-change-result.v1";
  readonly changed: true;
  readonly schedulerEnabled: boolean;
  readonly prBrokerEnabled: boolean;
  readonly event: FactoryControlEvent;
  readonly eventDigest: Sha256Digest;
}

interface ExpectedSchedulerCommand {
  expectedEnabled: boolean;
  enabled: boolean;
  reason: string;
  confirmation: "enable-scheduler" | "disable-scheduler";
}

interface ExpectedSchedulerChange {
  readonly schemaVersion: "agentlab.scheduler-authority-change-result.v1";
  readonly changed: true;
  readonly schedulerEnabled: boolean;
  readonly prBrokerEnabled: boolean;
  readonly event: FactoryControlEvent;
  readonly eventDigest: Sha256Digest;
}

export type FactoryAuthorityPublicApiAssertions = [
  Assert<Equal<LocalFactoryAuthorityConfig, ExpectedConfig>>,
  Assert<Equal<LocalFactoryAuthorityOptions, ExpectedOptions>>,
  Assert<Equal<FactoryBrokerAuthorityCommand, ExpectedCommand>>,
  Assert<Equal<FactorySchedulerAuthorityCommand, ExpectedSchedulerCommand>>,
  Assert<Equal<FactoryAuthorityInspection, ExpectedInspection>>,
  Assert<Equal<FactoryBrokerAuthorityChange, ExpectedChange>>,
  Assert<Equal<FactorySchedulerAuthorityChange, ExpectedSchedulerChange>>,
  Assert<
    Equal<
      keyof FactoryAuthorityCommandPort,
      "inspect" | "setBrokerAuthority" | "setSchedulerAuthority"
    >
  >,
  Assert<Equal<keyof LocalFactoryAuthorityRuntime, "commands" | "close">>,
  Assert<
    Equal<
      typeof createLocalFactoryAuthority,
      (options: LocalFactoryAuthorityOptions) => LocalFactoryAuthorityRuntime
    >
  >,
  Assert<
    Equal<
      typeof createConfiguredLocalFactoryAuthority,
      (config: LocalFactoryAuthorityConfig) => LocalFactoryAuthorityRuntime
    >
  >,
  Assert<
    Equal<
      typeof loadLocalFactoryAuthorityConfig,
      (pathInput: string) => Promise<LocalFactoryAuthorityConfig>
    >
  >
];

void forbiddenInteractiveAuthority;
void forbiddenBrokerAuthority;
void forbiddenWorkerAuthority;
