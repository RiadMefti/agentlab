import type { FactoryPreparationState, FactoryTaskState, Sha256Digest } from "@agentlab/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  FactoryWorkerTaskRunner,
  type FactoryWorkerTaskRunnerDependencies
} from "../../packages/runtime/src/application/factory-worker-task-runner.js";
import type { FactoryExecutionOutcome } from "../../packages/runtime/src/application/factory-execution-service.js";
import type { FactoryExecutionSnapshot } from "../../packages/runtime/src/domain/factory-execution-repository.js";
import type { FactoryPreparationSnapshot } from "../../packages/runtime/src/domain/factory-preparation-repository.js";
import type { FactoryTaskSnapshot } from "../../packages/runtime/src/domain/factory-task-repository.js";
import {
  TEST_FACTORY_CORRELATION_ID,
  TEST_FACTORY_TASK_ID,
  testDigest,
  testFactoryContract
} from "../helpers/factory.js";
import { testFactoryPreparationFixture } from "../helpers/factory-preparation.js";

const policyBundleDigest = testFactoryPreparationFixture().policyDigest;
const command = {
  taskId: TEST_FACTORY_TASK_ID,
  correlationId: TEST_FACTORY_CORRELATION_ID,
  expectedPolicyBundleDigest: policyBundleDigest
};

describe("FactoryWorkerTaskRunner", () => {
  it("advances one registered task through preparation, admission, and reviewed proposal", async () => {
    let currentPreparation = preparation("registered");
    let currentTask: FactoryTaskSnapshot | null = null;
    const events: string[] = [];
    const stableStates: FactoryPreparationState[] = ["qualified", "specified", "planned"];
    const planned = task("planned");
    const queued = task("queued");
    const proposed = task("pr-proposed");
    const worker = workerOperations({
      advancePreparation: () => {
        events.push("advance-preparation");
        const state = stableStates.shift();
        if (state === undefined) throw new Error("Unexpected preparation advance.");
        currentPreparation = preparation(state);
        return Promise.resolve(currentPreparation);
      },
      materializePreparation: () => {
        events.push("materialize-preparation");
        currentPreparation = preparation("prepared");
        currentTask = planned;
        return Promise.resolve({
          preparation: currentPreparation,
          task: planned,
          preparationBundleDigest: testDigest("b"),
          evidenceBundleDigest: testDigest("e")
        });
      },
      admitExecution: () => {
        events.push("admit-execution");
        currentTask = queued;
        return Promise.resolve({
          status: "queued",
          task: queued,
          decision: null,
          policyEvidenceDigest: null
        });
      },
      execute: () => {
        events.push("execute");
        currentTask = proposed;
        return Promise.resolve(executionOutcome(proposed));
      }
    });
    const runner = taskRunner({
      preparations: { findById: () => Promise.resolve(currentPreparation) },
      tasks: { findById: () => Promise.resolve(currentTask) },
      executions: { findByTaskId: () => Promise.resolve(null) },
      worker
    });

    await expect(runner.run(command)).resolves.toEqual({
      schemaVersion: "agentlab.worker-task-run.v1",
      status: "ready-for-broker",
      taskId: TEST_FACTORY_TASK_ID,
      correlationId: TEST_FACTORY_CORRELATION_ID,
      policyBundleDigest,
      preparationState: "prepared",
      taskState: "pr-proposed",
      contractDigest: testDigest("c"),
      reasonCodes: []
    });
    expect(events).toEqual([
      "advance-preparation",
      "advance-preparation",
      "advance-preparation",
      "materialize-preparation",
      "admit-execution",
      "execute"
    ]);
  });

  it("reconciles an interrupted preparation before resuming its stable checkpoint", async () => {
    let currentPreparation = preparation("qualifying");
    const events: string[] = [];
    const worker = workerOperations({
      recoverPreparation: () => {
        events.push("recover-preparation");
        currentPreparation = preparation("needs-human");
        return Promise.resolve(currentPreparation);
      }
    });
    const runner = taskRunner({
      preparations: { findById: () => Promise.resolve(currentPreparation) },
      tasks: { findById: () => Promise.resolve(null) },
      worker
    });

    await expect(runner.run(command)).resolves.toMatchObject({
      status: "stopped",
      preparationState: "needs-human",
      taskState: null,
      reasonCodes: ["preparation-needs-human", "preparation-needs-human-event"]
    });
    expect(events).toEqual(["recover-preparation"]);
  });

  it("recovers an interrupted execution and never starts another execution", async () => {
    const prepared = preparation("prepared");
    const executing = task("executing");
    const failed = task("failed", "execution-interrupted");
    const activeExecution = executionJournal("operation-active", executing.contractDigest);
    const abandonedExecution = executionJournal("abandoned", executing.contractDigest);
    const recoverExecution = vi.fn(() =>
      Promise.resolve({ execution: abandonedExecution, task: failed })
    );
    const execute = vi.fn(() => Promise.resolve(executionOutcome(task("pr-proposed"))));
    const runner = taskRunner({
      preparations: { findById: () => Promise.resolve(prepared) },
      tasks: { findById: () => Promise.resolve(executing) },
      executions: { findByTaskId: () => Promise.resolve(activeExecution) },
      worker: workerOperations({ recoverExecution, execute })
    });

    await expect(runner.run(command)).resolves.toMatchObject({
      status: "stopped",
      taskState: "failed",
      reasonCodes: ["execution-interrupted", "execution-recovered"]
    });
    expect(recoverExecution).toHaveBeenCalledWith({
      taskId: TEST_FACTORY_TASK_ID,
      correlationId: TEST_FACTORY_CORRELATION_ID
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns an already completed proposal without invoking model-bearing work", async () => {
    const prepared = preparation("prepared");
    const proposed = task("pr-proposed");
    const worker = workerOperations();
    const runner = taskRunner({
      preparations: { findById: () => Promise.resolve(prepared) },
      tasks: { findById: () => Promise.resolve(proposed) },
      executions: {
        findByTaskId: () => Promise.resolve(executionJournal("completed", proposed.contractDigest))
      },
      worker
    });

    await expect(runner.run(command)).resolves.toMatchObject({
      status: "ready-for-broker",
      taskState: "pr-proposed",
      reasonCodes: []
    });
    expect(worker.advancePreparation).not.toHaveBeenCalled();
    expect(worker.admitExecution).not.toHaveBeenCalled();
    expect(worker.execute).not.toHaveBeenCalled();
  });

  it("rejects policy drift before reading or mutating durable task state", async () => {
    const findPreparation = vi.fn(() => Promise.resolve(preparation("registered")));
    const worker = workerOperations();
    const runner = taskRunner({
      preparations: { findById: findPreparation },
      worker
    });

    await expect(
      runner.run({ ...command, expectedPolicyBundleDigest: testDigest("9") })
    ).rejects.toThrow(/confirmed digest/u);
    expect(findPreparation).not.toHaveBeenCalled();
    expect(worker.advancePreparation).not.toHaveBeenCalled();
  });

  it("fails closed when durable preparation and task ledgers disagree", async () => {
    const runner = taskRunner({
      preparations: { findById: () => Promise.resolve(preparation("prepared")) },
      tasks: { findById: () => Promise.resolve(null) }
    });

    await expect(runner.run(command)).rejects.toThrow(/materialization are inconsistent/u);

    const prepared = preparation("prepared");
    const wrongContractPreparation: FactoryPreparationSnapshot = {
      ...prepared,
      lastEvent: {
        ...prepared.lastEvent,
        contractDigest: testDigest("9")
      } as FactoryPreparationSnapshot["lastEvent"]
    };
    const wrongContractRunner = taskRunner({
      preparations: { findById: () => Promise.resolve(wrongContractPreparation) },
      tasks: { findById: () => Promise.resolve(task("planned")) }
    });
    await expect(wrongContractRunner.run(command)).rejects.toThrow(/task ledger does not match/u);
  });

  it("does not report broker readiness without a patch and complete usage", async () => {
    const prepared = preparation("prepared");
    const queued = task("queued");
    const proposed = task("pr-proposed");
    const incomplete = { ...executionOutcome(proposed), patch: null, usageComplete: false };
    const runner = taskRunner({
      preparations: { findById: () => Promise.resolve(prepared) },
      tasks: { findById: () => Promise.resolve(queued) },
      worker: workerOperations({ execute: () => Promise.resolve(incomplete) })
    });

    await expect(runner.run(command)).rejects.toThrow(/patch or complete usage/u);
  });
});

function taskRunner(
  overrides: Partial<FactoryWorkerTaskRunnerDependencies>
): FactoryWorkerTaskRunner {
  return new FactoryWorkerTaskRunner({
    policyBundleDigest,
    preparations: { findById: () => Promise.resolve(preparation("registered")) },
    tasks: { findById: () => Promise.resolve(null) },
    executions: { findByTaskId: () => Promise.resolve(null) },
    worker: workerOperations(),
    ...overrides
  });
}

function workerOperations(
  overrides: Partial<FactoryWorkerTaskRunnerDependencies["worker"]> = {}
): FactoryWorkerTaskRunnerDependencies["worker"] {
  const noResult = () => Promise.reject(new Error("Unexpected worker operation."));
  return {
    advancePreparation: vi.fn(noResult),
    recoverPreparation: vi.fn(noResult),
    materializePreparation: vi.fn(noResult),
    admitExecution: vi.fn(noResult),
    execute: vi.fn(noResult),
    recoverExecution: vi.fn(noResult),
    ...overrides
  };
}

function preparation(state: FactoryPreparationState): FactoryPreparationSnapshot {
  const fixture = testFactoryPreparationFixture();
  return {
    request: fixture.request,
    requestDigest: fixture.authority.requestDigest,
    authority: fixture.authority,
    authorityDigest: testDigest("a"),
    state,
    sequence: 1,
    lastEvent: {
      ...(state === "prepared" ? { kind: "prepared", contractDigest: testDigest("c") } : {}),
      reasonCode: `preparation-${state}-event`
    } as FactoryPreparationSnapshot["lastEvent"],
    lastEventDigest: testDigest("f")
  };
}

function task(state: FactoryTaskState, reasonCode = `task-${state}-event`): FactoryTaskSnapshot {
  return {
    contract: testFactoryContract(),
    contractDigest: testDigest("c"),
    state,
    sequence: 5,
    lastEvent: { reasonCode } as FactoryTaskSnapshot["lastEvent"],
    lastEventDigest: testDigest("d")
  };
}

function executionJournal(
  state: FactoryExecutionSnapshot["state"],
  contractDigest: Sha256Digest
): FactoryExecutionSnapshot {
  return {
    run: {
      taskId: TEST_FACTORY_TASK_ID,
      contractDigest
    } as FactoryExecutionSnapshot["run"],
    runDigest: testDigest("7"),
    state,
    sequence: 1,
    lastEvent: {} as FactoryExecutionSnapshot["lastEvent"],
    lastEventDigest: testDigest("8")
  };
}

function executionOutcome(taskSnapshot: FactoryTaskSnapshot): FactoryExecutionOutcome {
  const status = taskSnapshot.state;
  if (
    status !== "pr-proposed" &&
    status !== "failed" &&
    status !== "needs-attention" &&
    status !== "quarantined"
  ) {
    throw new Error(`Test task state ${status} is not an execution outcome.`);
  }
  return {
    status,
    task: taskSnapshot,
    patch:
      status === "pr-proposed"
        ? ({ digest: testDigest("5") } as FactoryExecutionOutcome["patch"])
        : null,
    reviews: [],
    usage: {
      wallClockSeconds: 0,
      agentTurns: 0,
      toolCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      costMicrousd: 0,
      processes: 0,
      outputBytes: 0,
      workers: 0,
      repairAttempts: 0,
      changedFiles: 0,
      changedLines: 0
    },
    usageComplete: true
  };
}
