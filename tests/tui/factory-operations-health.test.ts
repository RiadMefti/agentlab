import type {
  LocalFactoryOperationsHealthConfig,
  LocalFactoryOperationsHealthRuntime
} from "@agentlab/runtime/factory-operations-health";
import { describe, expect, it, vi } from "vitest";

import {
  runFactoryOperationsHealth,
  type FactoryOperationsHealthRunnerDependencies
} from "../../apps/tui/src/run-factory-operations-health.js";
import { NodeFactoryDocumentCodec } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { testFactoryDailyQuotaPolicy } from "../helpers/factory-daily-quota.js";
import { testFactoryOperationsHealthPolicy } from "../helpers/factory-operations-health.js";

const documents = new NodeFactoryDocumentCodec();
const configPath = "/private/agentlab/operations-health.json";

describe("factory operations health CLI runner", () => {
  it.each([
    ["healthy", 0],
    ["degraded", 2],
    ["critical", 3]
  ] as const)("emits canonical %s output only after close", async (status, exitCode) => {
    const writes: string[] = [];
    const close = vi.fn(() => Promise.resolve());
    const report = reportDocument(status);
    const dependencies: FactoryOperationsHealthRunnerDependencies = {
      loadConfig: vi.fn(() => Promise.resolve(config())),
      createRuntime: vi.fn(() => runtime(Promise.resolve(report), close)),
      write: (message) => writes.push(message)
    };

    await expect(runFactoryOperationsHealth(configPath, dependencies)).resolves.toBe(exitCode);

    expect(close).toHaveBeenCalledOnce();
    expect(JSON.parse(writes[0] ?? "")).toEqual({
      report: report.value,
      reportDigest: report.digest
    });
  });

  it("closes on observation failure and emits no partial report", async () => {
    const writes: string[] = [];
    const failure = new Error("ledger projection failed");
    const close = vi.fn(() => Promise.resolve());
    const dependencies: FactoryOperationsHealthRunnerDependencies = {
      loadConfig: () => Promise.resolve(config()),
      createRuntime: () => runtime(Promise.reject(failure), close),
      write: (message) => writes.push(message)
    };

    await expect(runFactoryOperationsHealth(configPath, dependencies)).rejects.toBe(failure);
    expect(close).toHaveBeenCalledOnce();
    expect(writes).toEqual([]);
  });
});

function runtime(
  inspect: ReturnType<LocalFactoryOperationsHealthRuntime["commands"]["inspect"]>,
  close: () => Promise<void>
): LocalFactoryOperationsHealthRuntime {
  return { commands: { inspect: () => inspect }, close };
}

function reportDocument(status: "healthy" | "degraded" | "critical") {
  const quotaUsage = {
    tasksReserved: 0,
    draftPullRequestsReserved: 0,
    costMicrousdReserved: 0,
    taskUtilizationBasisPoints: 0,
    draftPullRequestUtilizationBasisPoints: 0,
    maximumBudgetUtilizationBasisPoints: 0
  };
  return documents.operationsHealthReport({
    schemaVersion: "agentlab.operations-health-report.v1",
    reportId: "10000000-0000-4000-8000-000000000001",
    observerId: "operations-observer",
    healthPolicyDigest: documents.operationsHealthPolicy(testFactoryOperationsHealthPolicy())
      .digest,
    dailyQuotaPolicyDigest: documents.dailyQuotaPolicy(testFactoryDailyQuotaPolicy()).digest,
    observedAt: "2026-08-31T13:00:00.000Z",
    lookbackStartedAt: "2026-08-30T13:00:00.000Z",
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
    status,
    incidentRecommended: status === "critical",
    reasonCodes:
      status === "healthy"
        ? []
        : status === "degraded"
          ? ["recent-failed-task"]
          : ["overdue-schedule-run"]
  });
}

function config(): LocalFactoryOperationsHealthConfig {
  const healthPolicy = testFactoryOperationsHealthPolicy();
  const dailyQuotaPolicy = testFactoryDailyQuotaPolicy();
  return {
    schemaVersion: "agentlab.local-factory-operations-health.v1",
    databasePath: "/private/agentlab/factory.sqlite",
    observerId: "operations-observer",
    healthPolicyPath: "/private/agentlab/health-policy.json",
    expectedHealthPolicyDigest: documents.operationsHealthPolicy(healthPolicy).digest,
    dailyQuotaPolicyPath: "/private/agentlab/daily-quota.json",
    expectedDailyQuotaPolicyDigest: documents.dailyQuotaPolicy(dailyQuotaPolicy).digest,
    healthPolicy,
    dailyQuotaPolicy
  };
}
