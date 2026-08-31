import {
  factorySchedulePolicySchema,
  type FactoryBudget,
  type FactorySchedulePolicy
} from "@agentlab/contracts";

export const TEST_FACTORY_SCHEDULED_FOR = "2026-08-31T12:00:00.000Z";
export const TEST_FACTORY_SCHEDULE_DEADLINE = "2026-08-31T12:30:00.000Z";
export const TEST_FACTORY_SCHEDULE_NOW = "2026-08-31T12:05:00.000Z";

export function testFactorySchedulePolicy(
  overrides: Partial<FactorySchedulePolicy> = {}
): FactorySchedulePolicy {
  return factorySchedulePolicySchema.parse({
    schemaVersion: "agentlab.schedule-policy.v1",
    id: "agentlab/daily-maintenance",
    version: "1.0.0",
    cadence: {
      kind: "daily",
      timeZone: "UTC",
      at: "12:00",
      startDeadlineSeconds: 1_800
    },
    maximumTasksPerTick: 2,
    maximumCandidatesPerTick: 8,
    tickBudget: testFactoryScheduleBudget(),
    ...overrides
  });
}

export function testFactoryScheduleBudget(overrides: Partial<FactoryBudget> = {}): FactoryBudget {
  return {
    wallClockSeconds: 7_200,
    maxAgentTurns: 200,
    maxToolCalls: 1_000,
    maxInputTokens: 2_000_000,
    maxOutputTokens: 200_000,
    maxCostMicrousd: 20_000_000,
    maxProcesses: 64,
    maxOutputBytes: 20_000_000,
    maxWorkers: 4,
    maxRepairAttempts: 4,
    maxChangedFiles: 40,
    maxChangedLines: 1_000,
    ...overrides
  };
}
