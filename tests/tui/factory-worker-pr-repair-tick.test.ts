import type {
  FactoryCanaryPullRequestRepairTickReport,
  LocalFactoryWorkerConfig,
  LocalFactoryWorkerRuntime
} from "@agentlab/runtime/factory-worker";
import { describe, expect, it, vi } from "vitest";

import {
  runFactoryWorkerPullRequestRepairTick,
  type FactoryWorkerPullRequestRepairTickRunnerDependencies
} from "../../apps/tui/src/run-factory-worker-pr-repair-tick.js";
import { emptyReservedUsage } from "../../packages/runtime/src/domain/factory-schedule-integrity.js";
import { testFactorySchedulePolicy } from "../helpers/factory-schedule.js";
import { testDigest } from "../helpers/factory.js";

const configPath = "/private/agentlab/worker.json";
const schedulePolicyDigest = testDigest("1");
const factoryPolicyBundleDigest = testDigest("2");
const roleIdentityPolicyDigest = testDigest("3");

describe("factory worker PR repair tick CLI runner", () => {
  it("passes exact policy pins and emits only after clean shutdown", async () => {
    const events: string[] = [];
    const output: string[] = [];
    const tick = vi.fn(() => Promise.resolve(report("completed")));
    const close = vi.fn(() => Promise.resolve(events.push("close")).then(() => undefined));
    const dependencies = runnerDependencies(tick, close, (message) => {
      events.push("write");
      output.push(message);
    });

    await expect(
      runFactoryWorkerPullRequestRepairTick(
        configPath,
        schedulePolicyDigest,
        roleIdentityPolicyDigest,
        factoryPolicyBundleDigest,
        dependencies
      )
    ).resolves.toBe(0);

    expect(tick).toHaveBeenCalledWith({
      expectedSchedulePolicyDigest: schedulePolicyDigest,
      expectedRoleIdentityPolicyDigest: roleIdentityPolicyDigest,
      expectedFactoryPolicyBundleDigest: factoryPolicyBundleDigest
    });
    expect(events).toEqual(["close", "write"]);
    expect(JSON.parse(output.join(""))).toEqual(report("completed"));
  });

  it("returns exit 2 for blocked or attention-required work", async () => {
    for (const status of ["blocked", "attention-required"] as const) {
      const dependencies = runnerDependencies(
        () => Promise.resolve(report(status, ["scheduler-disabled"])),
        () => Promise.resolve(),
        vi.fn()
      );
      await expect(
        runFactoryWorkerPullRequestRepairTick(
          configPath,
          schedulePolicyDigest,
          roleIdentityPolicyDigest,
          factoryPolicyBundleDigest,
          dependencies
        )
      ).resolves.toBe(2);
    }
  });

  it("rejects malformed pins and legacy config before runtime construction", async () => {
    const loadConfig = vi.fn(() => Promise.resolve(config()));
    const createRuntime = vi.fn(() => runtime(() => Promise.resolve(report("idle"))));

    await expect(
      runFactoryWorkerPullRequestRepairTick(
        "worker.json",
        schedulePolicyDigest,
        roleIdentityPolicyDigest,
        factoryPolicyBundleDigest,
        { loadConfig, createRuntime, write: vi.fn() }
      )
    ).rejects.toThrow(/normalized absolute/u);
    await expect(
      runFactoryWorkerPullRequestRepairTick(
        configPath,
        "wrong",
        roleIdentityPolicyDigest,
        factoryPolicyBundleDigest,
        { loadConfig, createRuntime, write: vi.fn() }
      )
    ).rejects.toThrow(/schedule policy digest/u);
    expect(loadConfig).not.toHaveBeenCalled();

    const legacyLoad = vi.fn(() => Promise.resolve({} as LocalFactoryWorkerConfig));
    await expect(
      runFactoryWorkerPullRequestRepairTick(
        configPath,
        schedulePolicyDigest,
        roleIdentityPolicyDigest,
        factoryPolicyBundleDigest,
        { loadConfig: legacyLoad, createRuntime, write: vi.fn() }
      )
    ).rejects.toThrow(/worker config v3/u);
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it("rejects a forged report and aggregates cleanup failure", async () => {
    const forged = runnerDependencies(
      () => Promise.resolve({ ...report("completed"), roleIdentityPolicyDigest: testDigest("f") }),
      () => Promise.resolve(),
      vi.fn()
    );
    await expect(
      runFactoryWorkerPullRequestRepairTick(
        configPath,
        schedulePolicyDigest,
        roleIdentityPolicyDigest,
        factoryPolicyBundleDigest,
        forged
      )
    ).rejects.toThrow(/different reviewed policy/u);

    const tickFailure = new Error("tick failed");
    const cleanupFailure = new Error("cleanup failed");
    const ambiguous = runnerDependencies(
      () => Promise.reject(tickFailure),
      () => Promise.reject(cleanupFailure),
      vi.fn()
    );
    await expect(
      runFactoryWorkerPullRequestRepairTick(
        configPath,
        schedulePolicyDigest,
        roleIdentityPolicyDigest,
        factoryPolicyBundleDigest,
        ambiguous
      )
    ).rejects.toEqual(
      expect.objectContaining({
        name: "AggregateError",
        errors: [tickFailure, cleanupFailure]
      })
    );
  });
});

function runnerDependencies(
  tick: (input: unknown) => Promise<FactoryCanaryPullRequestRepairTickReport>,
  close: () => Promise<void>,
  write: (message: string) => void
): FactoryWorkerPullRequestRepairTickRunnerDependencies {
  return {
    loadConfig: () => Promise.resolve(config()),
    createRuntime: () => runtime(tick, close),
    write
  };
}

function runtime(
  tick: (input: unknown) => Promise<FactoryCanaryPullRequestRepairTickReport>,
  close: () => Promise<void> = () => Promise.resolve()
): LocalFactoryWorkerRuntime {
  const noResult = () => Promise.reject(new Error("Unexpected worker command."));
  return {
    commands: {
      preflight: noResult,
      advancePreparation: noResult,
      recoverPreparation: noResult,
      materializePreparation: noResult,
      admitExecution: noResult,
      execute: noResult,
      recoverExecution: noResult,
      executePullRequestRepair: noResult,
      recoverPullRequestRepair: noResult,
      runCanaryPullRequestRepairTick: tick,
      runTask: noResult,
      runScheduledTick: noResult
    },
    close
  };
}

function config(): LocalFactoryWorkerConfig {
  return {
    schemaVersion: "agentlab.local-factory-worker.v3",
    schedulePolicy: testFactorySchedulePolicy(),
    roleIdentityPolicy: {} as never
  } as unknown as LocalFactoryWorkerConfig;
}

function report(
  status: FactoryCanaryPullRequestRepairTickReport["status"],
  reasonCodes: readonly string[] = []
): FactoryCanaryPullRequestRepairTickReport {
  return {
    schemaVersion: "agentlab.canary-pull-request-repair-tick-result.v1",
    status,
    schedulePolicyDigest,
    factoryPolicyBundleDigest,
    roleIdentityPolicyDigest,
    observedAt: "2026-08-31T13:00:00.000Z",
    candidatesInspected: 0,
    recoveryAttempts: 0,
    repairAttempts: 0,
    repairRunsCreated: 0,
    proposalsCreated: 0,
    reservedUsage: emptyReservedUsage(),
    hasMore: false,
    reasonCodes,
    tasks: []
  };
}
