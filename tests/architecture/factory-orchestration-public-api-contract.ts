import type {
  FactoryDailyCycleBundle,
  FactoryDailyCycleManifest,
  FactoryDailyQuotaPolicy,
  FactoryRoleIdentityPolicy,
  FactorySchedulePolicy
} from "@agentlab/contracts";
import {
  loadLocalFactoryOrchestrationConfig,
  renderConfiguredLocalFactoryDailyCycle,
  type LocalFactoryOrchestrationConfig
} from "@agentlab/runtime/factory-orchestration";
// @ts-expect-error Orchestration rendering must not be exported by the interactive runtime.
import { renderConfiguredLocalFactoryDailyCycle as forbiddenInteractiveRenderer } from "@agentlab/runtime";
// @ts-expect-error Orchestration rendering must not be exported by the credential-bearing broker.
import { renderConfiguredLocalFactoryDailyCycle as forbiddenBrokerRenderer } from "@agentlab/runtime/factory-broker";
// @ts-expect-error Orchestration rendering must not be exported by the model-bearing worker.
import { renderConfiguredLocalFactoryDailyCycle as forbiddenWorkerRenderer } from "@agentlab/runtime/factory-worker";

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

type ManifestKeys =
  | "schemaVersion"
  | "id"
  | "version"
  | "agentlabExecutable"
  | "executableChecksumPath"
  | "worker"
  | "broker"
  | "schedulePolicyPath"
  | "roleIdentityPolicyPath"
  | "expectedSchedulePolicyDigest"
  | "expectedRoleIdentityPolicyDigest"
  | "expectedFactoryPolicyBundleDigest"
  | "maximumRepairRounds"
  | "workerCommandTimeoutSeconds"
  | "brokerCommandTimeoutSeconds";

type ConfigKeys = ManifestKeys | "schedulePolicy" | "roleIdentityPolicy" | "dailyQuotaPolicy";

export type FactoryOrchestrationPublicApiAssertions = [
  Assert<Equal<keyof FactoryDailyCycleManifest, ManifestKeys>>,
  Assert<Equal<keyof LocalFactoryOrchestrationConfig, ConfigKeys>>,
  Assert<Equal<LocalFactoryOrchestrationConfig["schedulePolicy"], FactorySchedulePolicy>>,
  Assert<Equal<LocalFactoryOrchestrationConfig["roleIdentityPolicy"], FactoryRoleIdentityPolicy>>,
  Assert<
    Equal<LocalFactoryOrchestrationConfig["dailyQuotaPolicy"], FactoryDailyQuotaPolicy | undefined>
  >,
  Assert<
    Equal<
      typeof loadLocalFactoryOrchestrationConfig,
      (pathInput: string) => Promise<LocalFactoryOrchestrationConfig>
    >
  >,
  Assert<
    Equal<
      typeof renderConfiguredLocalFactoryDailyCycle,
      (config: LocalFactoryOrchestrationConfig) => FactoryDailyCycleBundle
    >
  >
];

void forbiddenInteractiveRenderer;
void forbiddenBrokerRenderer;
void forbiddenWorkerRenderer;
