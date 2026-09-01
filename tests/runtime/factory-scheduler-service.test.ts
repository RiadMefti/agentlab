import type {
  FactoryScheduleEvent,
  FactorySchedulePolicy,
  FactoryScheduleRun,
  FactoryDailyQuotaReservation,
  Sha256Digest
} from "@agentlab/contracts";
import { describe, expect, it, vi } from "vitest";

import { FactorySchedulerService } from "../../packages/runtime/src/application/factory-scheduler-service.js";
import { FactoryDailyQuotaService } from "../../packages/runtime/src/application/factory-daily-quota-service.js";
import type {
  FactoryDailyQuotaRepository,
  FactoryDailyQuotaReservationSnapshot
} from "../../packages/runtime/src/domain/factory-daily-quota-repository.js";
import type { FactoryWorkerPreflight } from "../../packages/runtime/src/application/factory-worker-operator.js";
import type { FactoryWorkerTaskRunReport } from "../../packages/runtime/src/application/factory-worker-task-runner.js";
import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../../packages/runtime/src/domain/factory-documents.js";
import type { FactoryPreparationSnapshot } from "../../packages/runtime/src/domain/factory-preparation-repository.js";
import type { FactoryCanaryReservationSnapshot } from "../../packages/runtime/src/domain/factory-canary-reservation-repository.js";
import {
  assertFactoryScheduleEvent,
  assertFactoryScheduleRegistration,
  assertFactoryScheduleRun
} from "../../packages/runtime/src/domain/factory-schedule-integrity.js";
import type {
  FactoryScheduleRepository,
  FactoryScheduleRunSnapshot,
  FactoryScheduledTaskCompletion
} from "../../packages/runtime/src/domain/factory-schedule-repository.js";
import { NodeFactoryDocumentCodec } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { testDigest } from "../helpers/factory.js";
import { testFactoryDailyQuotaPolicy } from "../helpers/factory-daily-quota.js";
import {
  testFactoryCanaryAdmissionFixture,
  testFactoryCanaryReservationDocument
} from "../helpers/factory-canary-admission.js";
import { TEST_ROLE_IDENTITY_POLICY_DIGEST } from "../helpers/factory-evaluation.js";
import { testFactoryPreparationFixture } from "../helpers/factory-preparation.js";
import {
  TEST_FACTORY_SCHEDULE_DEADLINE,
  TEST_FACTORY_SCHEDULE_NOW,
  TEST_FACTORY_SCHEDULED_FOR,
  testFactoryScheduleBudget,
  testFactorySchedulePolicy
} from "../helpers/factory-schedule.js";

const factoryPolicyBundleDigest = testFactoryPreparationFixture().policyDigest;
const roleIdentityPolicyDigest = TEST_ROLE_IDENTITY_POLICY_DIGEST;
const dailyQuotaPolicyDigest = new NodeFactoryDocumentCodec().dailyQuotaPolicy(
  testFactoryDailyQuotaPolicy()
).digest;
const expectedCommand = (schedulePolicyDigest: Sha256Digest) => ({
  expectedSchedulePolicyDigest: schedulePolicyDigest,
  expectedFactoryPolicyBundleDigest: factoryPolicyBundleDigest,
  expectedDailyQuotaPolicyDigest: dailyQuotaPolicyDigest
});

interface SchedulerTaskCommand {
  readonly taskId: string;
  readonly correlationId: string;
  readonly expectedPolicyBundleDigest: Sha256Digest;
  readonly canaryReservationDigest: Sha256Digest;
}

interface ScheduledPreparation extends FactoryPreparationSnapshot {
  readonly canaryReservation: FactoryCanaryReservationSnapshot;
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
    const stored = await fixture.schedules.findBySlot(
      fixture.schedulePolicy.value.id,
      TEST_FACTORY_SCHEDULED_FOR
    );
    expect(stored?.run).toMatchObject({
      schemaVersion: "agentlab.schedule-run.v3",
      roleIdentityPolicyDigest
    });
    expect(stored?.events.map(({ kind }) => kind)).toEqual([
      "registered",
      "task-claimed",
      "task-finished",
      "completed"
    ]);
    expect(stored?.events[1]).toMatchObject({
      schemaVersion: "agentlab.schedule-event.v3",
      canaryReservationDigest: candidate.canaryReservation.reservationDigest
    });
    expect(stored?.events[2]).toMatchObject({
      schemaVersion: "agentlab.schedule-event.v3",
      canaryReservationDigest: candidate.canaryReservation.reservationDigest
    });
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
          : Promise.resolve(
              taskResult(command.taskId, command.correlationId, command.canaryReservationDigest)
            );
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
        expectedPolicyBundleDigest: factoryPolicyBundleDigest,
        canaryReservationDigest: candidate.canaryReservation.reservationDigest
      },
      {
        taskId: candidate.request.taskId,
        correlationId: taskCorrelationId,
        expectedPolicyBundleDigest: factoryPolicyBundleDigest,
        canaryReservationDigest: candidate.canaryReservation.reservationDigest
      }
    ]);
  });

  it("finishes an open prior-day claim before admitting a new daily slot", async () => {
    const candidate = scheduledPreparation({
      authorityExpiresAt: "2026-09-02T12:00:00.000Z"
    });
    let now = TEST_FACTORY_SCHEDULE_NOW;
    let attempts = 0;
    const fixture = schedulerFixture({
      candidates: [candidate],
      clock: () => now,
      taskResult(command) {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new Error("worker result was not observed"))
          : Promise.resolve(
              taskResult(command.taskId, command.correlationId, command.canaryReservationDigest)
            );
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

  it("blocks a historical active run that never bound daily quota policy", async () => {
    const candidate = scheduledPreparation();
    const fixture = schedulerFixture({ candidates: [candidate] });
    await seedLegacyActiveClaim(fixture.schedules, fixture.schedulePolicy, candidate);

    await expect(
      fixture.service.tick(expectedCommand(fixture.schedulePolicy.digest))
    ).resolves.toMatchObject({
      status: "blocked",
      reasonCodes: ["open-schedule-policy-drift"]
    });
    expect(fixture.runTask).not.toHaveBeenCalled();
  });

  it("records an over-budget candidate as skipped before any model work", async () => {
    const baselineCandidate = scheduledPreparation();
    const policy = testFactorySchedulePolicy({
      maximumTasksPerTick: 1,
      tickBudget: testFactoryScheduleBudget({
        maxCostMicrousd: baselineCandidate.authority.budgetCeiling.maxCostMicrousd - 1
      })
    });
    const policyDigest = new NodeFactoryDocumentCodec().schedulePolicy(policy).digest;
    const candidate = scheduledPreparation({ schedulePolicyDigest: policyDigest });
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

  it("skips candidates without current executable canary reservations", async () => {
    const missing = scheduledPreparation();
    const missingFixture = schedulerFixture({ candidates: [missing], reservations: [] });

    await expect(
      missingFixture.service.tick(expectedCommand(missingFixture.schedulePolicy.digest))
    ).resolves.toMatchObject({ status: "completed", tasksClaimed: 0, tasksSkipped: 1 });
    expect(missingFixture.runTask).not.toHaveBeenCalled();
    const missingRun = await missingFixture.schedules.findBySlot(
      missingFixture.schedulePolicy.value.id,
      TEST_FACTORY_SCHEDULED_FOR
    );
    expect(missingRun?.events.at(-2)).toMatchObject({
      kind: "task-skipped",
      skipReason: "canary-reservation-missing"
    });

    const expiring = scheduledPreparation({
      authorityExpiresAt: "2026-08-31T12:20:00.000Z"
    });
    const expiringFixture = schedulerFixture({ candidates: [expiring] });
    await expect(
      expiringFixture.service.tick(expectedCommand(expiringFixture.schedulePolicy.digest))
    ).resolves.toMatchObject({ status: "completed", tasksClaimed: 0, tasksSkipped: 1 });
    expect(expiringFixture.runTask).not.toHaveBeenCalled();
    const expiringRun = await expiringFixture.schedules.findBySlot(
      expiringFixture.schedulePolicy.value.id,
      TEST_FACTORY_SCHEDULED_FOR
    );
    expect(expiringRun?.events.at(-2)).toMatchObject({
      kind: "task-skipped",
      skipReason: "canary-reservation-not-current"
    });
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
        expectedFactoryPolicyBundleDigest: factoryPolicyBundleDigest,
        expectedDailyQuotaPolicyDigest: dailyQuotaPolicyDigest
      })
    ).rejects.toThrow(/schedule policy changed/u);
    expect(fixture.preflight).not.toHaveBeenCalled();
    expect(fixture.listScheduled).not.toHaveBeenCalled();
  });
});

function schedulerFixture(
  options: {
    readonly candidates?: readonly ScheduledPreparation[];
    readonly reservations?: readonly FactoryCanaryReservationSnapshot[];
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
  const dailyQuotaPolicy = documents.dailyQuotaPolicy(testFactoryDailyQuotaPolicy());
  const schedules = options.schedules ?? new MemoryScheduleRepository(documents);
  const candidates = options.candidates ?? [];
  const reservations =
    options.reservations ?? candidates.map(({ canaryReservation }) => canaryReservation);
  const listScheduled = vi.fn(() => Promise.resolve(candidates));
  const findPreparation = vi.fn((taskId: string) =>
    Promise.resolve(candidates.find(({ request }) => request.taskId === taskId) ?? null)
  );
  const findReservationByTask = vi.fn((taskId: string) =>
    Promise.resolve(reservations.find(({ reservation }) => reservation.taskId === taskId) ?? null)
  );
  const findReservationByDigest = vi.fn((digest: Sha256Digest) =>
    Promise.resolve(
      reservations.find(({ reservationDigest }) => reservationDigest === digest) ?? null
    )
  );
  const preflight = vi.fn(() =>
    Promise.resolve(options.preflight ?? readyPreflight(schedulePolicy.digest))
  );
  const runTask = vi.fn((command: SchedulerTaskCommand) =>
    options.taskResult === undefined
      ? Promise.resolve(
          taskResult(command.taskId, command.correlationId, command.canaryReservationDigest)
        )
      : options.taskResult(command)
  );
  const createId = sequentialId();
  const dailyQuotaRepository = new MemoryDailyQuotaRepository(documents);
  const dailyQuotas = new FactoryDailyQuotaService({
    policy: dailyQuotaPolicy,
    quotas: dailyQuotaRepository,
    documents,
    now: options.clock ?? (() => options.now ?? TEST_FACTORY_SCHEDULE_NOW),
    createId
  });
  const service = new FactorySchedulerService({
    schedulePolicy,
    dailyQuotaPolicy,
    factoryPolicyBundleDigest,
    roleIdentityPolicyDigest,
    schedules,
    preparations: { listScheduled, findById: findPreparation },
    reservations: {
      findByTaskId: findReservationByTask,
      findByReservationDigest: findReservationByDigest
    },
    worker: { preflight },
    taskRunner: { run: runTask },
    dailyQuotas,
    documents,
    now: options.clock ?? (() => options.now ?? TEST_FACTORY_SCHEDULE_NOW),
    createId
  });
  return {
    service,
    schedulePolicy,
    schedules,
    listScheduled,
    preflight,
    runTask,
    findReservationByTask,
    findReservationByDigest
  };
}

function readyPreflight(schedulePolicyDigest: Sha256Digest): FactoryWorkerPreflight {
  return {
    schemaVersion: "agentlab.worker-preflight.v4",
    status: "ready",
    policyBundleDigest: factoryPolicyBundleDigest,
    schedulePolicyDigest,
    roleIdentityPolicyDigest,
    dailyQuotaPolicyDigest,
    schedulerEnabled: true,
    costPolicyConfigured: true,
    hostReady: true,
    configuredProviders: ["codex"],
    gateIds: ["architecture", "build", "format", "lint", "secret-scan", "test", "typecheck"],
    reasonCodes: []
  };
}

function taskResult(
  taskId: string,
  correlationId: string,
  canaryReservationDigest: Sha256Digest
): FactoryWorkerTaskRunReport {
  return {
    schemaVersion: "agentlab.worker-task-run.v3",
    status: "stopped",
    taskId,
    correlationId,
    policyBundleDigest: factoryPolicyBundleDigest,
    roleIdentityPolicyDigest,
    canaryReservationDigest,
    preparationState: "needs-human",
    taskState: null,
    contractDigest: null,
    reasonCodes: ["qualification-needs-human"]
  };
}

function scheduledPreparation(
  options: {
    readonly schedulePolicyDigest?: Sha256Digest;
    readonly authorityExpiresAt?: string;
  } = {}
): ScheduledPreparation {
  const schedulePolicyDigest =
    options.schedulePolicyDigest ??
    new NodeFactoryDocumentCodec().schedulePolicy(testFactorySchedulePolicy()).digest;
  const fixture = testFactoryCanaryAdmissionFixture({
    schedulePolicyDigest,
    authorityExpiresAt: options.authorityExpiresAt ?? "2026-09-01T12:00:00.000Z",
    canaryMaximumLifetimeSeconds: options.authorityExpiresAt === undefined ? 172_800 : 259_200
  });
  const reservation = testFactoryCanaryReservationDocument(fixture);
  return {
    ...fixture.preparation,
    canaryReservation: {
      reservation: reservation.value,
      reservationDigest: reservation.digest
    }
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

  public findTaskCompletion(taskId: string): Promise<FactoryScheduledTaskCompletion | null> {
    const completions = [...this.#runs.values()].flatMap((stored) => {
      const event = stored.events.find(
        ({ value }) => value.kind === "task-finished" && value.taskId === taskId
      );
      if (event?.value.kind !== "task-finished") return [];
      const run = snapshot(stored.run, stored.events);
      return [
        {
          run: run.run,
          runDigest: run.runDigest,
          state: run.state,
          event: event.value
        }
      ];
    });
    if (completions.length > 1) throw new Error("Factory task has multiple completions.");
    return Promise.resolve(completions[0] ?? null);
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

class MemoryDailyQuotaRepository implements FactoryDailyQuotaRepository {
  readonly #byTask = new Map<string, CanonicalFactoryDocument<FactoryDailyQuotaReservation>>();

  public constructor(private readonly documents: FactoryDocumentCodec) {}

  public reserve(
    reservation: CanonicalFactoryDocument<FactoryDailyQuotaReservation>
  ): Promise<FactoryDailyQuotaReservationSnapshot> {
    const verified = this.documents.dailyQuotaReservation(reservation.value);
    if (verified.digest !== reservation.digest || verified.json !== reservation.json) {
      return Promise.reject(new Error("Daily quota canonical identity mismatch."));
    }
    const existing = this.#byTask.get(verified.value.taskId);
    if (existing !== undefined && existing.digest !== verified.digest) {
      return Promise.reject(new Error("Daily quota task conflict."));
    }
    this.#byTask.set(verified.value.taskId, verified);
    return Promise.resolve(quotaSnapshot(verified));
  }

  public findByTaskId(taskId: string): Promise<FactoryDailyQuotaReservationSnapshot | null> {
    const reservation = this.#byTask.get(taskId);
    return Promise.resolve(reservation === undefined ? null : quotaSnapshot(reservation));
  }

  public findByReservationDigest(
    reservationDigest: Sha256Digest
  ): Promise<FactoryDailyQuotaReservationSnapshot | null> {
    const reservation = [...this.#byTask.values()].find(
      ({ digest }) => digest === reservationDigest
    );
    return Promise.resolve(reservation === undefined ? null : quotaSnapshot(reservation));
  }

  public close(): void {
    this.#byTask.clear();
  }
}

function quotaSnapshot(
  reservation: CanonicalFactoryDocument<FactoryDailyQuotaReservation>
): FactoryDailyQuotaReservationSnapshot {
  return { reservation: reservation.value, reservationDigest: reservation.digest };
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

async function seedLegacyActiveClaim(
  schedules: MemoryScheduleRepository,
  schedulePolicy: CanonicalFactoryDocument<FactorySchedulePolicy>,
  candidate: FactoryPreparationSnapshot
): Promise<void> {
  const documents = new NodeFactoryDocumentCodec();
  const run = documents.scheduleRun({
    schemaVersion: "agentlab.schedule-run.v2",
    runId: "10000000-0000-4000-8000-000000000001",
    schedulePolicyDigest: schedulePolicy.digest,
    schedulePolicy: schedulePolicy.value,
    factoryPolicyBundleDigest,
    roleIdentityPolicyDigest,
    scheduledFor: TEST_FACTORY_SCHEDULED_FOR,
    deadlineAt: TEST_FACTORY_SCHEDULE_DEADLINE,
    createdAt: TEST_FACTORY_SCHEDULE_NOW,
    correlationId: "20000000-0000-4000-8000-000000000002"
  });
  const registered = documents.scheduleEvent({
    schemaVersion: "agentlab.schedule-event.v1",
    eventId: "30000000-0000-4000-8000-000000000003",
    runId: run.value.runId,
    runDigest: run.digest,
    sequence: 1,
    previousEventDigest: null,
    kind: "registered",
    from: null,
    to: "ready",
    actor: schedulerActor(),
    occurredAt: run.value.createdAt,
    reasonCode: "schedule-slot-registered",
    correlationId: run.value.correlationId
  });
  await schedules.register(run, registered);
  await schedules.append(
    documents.scheduleEvent({
      schemaVersion: "agentlab.schedule-event.v1",
      eventId: "40000000-0000-4000-8000-000000000004",
      runId: run.value.runId,
      runDigest: run.digest,
      sequence: 2,
      previousEventDigest: registered.digest,
      kind: "task-claimed",
      from: "ready",
      to: "task-active",
      taskId: candidate.request.taskId,
      requestDigest: candidate.requestDigest,
      authorityDigest: candidate.authorityDigest,
      taskCorrelationId: "50000000-0000-4000-8000-000000000005",
      reservation: candidate.authority.budgetCeiling,
      actor: schedulerActor(),
      occurredAt: TEST_FACTORY_SCHEDULE_NOW,
      reasonCode: "scheduled-task-claimed",
      correlationId: run.value.correlationId
    })
  );
}

function schedulerActor() {
  return {
    kind: "control-plane" as const,
    role: "policy-engine" as const,
    id: "agentlab-scheduler",
    sessionId: null
  };
}

function sequentialId(): () => string {
  let value = 0;
  return () => {
    value += 1;
    return `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
  };
}
