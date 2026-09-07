import type {
  LocalFactoryMaintenanceDiscoveryConfig,
  LocalFactoryMaintenanceDiscoveryRuntime
} from "@agentlab/runtime/factory-maintenance-discovery";
import { describe, expect, it, vi } from "vitest";

import {
  runFactoryMaintenanceDiscoveryPreflight,
  runFactoryMaintenanceDiscoveryTick
} from "../../apps/tui/src/run-factory-maintenance-discovery.js";
import { testDigest } from "../helpers/factory.js";

describe("factory maintenance discovery CLI runner", () => {
  it("runs preflight and one explicitly pinned tick, then closes cleanly", async () => {
    const config = {} as LocalFactoryMaintenanceDiscoveryConfig;
    const preflight = vi.fn(() => Promise.resolve(preflightReport()));
    const tick = vi.fn(() => Promise.resolve(tickReport()));
    const close = vi.fn(() => Promise.resolve());
    const runtime: LocalFactoryMaintenanceDiscoveryRuntime = {
      commands: { preflight, tick },
      close
    };
    const dependencies = {
      loadConfig: vi.fn(() => Promise.resolve(config)),
      createRuntime: vi.fn(() => runtime),
      write: vi.fn()
    };

    await expect(
      runFactoryMaintenanceDiscoveryPreflight("/private/discovery.json", dependencies)
    ).resolves.toBe(0);
    expect(preflight).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();

    close.mockClear();
    await expect(
      runFactoryMaintenanceDiscoveryTick(
        "/private/discovery.json",
        testDigest("1"),
        testDigest("2"),
        testDigest("3"),
        testDigest("4"),
        testDigest("5"),
        dependencies
      )
    ).resolves.toBe(0);
    expect(tick).toHaveBeenCalledWith({
      expectedDiscoveryPolicyDigest: testDigest("1"),
      expectedSchedulePolicyDigest: testDigest("2"),
      expectedFactoryPolicyBundleDigest: testDigest("3"),
      expectedPreparationGrantDigest: testDigest("4"),
      expectedRoleIdentityPolicyDigest: testDigest("5")
    });
    expect(close).toHaveBeenCalledOnce();
    expect(JSON.parse(String(dependencies.write.mock.calls.at(-1)?.[0]))).toMatchObject({
      status: "completed",
      admitted: 1
    });
  });

  it("rejects invalid boundaries and closes after a command failure", async () => {
    const close = vi.fn(() => Promise.resolve());
    const runtime: LocalFactoryMaintenanceDiscoveryRuntime = {
      commands: {
        preflight: () => Promise.reject(new Error("preflight failed")),
        tick: () => Promise.reject(new Error("tick failed"))
      },
      close
    };
    const dependencies = {
      loadConfig: vi.fn(() => Promise.resolve({} as LocalFactoryMaintenanceDiscoveryConfig)),
      createRuntime: vi.fn(() => runtime),
      write: vi.fn()
    };

    await expect(
      runFactoryMaintenanceDiscoveryPreflight("relative.json", dependencies)
    ).rejects.toThrow(/absolute config path/u);
    await expect(
      runFactoryMaintenanceDiscoveryTick(
        "/private/discovery.json",
        "not-a-digest",
        testDigest("2"),
        testDigest("3"),
        testDigest("4"),
        testDigest("5"),
        dependencies
      )
    ).rejects.toThrow(/digest is invalid/u);
    await expect(
      runFactoryMaintenanceDiscoveryPreflight("/private/discovery.json", dependencies)
    ).rejects.toThrow(/preflight failed/u);
    expect(close).toHaveBeenCalledOnce();
  });
});

function preflightReport() {
  return {
    schemaVersion: "agentlab.maintenance-discovery-preflight.v1" as const,
    status: "ready" as const,
    repository: { id: "owner/agentlab", baseRevision: "a".repeat(40) },
    discoveryPolicyDigest: testDigest("1"),
    schedulePolicyDigest: testDigest("2"),
    factoryPolicyBundleDigest: testDigest("3"),
    preparationGrantDigest: testDigest("4"),
    roleIdentityPolicyDigest: testDigest("5"),
    provider: "codex",
    skillPackageDigest: testDigest("6"),
    schedulerEnabled: true,
    reasonCodes: []
  };
}

function tickReport() {
  return {
    schemaVersion: "agentlab.maintenance-discovery-tick-result.v1" as const,
    status: "completed" as const,
    scheduledFor: "2026-08-31T12:00:00.000Z",
    deadlineAt: "2026-08-31T12:30:00.000Z",
    runId: "81000000-0000-4000-8000-000000000001",
    runDigest: testDigest("7"),
    findings: 1,
    admitted: 1,
    skipped: 0,
    usage: {
      wallClockSeconds: 1,
      agentTurns: 1,
      toolCalls: 1,
      inputTokens: 1,
      outputTokens: 1,
      costMicrousd: 1,
      processes: 1,
      outputBytes: 1,
      workers: 1,
      repairAttempts: 0,
      changedFiles: 0,
      changedLines: 0
    },
    reasonCodes: []
  };
}
