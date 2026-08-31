import type {
  FactoryWorkerPreflight,
  FactoryWorkerTaskRunReport,
  LocalFactoryWorkerConfig,
  LocalFactoryWorkerRuntime
} from "@agentlab/runtime/factory-worker";
import { describe, expect, it, vi } from "vitest";

import {
  runFactoryWorkerTask,
  type FactoryWorkerTaskRunnerDependencies
} from "../../apps/tui/src/run-factory-worker-task.js";

const taskId = "0198f005-4ec4-7000-8000-000000000001";
const correlationId = "0198f005-4ec4-7000-8000-000000000002";
const policyBundleDigest = `sha256:${"a".repeat(64)}` as const;
const contractDigest = `sha256:${"b".repeat(64)}` as const;

describe("factory worker task CLI runner", () => {
  it("runs an explicitly confirmed task while autonomous scheduling remains disabled", async () => {
    const fixture = runnerDependencies();

    await expect(
      runFactoryWorkerTask(
        "/private/agentlab/worker.json",
        taskId,
        policyBundleDigest,
        "run-task",
        fixture.dependencies
      )
    ).resolves.toBe(0);

    expect(fixture.runTask).toHaveBeenCalledWith({
      taskId,
      correlationId,
      expectedPolicyBundleDigest: policyBundleDigest
    });
    expect(fixture.close).toHaveBeenCalledOnce();
    expect(JSON.parse(fixture.output.join(""))).toEqual({
      schemaVersion: "agentlab.worker-run-command-result.v1",
      status: "ready-for-broker",
      taskId,
      policyBundleDigest,
      reasonCodes: [],
      run: {
        schemaVersion: "agentlab.worker-task-run.v1",
        correlationId,
        preparationState: "prepared",
        taskState: "pr-proposed",
        contractDigest
      }
    });
  });

  it("blocks host or policy drift before invoking task work", async () => {
    const fixture = runnerDependencies({
      preflight: {
        ...preflight(),
        status: "blocked",
        hostReady: false,
        reasonCodes: ["scheduler-disabled", "bubblewrap-unavailable"]
      }
    });

    await expect(
      runFactoryWorkerTask(
        "/private/agentlab/worker.json",
        taskId,
        `sha256:${"9".repeat(64)}`,
        "run-task",
        fixture.dependencies
      )
    ).resolves.toBe(2);

    expect(fixture.runTask).not.toHaveBeenCalled();
    expect(JSON.parse(fixture.output.join(""))).toMatchObject({
      status: "blocked",
      reasonCodes: ["bubblewrap-unavailable", "policy-bundle-digest-mismatch"],
      run: null
    });
  });

  it("returns a nonzero policy result when execution stops safely", async () => {
    const fixture = runnerDependencies({
      report: {
        ...taskReport(),
        status: "stopped",
        taskState: "needs-attention",
        reasonCodes: ["review-rejected"]
      }
    });

    await expect(
      runFactoryWorkerTask(
        "/private/agentlab/worker.json",
        taskId,
        policyBundleDigest,
        "run-task",
        fixture.dependencies
      )
    ).resolves.toBe(2);
    expect(JSON.parse(fixture.output.join(""))).toMatchObject({
      status: "stopped",
      reasonCodes: ["review-rejected"]
    });
  });

  it("closes the worker after a failed run and rejects malformed authority input", async () => {
    const fixture = runnerDependencies({ runError: new Error("task failed") });
    await expect(
      runFactoryWorkerTask(
        "/private/agentlab/worker.json",
        taskId,
        policyBundleDigest,
        "run-task",
        fixture.dependencies
      )
    ).rejects.toThrow("task failed");
    expect(fixture.close).toHaveBeenCalledOnce();

    await expect(
      runFactoryWorkerTask(
        "relative.json",
        taskId,
        policyBundleDigest,
        "run-task",
        fixture.dependencies
      )
    ).rejects.toThrow(/normalized absolute/u);
    await expect(
      runFactoryWorkerTask(
        "/private/agentlab/worker.json",
        taskId,
        policyBundleDigest,
        "wrong-confirmation",
        fixture.dependencies
      )
    ).rejects.toThrow(/explicit run confirmation/u);
  });
});

function runnerDependencies(
  options: {
    readonly preflight?: FactoryWorkerPreflight;
    readonly report?: FactoryWorkerTaskRunReport;
    readonly runError?: Error;
  } = {}
) {
  const output: string[] = [];
  const close = vi.fn(() => Promise.resolve());
  const runTask = vi.fn(() =>
    options.runError === undefined
      ? Promise.resolve(options.report ?? taskReport())
      : Promise.reject(options.runError)
  );
  const noResult = () => Promise.reject(new Error("Unexpected worker command."));
  const runtime: LocalFactoryWorkerRuntime = {
    commands: {
      preflight: () => Promise.resolve(options.preflight ?? preflight()),
      advancePreparation: noResult,
      recoverPreparation: noResult,
      materializePreparation: noResult,
      admitExecution: noResult,
      execute: noResult,
      recoverExecution: noResult,
      executePullRequestRepair: noResult,
      recoverPullRequestRepair: noResult,
      runTask,
      runScheduledTick: noResult
    },
    close
  };
  const dependencies: FactoryWorkerTaskRunnerDependencies = {
    loadConfig: () => Promise.resolve({} as LocalFactoryWorkerConfig),
    createRuntime: () => runtime,
    createCorrelationId: () => correlationId,
    write: (message) => output.push(message)
  };
  return { dependencies, output, runTask, close };
}

function preflight(): FactoryWorkerPreflight {
  return {
    schemaVersion: "agentlab.worker-preflight.v2",
    status: "blocked",
    policyBundleDigest,
    schedulePolicyDigest: null,
    schedulerEnabled: false,
    costPolicyConfigured: true,
    hostReady: true,
    configuredProviders: ["codex"],
    gateIds: ["architecture", "build", "format", "lint", "secret-scan", "test", "typecheck"],
    reasonCodes: ["schedule-policy-unconfigured", "scheduler-disabled"]
  };
}

function taskReport(): FactoryWorkerTaskRunReport {
  return {
    schemaVersion: "agentlab.worker-task-run.v1",
    status: "ready-for-broker",
    taskId,
    correlationId,
    policyBundleDigest,
    preparationState: "prepared",
    taskState: "pr-proposed",
    contractDigest,
    reasonCodes: []
  };
}
