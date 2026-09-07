import type { FactoryDailyCycleBundle } from "@agentlab/contracts";

import { compileFactoryDailyCyclePlan } from "./domain/factory-daily-cycle-plan.js";
import type { LocalFactoryOrchestrationConfig } from "./infrastructure/filesystem/local-factory-orchestration-config.js";
import { renderSystemdFactoryDailyCycle } from "./infrastructure/process/systemd-factory-daily-cycle-renderer.js";

/** Produces a content-addressed systemd bundle without writing or activating host state. */
export function renderConfiguredLocalFactoryDailyCycle(
  config: LocalFactoryOrchestrationConfig
): FactoryDailyCycleBundle {
  const {
    schedulePolicy,
    roleIdentityPolicy,
    dailyQuotaPolicy: _dailyQuotaPolicy,
    operationsHealthPolicy: _operationsHealthPolicy,
    autonomousMergePolicy: _autonomousMergePolicy,
    ...manifest
  } = config;
  void _dailyQuotaPolicy;
  void _operationsHealthPolicy;
  void _autonomousMergePolicy;
  const plan = compileFactoryDailyCyclePlan(manifest, schedulePolicy, roleIdentityPolicy);
  return renderSystemdFactoryDailyCycle(manifest, plan);
}

export type {
  FactoryDailyCycleBundle,
  FactoryDailyCycleManifest,
  FactoryDailyCycleUnit
} from "@agentlab/contracts";
export {
  loadLocalFactoryOrchestrationConfig,
  type LocalFactoryOrchestrationConfig
} from "./infrastructure/filesystem/local-factory-orchestration-config.js";
