import type {
  FactoryIncidentContainmentResult,
  LocalFactoryIncidentContainmentConfig,
  LocalFactoryIncidentContainmentRuntime
} from "@agentlab/runtime/factory-incident-containment";
import { describe, expect, it, vi } from "vitest";

import {
  runFactoryIncidentContainment,
  type FactoryIncidentContainmentRunnerDependencies
} from "../../apps/tui/src/run-factory-incident-containment.js";
import { NodeFactoryDocumentCodec } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { testFactoryDailyQuotaPolicy } from "../helpers/factory-daily-quota.js";
import {
  testFactoryOperationsHealthPolicy,
  testFactoryOperationsHealthReport
} from "../helpers/factory-operations-health.js";

const documents = new NodeFactoryDocumentCodec();
const configPath = "/private/agentlab/incident.json";

describe("factory incident containment CLI runner", () => {
  it.each([
    ["healthy", 0],
    ["degraded", 2],
    ["critical", 3]
  ] as const)(
    "emits the closed %s result with monitor-friendly status",
    async (status, exitCode) => {
      const writes: string[] = [];
      const close = vi.fn(() => Promise.resolve());
      const result = containmentResult(status);
      const dependencies: FactoryIncidentContainmentRunnerDependencies = {
        loadConfig: vi.fn(() => Promise.resolve(config())),
        createRuntime: vi.fn(() => runtime(Promise.resolve(result), close)),
        write: (message) => writes.push(message)
      };

      const loadedConfig = config();
      await expect(
        runFactoryIncidentContainment(
          configPath,
          loadedConfig.expectedHealthPolicyDigest,
          loadedConfig.expectedDailyQuotaPolicyDigest,
          dependencies
        )
      ).resolves.toBe(exitCode);

      expect(close).toHaveBeenCalledOnce();
      expect(JSON.parse(writes[0] ?? "")).toEqual(result);
    }
  );

  it("closes on containment failure without emitting partial evidence", async () => {
    const writes: string[] = [];
    const failure = new Error("atomic containment failed");
    const close = vi.fn(() => Promise.resolve());
    const dependencies: FactoryIncidentContainmentRunnerDependencies = {
      loadConfig: () => Promise.resolve(config()),
      createRuntime: () => runtime(Promise.reject(failure), close),
      write: (message) => writes.push(message)
    };

    const loadedConfig = config();
    await expect(
      runFactoryIncidentContainment(
        configPath,
        loadedConfig.expectedHealthPolicyDigest,
        loadedConfig.expectedDailyQuotaPolicyDigest,
        dependencies
      )
    ).rejects.toBe(failure);
    expect(close).toHaveBeenCalledOnce();
    expect(writes).toEqual([]);
  });

  it("rejects command/config policy disagreement before constructing a runtime", async () => {
    const createRuntime = vi.fn();
    const dependencies: FactoryIncidentContainmentRunnerDependencies = {
      loadConfig: () => Promise.resolve(config()),
      createRuntime,
      write: vi.fn()
    };

    await expect(
      runFactoryIncidentContainment(
        configPath,
        `sha256:${"f".repeat(64)}`,
        config().expectedDailyQuotaPolicyDigest,
        dependencies
      )
    ).rejects.toThrow(/policy pins/u);
    expect(createRuntime).not.toHaveBeenCalled();
  });
});

function runtime(
  containment: ReturnType<LocalFactoryIncidentContainmentRuntime["commands"]["containIfCritical"]>,
  close: () => Promise<void>
): LocalFactoryIncidentContainmentRuntime {
  return { commands: { containIfCritical: () => containment }, close };
}

function containmentResult(
  status: "healthy" | "degraded" | "critical"
): FactoryIncidentContainmentResult {
  const report = documents.operationsHealthReport(
    testFactoryOperationsHealthReport({
      status,
      incidentRecommended: status === "critical",
      reasonCodes:
        status === "healthy"
          ? []
          : status === "degraded"
            ? ["recent-failed-task"]
            : ["overdue-schedule-run"]
    })
  );
  return {
    schemaVersion: "agentlab.incident-containment-result.v1",
    status: status === "critical" ? "already-contained" : status,
    report: report.value,
    reportDigest: report.digest,
    authorityBefore: { scheduler: false, prBroker: false },
    authorityAfter: { scheduler: false, prBroker: false },
    containment: null,
    containmentDigest: null
  };
}

function config(): LocalFactoryIncidentContainmentConfig {
  const healthPolicy = testFactoryOperationsHealthPolicy();
  const dailyQuotaPolicy = testFactoryDailyQuotaPolicy();
  return {
    schemaVersion: "agentlab.local-factory-incident-containment.v1",
    databasePath: "/private/agentlab/factory.sqlite",
    controllerId: "incident-controller",
    controllerUserId: process.getuid?.() ?? 1_000,
    healthPolicyPath: "/private/agentlab/health-policy.json",
    expectedHealthPolicyDigest: documents.operationsHealthPolicy(healthPolicy).digest,
    dailyQuotaPolicyPath: "/private/agentlab/daily-quota.json",
    expectedDailyQuotaPolicyDigest: documents.dailyQuotaPolicy(dailyQuotaPolicy).digest,
    healthPolicy,
    dailyQuotaPolicy
  };
}
