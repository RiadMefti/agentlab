import type {
  FactoryDailyQuotaPolicy,
  FactoryIncidentContainment,
  FactoryOperationsHealthPolicy,
  FactoryOperationsHealthReport,
  Sha256Digest
} from "@agentlab/contracts";
import {
  createConfiguredLocalFactoryIncidentContainment,
  createLocalFactoryIncidentContainment,
  loadLocalFactoryIncidentContainmentConfig,
  type FactoryIncidentContainmentCommandPort,
  type FactoryIncidentContainmentResult,
  type LocalFactoryIncidentContainmentConfig,
  type LocalFactoryIncidentContainmentOptions,
  type LocalFactoryIncidentContainmentRuntime
} from "@agentlab/runtime/factory-incident-containment";
// @ts-expect-error Incident containment must not be exported by the interactive runtime.
import { createLocalFactoryIncidentContainment as forbiddenInteractiveContainment } from "@agentlab/runtime";
// @ts-expect-error Incident containment must not be exported by the credential-bearing broker.
import { createLocalFactoryIncidentContainment as forbiddenBrokerContainment } from "@agentlab/runtime/factory-broker";
// @ts-expect-error Incident containment must not be exported by the model-bearing worker.
import { createLocalFactoryIncidentContainment as forbiddenWorkerContainment } from "@agentlab/runtime/factory-worker";
// @ts-expect-error Incident containment must not be exported by human authority operations.
import { createLocalFactoryIncidentContainment as forbiddenAuthorityContainment } from "@agentlab/runtime/factory-authority";

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
  readonly schemaVersion: "agentlab.local-factory-incident-containment.v1";
  readonly databasePath: string;
  readonly controllerId: string;
  readonly controllerUserId: number;
  readonly healthPolicyPath: string;
  readonly expectedHealthPolicyDigest: Sha256Digest;
  readonly dailyQuotaPolicyPath: string;
  readonly expectedDailyQuotaPolicyDigest: Sha256Digest;
  readonly healthPolicy: FactoryOperationsHealthPolicy;
  readonly dailyQuotaPolicy: FactoryDailyQuotaPolicy;
}

interface ExpectedOptions {
  readonly databasePath: string;
  readonly controllerId: string;
  readonly controllerUserId: number;
  readonly healthPolicy: FactoryOperationsHealthPolicy;
  readonly expectedHealthPolicyDigest: Sha256Digest;
  readonly dailyQuotaPolicy: FactoryDailyQuotaPolicy;
  readonly expectedDailyQuotaPolicyDigest: Sha256Digest;
  readonly now?: () => string;
  readonly createId?: () => string;
}

interface ExpectedResult {
  readonly schemaVersion: "agentlab.incident-containment-result.v1";
  readonly status: "healthy" | "degraded" | "contained" | "already-contained";
  readonly report: FactoryOperationsHealthReport;
  readonly reportDigest: Sha256Digest;
  readonly authorityBefore: { readonly scheduler: boolean; readonly prBroker: boolean };
  readonly authorityAfter: { readonly scheduler: boolean; readonly prBroker: boolean };
  readonly containment: FactoryIncidentContainment | null;
  readonly containmentDigest: Sha256Digest | null;
}

export type FactoryIncidentContainmentPublicApiAssertions = [
  Assert<Equal<LocalFactoryIncidentContainmentConfig, ExpectedConfig>>,
  Assert<Equal<LocalFactoryIncidentContainmentOptions, ExpectedOptions>>,
  Assert<Equal<FactoryIncidentContainmentResult, ExpectedResult>>,
  Assert<Equal<keyof FactoryIncidentContainmentCommandPort, "containIfCritical">>,
  Assert<Equal<keyof LocalFactoryIncidentContainmentRuntime, "commands" | "close">>,
  Assert<
    Equal<
      typeof createLocalFactoryIncidentContainment,
      (options: LocalFactoryIncidentContainmentOptions) => LocalFactoryIncidentContainmentRuntime
    >
  >,
  Assert<
    Equal<
      typeof createConfiguredLocalFactoryIncidentContainment,
      (config: LocalFactoryIncidentContainmentConfig) => LocalFactoryIncidentContainmentRuntime
    >
  >,
  Assert<
    Equal<
      typeof loadLocalFactoryIncidentContainmentConfig,
      (pathInput: string) => Promise<LocalFactoryIncidentContainmentConfig>
    >
  >
];

void forbiddenInteractiveContainment;
void forbiddenBrokerContainment;
void forbiddenWorkerContainment;
void forbiddenAuthorityContainment;
