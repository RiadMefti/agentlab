import type {
  FactoryBudget,
  FactoryBudgetUsage,
  FactoryCapabilityGrant,
  FactoryRiskTier
} from "@agentlab/contracts";

/** Returns true only when every requested capability is contained by the trusted ceiling. */
export function factoryCapabilitiesFit(
  requested: FactoryCapabilityGrant,
  ceiling: FactoryCapabilityGrant
): boolean {
  return (
    accessRank(requested.filesystem) <= accessRank(ceiling.filesystem) &&
    accessRank(requested.git) <= accessRank(ceiling.git) &&
    accessRank(requested.remoteRepository) <= accessRank(ceiling.remoteRepository) &&
    accessRank(requested.process) <= accessRank(ceiling.process) &&
    networkFits(requested.network, ceiling.network) &&
    requested.commandAllowlist.every((command) => ceiling.commandAllowlist.includes(command)) &&
    requested.secretRefs.every((secret) => ceiling.secretRefs.includes(secret))
  );
}

/** Returns true only when every cumulative task limit is no greater than its authority ceiling. */
export function factoryBudgetFits(requested: FactoryBudget, ceiling: FactoryBudget): boolean {
  return (
    requested.wallClockSeconds <= ceiling.wallClockSeconds &&
    requested.maxAgentTurns <= ceiling.maxAgentTurns &&
    requested.maxToolCalls <= ceiling.maxToolCalls &&
    requested.maxInputTokens <= ceiling.maxInputTokens &&
    requested.maxOutputTokens <= ceiling.maxOutputTokens &&
    requested.maxCostMicrousd <= ceiling.maxCostMicrousd &&
    requested.maxProcesses <= ceiling.maxProcesses &&
    requested.maxOutputBytes <= ceiling.maxOutputBytes &&
    requested.maxWorkers <= ceiling.maxWorkers &&
    requested.maxRepairAttempts <= ceiling.maxRepairAttempts &&
    requested.maxChangedFiles <= ceiling.maxChangedFiles &&
    requested.maxChangedLines <= ceiling.maxChangedLines
  );
}

export function factoryUsageFits(usage: FactoryBudgetUsage, budget: FactoryBudget): boolean {
  return (
    usage.wallClockSeconds <= budget.wallClockSeconds &&
    usage.agentTurns <= budget.maxAgentTurns &&
    usage.toolCalls <= budget.maxToolCalls &&
    usage.inputTokens <= budget.maxInputTokens &&
    usage.outputTokens <= budget.maxOutputTokens &&
    usage.costMicrousd <= budget.maxCostMicrousd &&
    usage.processes <= budget.maxProcesses &&
    usage.outputBytes <= budget.maxOutputBytes &&
    usage.workers <= budget.maxWorkers &&
    usage.repairAttempts <= budget.maxRepairAttempts &&
    usage.changedFiles <= budget.maxChangedFiles &&
    usage.changedLines <= budget.maxChangedLines
  );
}

export function mergeFactoryCapabilities(
  left: FactoryCapabilityGrant,
  right: FactoryCapabilityGrant
): FactoryCapabilityGrant {
  return {
    filesystem: maximumAccess(left.filesystem, right.filesystem),
    git: maximumAccess(left.git, right.git),
    remoteRepository: maximumAccess(left.remoteRepository, right.remoteRepository),
    process: maximumAccess(left.process, right.process),
    network:
      left.network.mode === "off" && right.network.mode === "off"
        ? { mode: "off" }
        : {
            mode: "allowlist",
            hosts: unique([
              ...(left.network.mode === "allowlist" ? left.network.hosts : []),
              ...(right.network.mode === "allowlist" ? right.network.hosts : [])
            ])
          },
    commandAllowlist: unique([...left.commandAllowlist, ...right.commandAllowlist]),
    secretRefs: unique([...left.secretRefs, ...right.secretRefs])
  };
}

export function minimumFactoryBudget(left: FactoryBudget, right: FactoryBudget): FactoryBudget {
  return {
    wallClockSeconds: Math.min(left.wallClockSeconds, right.wallClockSeconds),
    maxAgentTurns: Math.min(left.maxAgentTurns, right.maxAgentTurns),
    maxToolCalls: Math.min(left.maxToolCalls, right.maxToolCalls),
    maxInputTokens: Math.min(left.maxInputTokens, right.maxInputTokens),
    maxOutputTokens: Math.min(left.maxOutputTokens, right.maxOutputTokens),
    maxCostMicrousd: Math.min(left.maxCostMicrousd, right.maxCostMicrousd),
    maxProcesses: Math.min(left.maxProcesses, right.maxProcesses),
    maxOutputBytes: Math.min(left.maxOutputBytes, right.maxOutputBytes),
    maxWorkers: Math.min(left.maxWorkers, right.maxWorkers),
    maxRepairAttempts: Math.min(left.maxRepairAttempts, right.maxRepairAttempts),
    maxChangedFiles: Math.min(left.maxChangedFiles, right.maxChangedFiles),
    maxChangedLines: Math.min(left.maxChangedLines, right.maxChangedLines)
  };
}

export function maximumFactoryRisk(left: FactoryRiskTier, right: FactoryRiskTier): FactoryRiskTier {
  return factoryRiskRank(left) >= factoryRiskRank(right) ? left : right;
}

export function factoryRiskRank(tier: FactoryRiskTier): number {
  return ["R0", "R1", "R2", "R3", "R4"].indexOf(tier);
}

function networkFits(
  requested: FactoryCapabilityGrant["network"],
  ceiling: FactoryCapabilityGrant["network"]
): boolean {
  if (requested.mode === "off") return true;
  if (ceiling.mode === "off") return false;
  return requested.hosts.every((host) => ceiling.hosts.includes(host));
}

function maximumAccess<Value extends string>(left: Value, right: Value): Value {
  return accessRank(left) >= accessRank(right) ? left : right;
}

function accessRank(value: string): number {
  if (value === "none") return 0;
  if (value === "read") return 1;
  return 2;
}

function unique<Value>(values: readonly Value[]): Value[] {
  return [...new Set(values)];
}
