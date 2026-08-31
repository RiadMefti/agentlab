import type {
  FactorySchedulerTickReport,
  LocalFactoryWorkerConfig,
  LocalFactoryWorkerRuntime
} from "@agentlab/runtime/factory-worker";
import { describe, expect, it, vi } from "vitest";

import {
  runFactorySchedulerTick,
  type FactorySchedulerTickRunnerDependencies
} from "../../apps/tui/src/run-factory-scheduler-tick.js";
import { emptyReservedUsage } from "../../packages/runtime/src/domain/factory-schedule-integrity.js";
import { testDigest } from "../helpers/factory.js";
import {
  TEST_FACTORY_SCHEDULE_DEADLINE,
  TEST_FACTORY_SCHEDULED_FOR,
  testFactorySchedulePolicy
} from "../helpers/factory-schedule.js";

const configPath = "/private/agentlab/worker.json";
const schedulePolicyDigest = testDigest("1");
const factoryPolicyBundleDigest = testDigest("2");

describe("factory scheduler tick CLI runner", () => {
  it("passes exact policy pins and emits only after clean shutdown", async () => {
    const events: string[] = [];
    const output: string[] = [];
    const runScheduledTick = vi.fn(() => Promise.resolve(report("completed")));
    const close = vi.fn(() => Promise.resolve(events.push("close")).then(() => undefined));
    const dependencies = runnerDependencies(runScheduledTick, close, (message) => {
      events.push("write");
      output.push(message);
    });

    await expect(
      runFactorySchedulerTick(
        configPath,
        schedulePolicyDigest,
        factoryPolicyBundleDigest,
        dependencies
      )
    ).resolves.toBe(0);

    expect(runScheduledTick).toHaveBeenCalledWith({
      expectedSchedulePolicyDigest: schedulePolicyDigest,
      expectedFactoryPolicyBundleDigest: factoryPolicyBundleDigest
    });
    expect(events).toEqual(["close", "write"]);
    expect(JSON.parse(output.join(""))).toEqual(report("completed"));
  });

  it("returns a distinct nonzero result for a blocked or missed slot", async () => {
    const blocked = runnerDependencies(
      () => Promise.resolve(report("blocked", ["scheduler-disabled"])),
      () => Promise.resolve(),
      vi.fn()
    );
    await expect(
      runFactorySchedulerTick(configPath, schedulePolicyDigest, factoryPolicyBundleDigest, blocked)
    ).resolves.toBe(2);
  });

  it("rejects malformed pins and a v1 config before creating a runtime", async () => {
    const loadConfig = vi.fn(() => Promise.resolve(config()));
    const createRuntime = vi.fn(() => runtime(() => Promise.resolve(report("completed"))));

    await expect(
      runFactorySchedulerTick("worker.json", schedulePolicyDigest, factoryPolicyBundleDigest, {
        loadConfig,
        createRuntime,
        write: vi.fn()
      })
    ).rejects.toThrow(/normalized absolute/u);
    await expect(
      runFactorySchedulerTick(configPath, "wrong", factoryPolicyBundleDigest, {
        loadConfig,
        createRuntime,
        write: vi.fn()
      })
    ).rejects.toThrow(/schedule policy digest/u);
    expect(loadConfig).not.toHaveBeenCalled();

    const v1Load = vi.fn(() => Promise.resolve({} as LocalFactoryWorkerConfig));
    await expect(
      runFactorySchedulerTick(configPath, schedulePolicyDigest, factoryPolicyBundleDigest, {
        loadConfig: v1Load,
        createRuntime,
        write: vi.fn()
      })
    ).rejects.toThrow(/v2 worker config/u);
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it("closes after a tick failure and aggregates an ambiguous cleanup failure", async () => {
    const tickFailure = new Error("tick failed");
    const cleanupFailure = new Error("cleanup failed");
    const dependencies = runnerDependencies(
      () => Promise.reject(tickFailure),
      () => Promise.reject(cleanupFailure),
      vi.fn()
    );

    await expect(
      runFactorySchedulerTick(
        configPath,
        schedulePolicyDigest,
        factoryPolicyBundleDigest,
        dependencies
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
  runScheduledTick: (input: unknown) => Promise<FactorySchedulerTickReport>,
  close: () => Promise<void>,
  write: (message: string) => void
): FactorySchedulerTickRunnerDependencies {
  return {
    loadConfig: () => Promise.resolve(config()),
    createRuntime: () => runtime(runScheduledTick, close),
    write
  };
}

function runtime(
  runScheduledTick: (input: unknown) => Promise<FactorySchedulerTickReport>,
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
      runTask: noResult,
      runScheduledTick
    },
    close
  };
}

function config(): LocalFactoryWorkerConfig {
  return {
    schemaVersion: "agentlab.local-factory-worker.v2",
    schedulePolicy: testFactorySchedulePolicy()
  } as unknown as LocalFactoryWorkerConfig;
}

function report(
  status: FactorySchedulerTickReport["status"],
  reasonCodes: readonly string[] = []
): FactorySchedulerTickReport {
  return {
    schemaVersion: "agentlab.scheduler-tick-result.v1",
    status,
    schedulePolicyDigest,
    factoryPolicyBundleDigest,
    scheduledFor: TEST_FACTORY_SCHEDULED_FOR,
    deadlineAt: TEST_FACTORY_SCHEDULE_DEADLINE,
    runId:
      status === "blocked" || status === "missed-deadline"
        ? null
        : "10000000-0000-4000-8000-000000000001",
    runDigest: status === "blocked" || status === "missed-deadline" ? null : testDigest("3"),
    tasksClaimed: 0,
    tasksFinished: 0,
    tasksSkipped: 0,
    reservedUsage: emptyReservedUsage(),
    reasonCodes
  };
}
