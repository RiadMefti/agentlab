import type {
  FactoryScheduleEvent,
  FactorySchedulePolicy,
  FactoryScheduleRun,
  Sha256Digest
} from "@agentlab/contracts";
import { describe, expect, it, vi } from "vitest";

import { FactorySchedulerService } from "../../packages/runtime/src/application/factory-scheduler-service.js";
import type { FactoryWorkerPreflight } from "../../packages/runtime/src/application/factory-worker-operator.js";
import type { FactoryWorkerTaskRunReport } from "../../packages/runtime/src/application/factory-worker-task-runner.js";
import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../../packages/runtime/src/domain/factory-documents.js";
import type { FactoryPreparationSnapshot } from "../../packages/runtime/src/domain/factory-preparation-repository.js";
import {
  assertFactoryScheduleEvent,
  assertFactoryScheduleRegistration,
  assertFactoryScheduleRun
} from "../../packages/runtime/src/domain/factory-schedule-integrity.js";
import type {
  FactoryScheduleRepository,
  FactoryScheduleRunSnapshot
} from "../../packages/runtime/src/domain/factory-schedule-repository.js";
import { NodeFactoryDocumentCodec } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { testDigest } from "../helpers/factory.js";
import { testFactoryPreparationFixture } from "../helpers/factory-preparation.js";
import {
  TEST_FACTORY_SCHEDULE_NOW,
  TEST_FACTORY_SCHEDULED_FOR,
  testFactoryScheduleBudget,
  testFactorySchedulePolicy
} from "../helpers/factory-schedule.js";

const factoryPolicyBundleDigest = testFactoryPreparationFixture().policyDigest;
const expectedCommand = (schedulePolicyDigest: Sha256Digest) => ({
  expectedSchedulePolicyDigest: schedulePolicyDigest,
  expectedFactoryPolicyBundleDigest: factoryPolicyBundleDigest
});

interface SchedulerTaskCommand {
  readonly taskId: string;
  readonly correlationId: string;
  readonly expectedPolicyBundleDigest: Sha256Digest;
}

describe("FactorySchedulerService", () => {
  it("claims within quota, completes once, and makes duplicate ticks side-effect free", async () => {
    const candidate = scheduledPreparation();
    const fixture = schedulerFixture({ candidates: [candidate] });

    await expect(
      fixture.service.tick(expectedCommand(fixture.schedulePolicy.digest))
    ).resolves.toMatchObject({
      status: "completed",
      tasksClaimed: 1,
      tasksFinished: 1,
      tasksSkipped: 0,
      reservedUsage: {
        wallClockSeconds: candidate.authority.budgetCeiling.wallClockSeconds,
        costMicrousd: candidate.authority.budgetCeiling.maxCostMicrousd
      }
    });
    await expect(
      fixture.service.tick(expectedCommand(fixture.schedulePolicy.digest))
    ).resolves.toMatchObject({
      status: "already-completed",
      tasksClaimed: 1,
      tasksFinished: 1
    });
    expect(fixture.runTask).toHaveBeenCalledOnce();
    expect(fixture.listScheduled).toHaveBeenCalledOnce();
    expect(
      (
        await fixture.schedules.findBySlot(
          fixture.schedulePolicy.value.id,
          TEST_FACTORY_SCHEDULED_FOR
        )
      )?.events.map(({ kind }) => kind)
    ).toEqual(["registered", "task-claimed", "task-finished", "completed"]);
  });

  it("reuses a durable task claim after an ambiguous crash", async () => {
    const candidate = scheduledPreparation();
    let attempts = 0;
    const fixture = schedulerFixture({
      candidates: [candidate],
      taskResult(command) {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new Error("worker result was not observed"))
          : Promise.resolve(taskResult(command.taskId, command.correlationId));
      }
    });
    const command = expectedCommand(fixture.schedulePolicy.digest);

    await expect(fixture.service.tick(command)).rejects.toThrow(/not observed/u);
    const active = await fixture.schedules.findBySlot(
      fixture.schedulePolicy.value.id,
      TEST_FACTORY_SCHEDULED_FOR
    );
    expect(active).toMatchObject({ state: "task-active", sequence: 2 });
    if (active?.lastEvent.kind !== "task-claimed") throw new Error("Expected durable task claim.");
    const taskCorrelationId = active.lastEvent.taskCorrelationId;

    await expect(fixture.service.tick(command)).resolves.toMatchObject({ status: "completed" });
    expect(fixture.runTask).toHaveBeenCalledTimes(2);
    expect(fixture.runTask.mock.calls.map(([input]) => input)).toEqual([
      {
        taskId: candidate.request.taskId,
        correlationId: taskCorrelationId,
        expectedPolicyBundleDigest: factoryPolicyBundleDigest
      },
      {
        taskId: candidate.request.taskId,
        correlationId: taskCorrelationId,
        expectedPolicyBundleDigest: factoryPolicyBundleDigest
      }
    ]);
  });

  it("finishes an open prior-day claim before admitting a new daily slot", async () => {
    const candidate = scheduledPreparation();
    let now = TEST_FACTORY_SCHEDULE_NOW;
    let attempts = 0;
    const fixture = schedulerFixture({
      candidates: [candidate],
      clock: () => now,
      taskResult(command) {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new Error("worker result was not observed"))
          : Promise.resolve(taskResult(command.taskId, command.correlationId));
      }
    });
    const command = expectedCommand(fixture.schedulePolicy.digest);

    await expect(fixture.service.tick(command)).rejects.toThrow(/not observed/u);
    now = "2026-09-01T12:05:00.000Z";
    await expect(fixture.service.tick(command)).resolves.toMatchObject({
      status: "completed",
      scheduledFor: TEST_FACTORY_SCHEDULED_FOR,
      tasksClaimed: 1,
      tasksFinished: 1
    });
    expect(fixture.runTask).toHaveBeenCalledTimes(2);
    await expect(
      fixture.schedules.findBySlot(fixture.schedulePolicy.value.id, "2026-09-01T12:00:00.000Z")
    ).resolves.toBeNull();
  });

  it("does not admit a second same-day slot after a schedule policy version change", async () => {
    const first = schedulerFixture();
    await expect(
      first.service.tick(expectedCommand(first.schedulePolicy.digest))
    ).resolves.toMatchObject({ status: "completed" });

    const second = schedulerFixture({
      policy: testFactorySchedulePolicy({ version: "1.0.1" }),
      schedules: first.schedules
    });
    await expect(
      second.service.tick(expectedCommand(second.schedulePolicy.digest))
    ).resolves.toMatchObject({
      status: "blocked",
      schedulePolicyDigest: first.schedulePolicy.digest,
      reasonCodes: ["schedule-slot-policy-drift"]
    });
    expect(second.preflight).not.toHaveBeenCalled();
    expect(second.listScheduled).not.toHaveBeenCalled();
  });

  it("blocks a new policy while an older policy has an open run", async () => {
    const candidate = scheduledPreparation();
    const first = schedulerFixture({
      candidates: [candidate],
      taskResult: () => Promise.reject(new Error("worker result was not observed"))
    });
    await expect(first.service.tick(expectedCommand(first.schedulePolicy.digest))).rejects.toThrow(
      /not observed/u
    );

    const second = schedulerFixture({
      policy: testFactorySchedulePolicy({ version: "1.0.1" }),
      schedules: first.schedules
    });
    await expect(
      second.service.tick(expectedCommand(second.schedulePolicy.digest))
    ).resolves.toMatchObject({
      status: "blocked",
      schedulePolicyDigest: first.schedulePolicy.digest,
      reasonCodes: ["open-schedule-policy-drift"]
    });
    expect(second.preflight).not.toHaveBeenCalled();
    expect(second.listScheduled).not.toHaveBeenCalled();
  });

  it("does not resume an open claim after the wall clock moves behind its journal", async () => {
    const candidate = scheduledPreparation();
    let now = TEST_FACTORY_SCHEDULE_NOW;
    const fixture = schedulerFixture({
      candidates: [candidate],
      clock: () => now,
      taskResult: () => Promise.reject(new Error("worker result was not observed"))
    });
    const command = expectedCommand(fixture.schedulePolicy.digest);
    await expect(fixture.service.tick(command)).rejects.toThrow(/not observed/u);

    now = "2026-08-31T12:04:59.999Z";
    await expect(fixture.service.tick(command)).resolves.toMatchObject({
      status: "blocked",
      reasonCodes: ["open-schedule-clock-regression"]
    });
    expect(fixture.runTask).toHaveBeenCalledOnce();
  });

  it("records an over-budget candidate as skipped before any model work", async () => {
    const candidate = scheduledPreparation();
    const policy = testFactorySchedulePolicy({
      maximumTasksPerTick: 1,
      tickBudget: testFactoryScheduleBudget({
        maxCostMicrousd: candidate.authority.budgetCeiling.maxCostMicrousd - 1
      })
    });
    const fixture = schedulerFixture({ candidates: [candidate], policy });

    await expect(
      fixture.service.tick(expectedCommand(fixture.schedulePolicy.digest))
    ).resolves.toMatchObject({
      status: "completed",
      tasksClaimed: 0,
      tasksFinished: 0,
      tasksSkipped: 1
    });
    expect(fixture.runTask).not.toHaveBeenCalled();
    expect(
      (
        await fixture.schedules.findBySlot(
          fixture.schedulePolicy.value.id,
          TEST_FACTORY_SCHEDULED_FOR
        )
      )?.events.map(({ kind }) => kind)
    ).toEqual(["registered", "task-skipped", "completed"]);
  });

  it("does not create work after a missed deadline or while authority is disabled", async () => {
    const missed = schedulerFixture({ now: "2026-08-31T12:30:00.001Z" });
    await expect(
      missed.service.tick(expectedCommand(missed.schedulePolicy.digest))
    ).resolves.toMatchObject({
      status: "missed-deadline",
      runId: null,
      reasonCodes: ["schedule-start-deadline-missed"]
    });
    expect(missed.preflight).not.toHaveBeenCalled();

    const blocked = schedulerFixture({
      preflight: {
        ...readyPreflight(testDigest("0")),
        status: "blocked",
        schedulerEnabled: false,
        reasonCodes: ["scheduler-disabled"]
      }
    });
    await expect(
      blocked.service.tick(expectedCommand(blocked.schedulePolicy.digest))
    ).resolves.toMatchObject({
      status: "blocked",
      runId: null,
      reasonCodes: ["scheduler-disabled"]
    });
    expect(blocked.listScheduled).not.toHaveBeenCalled();
  });

  it("rejects policy pin drift before reading authority or candidates", async () => {
    const fixture = schedulerFixture();

    await expect(
      fixture.service.tick({
        expectedSchedulePolicyDigest: testDigest("9"),
        expectedFactoryPolicyBundleDigest: factoryPolicyBundleDigest
      })
    ).rejects.toThrow(/schedule policy changed/u);
    expect(fixture.preflight).not.toHaveBeenCalled();
    expect(fixture.listScheduled).not.toHaveBeenCalled();
  });
});

function schedulerFixture(
  options: {
    readonly candidates?: readonly FactoryPreparationSnapshot[];
    readonly now?: string;
    readonly clock?: () => string;
    readonly policy?: FactorySchedulePolicy;
    readonly schedules?: MemoryScheduleRepository;
    readonly preflight?: FactoryWorkerPreflight;
    readonly taskResult?: (command: SchedulerTaskCommand) => Promise<FactoryWorkerTaskRunReport>;
  } = {}
) {
  const documents = new NodeFactoryDocumentCodec();
  const schedulePolicy = documents.schedulePolicy(options.policy ?? testFactorySchedulePolicy());
  const schedules = options.schedules ?? new MemoryScheduleRepository(documents);
  const listScheduled = vi.fn(() => Promise.resolve(options.candidates ?? []));
  const preflight = vi.fn(() =>
    Promise.resolve(options.preflight ?? readyPreflight(schedulePolicy.digest))
  );
  const runTask = vi.fn((command: SchedulerTaskCommand) =>
    options.taskResult === undefined
      ? Promise.resolve(taskResult(command.taskId, command.correlationId))
      : options.taskResult(command)
  );
  const service = new FactorySchedulerService({
    schedulePolicy,
    factoryPolicyBundleDigest,
    schedules,
    preparations: { listScheduled },
    worker: { preflight },
    taskRunner: { run: runTask },
    documents,
    now: options.clock ?? (() => options.now ?? TEST_FACTORY_SCHEDULE_NOW),
    createId: sequentialId()
  });
  return { service, schedulePolicy, schedules, listScheduled, preflight, runTask };
}

function readyPreflight(schedulePolicyDigest: Sha256Digest): FactoryWorkerPreflight {
  return {
    schemaVersion: "agentlab.worker-preflight.v2",
    status: "ready",
    policyBundleDigest: factoryPolicyBundleDigest,
    schedulePolicyDigest,
    schedulerEnabled: true,
    costPolicyConfigured: true,
    hostReady: true,
    configuredProviders: ["codex"],
    gateIds: ["architecture", "build", "format", "lint", "secret-scan", "test", "typecheck"],
    reasonCodes: []
  };
}

function taskResult(taskId: string, correlationId: string): FactoryWorkerTaskRunReport {
  return {
    schemaVersion: "agentlab.worker-task-run.v1",
    status: "stopped",
    taskId,
    correlationId,
    policyBundleDigest: factoryPolicyBundleDigest,
    preparationState: "needs-human",
    taskState: null,
    contractDigest: null,
    reasonCodes: ["qualification-needs-human"]
  };
}

function scheduledPreparation(): FactoryPreparationSnapshot {
  const fixture = testFactoryPreparationFixture();
  const request = fixture.documents.intakeRequest({ ...fixture.request, trigger: "scheduled" });
  const authority = fixture.documents.preparationAuthority({
    ...fixture.authority,
    requestDigest: request.digest,
    expiresAt: "2026-09-01T12:01:00.000Z"
  });
  return {
    request: request.value,
    requestDigest: request.digest,
    authority: authority.value,
    authorityDigest: authority.digest,
    state: "registered",
    sequence: 1,
    lastEvent: { reasonCode: "request-registered" } as FactoryPreparationSnapshot["lastEvent"],
    lastEventDigest: testDigest("8")
  };
}

class MemoryScheduleRepository implements FactoryScheduleRepository {
  readonly #runs = new Map<
    string,
    {
      readonly run: CanonicalFactoryDocument<FactoryScheduleRun>;
      readonly events: CanonicalFactoryDocument<FactoryScheduleEvent>[];
    }
  >();

  public constructor(private readonly documents: FactoryDocumentCodec) {}

  public register(
    run: CanonicalFactoryDocument<FactoryScheduleRun>,
    initialEvent: CanonicalFactoryDocument<FactoryScheduleEvent>
  ): Promise<FactoryScheduleRunSnapshot> {
    assertFactoryScheduleRun(run, this.documents);
    assertFactoryScheduleRegistration(run, initialEvent);
    const key = slotKey(run.value.schedulePolicy.id, run.value.scheduledFor);
    if (this.#runs.has(key)) return Promise.reject(new Error("Schedule slot already exists."));
    this.#runs.set(key, { run, events: [initialEvent] });
    return Promise.resolve(snapshot(run, [initialEvent]));
  }

  public findById(runId: string): Promise<FactoryScheduleRunSnapshot | null> {
    const stored = [...this.#runs.values()].find(({ run }) => run.value.runId === runId);
    return Promise.resolve(stored === undefined ? null : snapshot(stored.run, stored.events));
  }

  public findBySlot(
    schedulePolicyId: string,
    scheduledFor: string
  ): Promise<FactoryScheduleRunSnapshot | null> {
    const stored = this.#runs.get(slotKey(schedulePolicyId, scheduledFor));
    return Promise.resolve(stored === undefined ? null : snapshot(stored.run, stored.events));
  }

  public findOpen(): Promise<FactoryScheduleRunSnapshot | null> {
    const open = [...this.#runs.values()].filter(({ events }) => {
      return events.at(-1)?.value.to !== "completed";
    });
    if (open.length > 1) throw new Error("Factory scheduler has multiple open runs.");
    const stored = open[0];
    return Promise.resolve(stored === undefined ? null : snapshot(stored.run, stored.events));
  }

  public listEvents(runId: string): Promise<readonly FactoryScheduleEvent[]> {
    const stored = [...this.#runs.values()].find(({ run }) => run.value.runId === runId);
    return Promise.resolve(stored?.events.map(({ value }) => value) ?? []);
  }

  public append(
    event: CanonicalFactoryDocument<FactoryScheduleEvent>
  ): Promise<FactoryScheduleRunSnapshot | null> {
    const stored = [...this.#runs.values()].find(
      ({ run }) => run.value.runId === event.value.runId
    );
    if (stored === undefined) return Promise.resolve(null);
    assertFactoryScheduleEvent(stored.run, event, stored.events);
    stored.events.push(event);
    return Promise.resolve(snapshot(stored.run, stored.events));
  }

  public close(): void {
    this.#runs.clear();
  }
}

function snapshot(
  run: CanonicalFactoryDocument<FactoryScheduleRun>,
  events: readonly CanonicalFactoryDocument<FactoryScheduleEvent>[]
): FactoryScheduleRunSnapshot {
  const last = events.at(-1);
  if (last === undefined) throw new Error("Schedule test snapshot requires an event.");
  return {
    run: run.value,
    runDigest: run.digest,
    state: last.value.to,
    sequence: last.value.sequence,
    lastEvent: last.value,
    lastEventDigest: last.digest,
    events: events.map(({ value }) => value)
  };
}

function slotKey(schedulePolicyId: string, scheduledFor: string): string {
  return `${schedulePolicyId}:${scheduledFor}`;
}

function sequentialId(): () => string {
  let value = 0;
  return () => {
    value += 1;
    return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
  };
}
