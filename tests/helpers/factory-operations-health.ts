import {
  factoryOperationsHealthPolicySchema,
  factoryOperationsHealthReportSchema,
  type FactoryOperationsHealthPolicy,
  type FactoryOperationsHealthReport
} from "@agentlab/contracts";

import { testDigest } from "./factory.js";

export function testFactoryOperationsHealthPolicy(
  overrides: Partial<FactoryOperationsHealthPolicy> = {}
): FactoryOperationsHealthPolicy {
  return factoryOperationsHealthPolicySchema.parse({
    schemaVersion: "agentlab.operations-health-policy.v1",
    id: "agentlab/operations-health",
    version: "1.0.0",
    lookbackSeconds: 86_400,
    maximumScheduleOverrunSeconds: 300,
    maximumInFlightSilenceSeconds: 3_600,
    quotaWarningBasisPoints: 8_000,
    maximumRecordsPerSection: 1_000,
    ...overrides
  });
}

export function testFactoryOperationsHealthReport(
  overrides: Partial<FactoryOperationsHealthReport> = {}
): FactoryOperationsHealthReport {
  const quotaUsage = {
    tasksReserved: 0,
    draftPullRequestsReserved: 0,
    costMicrousdReserved: 0,
    taskUtilizationBasisPoints: 0,
    draftPullRequestUtilizationBasisPoints: 0,
    maximumBudgetUtilizationBasisPoints: 0
  };
  return factoryOperationsHealthReportSchema.parse({
    schemaVersion: "agentlab.operations-health-report.v1",
    reportId: "10000000-0000-4000-8000-000000000001",
    observerId: "operations-observer",
    healthPolicyDigest: testDigest("1"),
    dailyQuotaPolicyDigest: testDigest("2"),
    observedAt: "2026-08-31T12:00:00.000Z",
    lookbackStartedAt: "2026-08-30T12:00:00.000Z",
    authority: {
      schedulerEnabled: false,
      prBrokerEnabled: false,
      autonomousDraftsEnabled: false
    },
    schedules: {
      observed: 0,
      completed: 0,
      open: 0,
      overdue: 0,
      oldestOpenAgeSeconds: null,
      latestScheduledFor: null,
      openRunIds: [],
      overdueRunIds: []
    },
    tasks: {
      observed: 0,
      active: 0,
      completed: 0,
      needsAttention: 0,
      failed: 0,
      quarantined: 0,
      otherTerminal: 0,
      overdue: 0,
      stalled: 0,
      attentionTaskIds: []
    },
    dailyQuota: {
      organizationId: "agentlab-test",
      windowStart: "2026-08-31T00:00:00.000Z",
      windowEnd: "2026-09-01T00:00:00.000Z",
      organization: quotaUsage,
      repositories: [{ repositoryId: "agentlab", ...quotaUsage }]
    },
    status: "healthy",
    incidentRecommended: false,
    reasonCodes: [],
    ...overrides
  });
}
