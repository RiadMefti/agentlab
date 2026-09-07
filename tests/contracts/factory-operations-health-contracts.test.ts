import {
  factoryOperationsHealthPolicySchema,
  factoryOperationsHealthReportSchema
} from "@agentlab/contracts";
import { describe, expect, it } from "vitest";

import { testFactoryOperationsHealthPolicy } from "../helpers/factory-operations-health.js";
import { testDigest } from "../helpers/factory.js";

describe("factory operations health contracts", () => {
  it("accepts strict policy and content-addressable report shapes", () => {
    expect(factoryOperationsHealthPolicySchema.parse(testFactoryOperationsHealthPolicy())).toEqual(
      testFactoryOperationsHealthPolicy()
    );
    expect(factoryOperationsHealthReportSchema.parse(validReport())).toEqual(validReport());
  });

  it("rejects ambiguous reasons, invalid windows, and inconsistent incident recommendations", () => {
    const report = validReport();
    expect(() =>
      factoryOperationsHealthReportSchema.parse({
        ...report,
        reasonCodes: ["recent-failed-task", "recent-failed-task"],
        status: "degraded"
      })
    ).toThrow(/unique/u);
    expect(() =>
      factoryOperationsHealthReportSchema.parse({
        ...report,
        observedAt: report.dailyQuota.windowEnd
      })
    ).toThrow(/must contain/u);
    expect(() =>
      factoryOperationsHealthReportSchema.parse({
        ...report,
        status: "critical",
        incidentRecommended: false
      })
    ).toThrow(/critical/u);
  });
});

function validReport() {
  const quotaUsage = {
    tasksReserved: 0,
    draftPullRequestsReserved: 0,
    costMicrousdReserved: 0,
    taskUtilizationBasisPoints: 0,
    draftPullRequestUtilizationBasisPoints: 0,
    maximumBudgetUtilizationBasisPoints: 0
  };
  return {
    schemaVersion: "agentlab.operations-health-report.v1" as const,
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
    status: "healthy" as const,
    incidentRecommended: false,
    reasonCodes: []
  };
}
