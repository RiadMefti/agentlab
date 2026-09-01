import { factoryDailyQuotaPolicySchema, type FactoryDailyQuotaPolicy } from "@agentlab/contracts";

import { testFactoryScheduleBudget } from "./factory-schedule.js";

export function testFactoryDailyQuotaPolicy(
  overrides: Partial<FactoryDailyQuotaPolicy> = {}
): FactoryDailyQuotaPolicy {
  return factoryDailyQuotaPolicySchema.parse({
    schemaVersion: "agentlab.daily-quota-policy.v1",
    id: "agentlab/daily-aggregate-quota",
    version: "1.0.0",
    organizationId: "agentlab-test",
    timeZone: "UTC",
    repositories: [
      {
        repositoryId: "agentlab",
        maximumTasksPerDay: 3,
        maximumDraftPullRequestsPerDay: 3,
        budget: testFactoryScheduleBudget()
      }
    ],
    organization: {
      maximumTasksPerDay: 3,
      maximumDraftPullRequestsPerDay: 3,
      budget: testFactoryScheduleBudget()
    },
    ...overrides
  });
}
