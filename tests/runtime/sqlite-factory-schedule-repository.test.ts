import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import type { FactoryScheduleEvent } from "@agentlab/contracts";

import {
  addReservation,
  emptyReservedUsage
} from "../../packages/runtime/src/domain/factory-schedule-integrity.js";
import { NodeFactoryDocumentCodec } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { SqliteFactoryPreparationRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-preparation-repository.js";
import { SqliteFactoryScheduleRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-schedule-repository.js";
import { testDigest } from "../helpers/factory.js";
import { testFactoryPreparationFixture } from "../helpers/factory-preparation.js";
import {
  TEST_FACTORY_SCHEDULE_DEADLINE,
  TEST_FACTORY_SCHEDULE_NOW,
  TEST_FACTORY_SCHEDULED_FOR,
  testFactorySchedulePolicy
} from "../helpers/factory-schedule.js";

const codec = new NodeFactoryDocumentCodec();
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("SqliteFactoryScheduleRepository", () => {
  it("persists one immutable slot and a canonical task claim through completion", async () => {
    const databasePath = temporaryDatabase();
    const preparation = await registerScheduledPreparation(databasePath);
    const repository = new SqliteFactoryScheduleRepository(databasePath);
    const schedule = scheduleDocuments();

    try {
      await expect(repository.register(schedule.run, schedule.registered)).resolves.toMatchObject({
        state: "ready",
        sequence: 1
      });
      await expect(repository.findOpen()).resolves.toMatchObject({
        runDigest: schedule.run.digest,
        state: "ready"
      });
      const taskCorrelationId = "40000000-0000-4000-8000-000000000004";
      const claim = codec.scheduleEvent({
        ...nextEvent(schedule.registered.value, schedule.registered.digest, schedule.run.digest),
        eventId: "30000000-0000-4000-8000-000000000003",
        kind: "task-claimed",
        from: "ready",
        to: "task-active",
        taskId: preparation.request.taskId,
        requestDigest: preparation.requestDigest,
        authorityDigest: preparation.authorityDigest,
        taskCorrelationId,
        reservation: preparation.authority.budgetCeiling,
        reasonCode: "scheduled-task-claimed"
      });
      await expect(repository.append(claim)).resolves.toMatchObject({
        state: "task-active",
        sequence: 2
      });

      const database = new DatabaseSync(databasePath);
      try {
        const malformed = {
          ...nextEvent(claim.value, claim.digest, schedule.run.digest),
          eventId: "50000000-0000-4000-8000-000000000005",
          kind: "task-finished",
          from: "task-active",
          to: "ready",
          taskId: preparation.request.taskId,
          taskCorrelationId: "90000000-0000-4000-8000-000000000009",
          result: "stopped",
          preparationState: "registered",
          taskState: null,
          contractDigest: null,
          reasonCodes: [],
          reasonCode: "scheduled-task-stopped"
        };
        expect(() =>
          database
            .prepare(
              `INSERT INTO factory_schedule_events (
                event_id, run_id, run_digest, sequence, event_digest, previous_event_digest,
                kind, from_state, to_state, task_id, task_correlation_id, occurred_at,
                reason_code, correlation_id, event_json
              ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              malformed.eventId,
              malformed.runId,
              malformed.runDigest,
              malformed.sequence,
              testDigest("9"),
              malformed.previousEventDigest,
              malformed.kind,
              malformed.from,
              malformed.to,
              malformed.taskId,
              taskCorrelationId,
              malformed.occurredAt,
              malformed.reasonCode,
              malformed.correlationId,
              JSON.stringify(malformed)
            )
        ).toThrow(/identity mismatch/u);
        expect(() =>
          database.prepare("UPDATE factory_schedule_runs SET deadline_at = deadline_at").run()
        ).toThrow(/immutable/u);
        expect(() => database.prepare("DELETE FROM factory_schedule_events").run()).toThrow(
          /append-only/u
        );
      } finally {
        database.close();
      }

      const finished = codec.scheduleEvent({
        ...nextEvent(claim.value, claim.digest, schedule.run.digest),
        eventId: "60000000-0000-4000-8000-000000000006",
        kind: "task-finished",
        from: "task-active",
        to: "ready",
        taskId: preparation.request.taskId,
        taskCorrelationId,
        result: "stopped",
        preparationState: "registered",
        taskState: null,
        contractDigest: null,
        reasonCodes: ["qualification-needs-human"],
        reasonCode: "scheduled-task-stopped"
      });
      await repository.append(finished);
      const completed = codec.scheduleEvent({
        ...nextEvent(finished.value, finished.digest, schedule.run.digest),
        eventId: "70000000-0000-4000-8000-000000000007",
        kind: "completed",
        from: "ready",
        to: "completed",
        tasksClaimed: 1,
        tasksFinished: 1,
        tasksSkipped: 0,
        reservedUsage: addReservation(emptyReservedUsage(), preparation.authority.budgetCeiling),
        reasonCode: "schedule-slot-completed"
      });
      await expect(repository.append(completed)).resolves.toMatchObject({
        state: "completed",
        sequence: 4
      });
      await expect(
        repository.findBySlot(schedule.policy.value.id, TEST_FACTORY_SCHEDULED_FOR)
      ).resolves.toMatchObject({ runDigest: schedule.run.digest, state: "completed" });
      await expect(repository.listEvents(schedule.run.value.runId)).resolves.toHaveLength(4);
      await expect(repository.findOpen()).resolves.toBeNull();
    } finally {
      repository.close();
    }
  });

  it("rejects a second run for the same policy slot and a stale event chain", async () => {
    const repository = new SqliteFactoryScheduleRepository(":memory:");
    const first = scheduleDocuments();
    const second = scheduleDocuments({
      runId: "80000000-0000-4000-8000-000000000008",
      correlationId: "90000000-0000-4000-8000-000000000009",
      eventId: "a0000000-0000-4000-8000-00000000000a"
    });
    try {
      await repository.register(first.run, first.registered);
      expect(() => repository.register(second.run, second.registered)).toThrow(/unique/iu);
      const staleCompletion = codec.scheduleEvent({
        ...nextEvent(first.registered.value, testDigest("f"), first.run.digest),
        eventId: "b0000000-0000-4000-8000-00000000000b",
        kind: "completed",
        from: "ready",
        to: "completed",
        tasksClaimed: 0,
        tasksFinished: 0,
        tasksSkipped: 0,
        reservedUsage: emptyReservedUsage(),
        reasonCode: "schedule-slot-completed"
      });
      expect(() => repository.append(staleCompletion)).toThrow(/exact run chain/u);
    } finally {
      repository.close();
    }
  });

  it("fails closed when more than one schedule run remains open", async () => {
    const repository = new SqliteFactoryScheduleRepository(":memory:");
    const first = scheduleDocuments();
    const second = scheduleDocuments({
      runId: "80000000-0000-4000-8000-000000000008",
      correlationId: "90000000-0000-4000-8000-000000000009",
      eventId: "a0000000-0000-4000-8000-00000000000a",
      scheduledFor: "2026-09-01T12:00:00.000Z",
      deadlineAt: "2026-09-01T12:30:00.000Z",
      createdAt: "2026-09-01T12:05:00.000Z"
    });
    try {
      await repository.register(first.run, first.registered);
      await repository.register(second.run, second.registered);
      expect(() => repository.findOpen()).toThrow(/multiple open runs/u);
    } finally {
      repository.close();
    }
  });
});

function scheduleDocuments(
  ids: {
    readonly runId?: string;
    readonly correlationId?: string;
    readonly eventId?: string;
    readonly scheduledFor?: string;
    readonly deadlineAt?: string;
    readonly createdAt?: string;
  } = {}
) {
  const policy = codec.schedulePolicy(testFactorySchedulePolicy());
  const run = codec.scheduleRun({
    schemaVersion: "agentlab.schedule-run.v1",
    runId: ids.runId ?? "10000000-0000-4000-8000-000000000001",
    schedulePolicyDigest: policy.digest,
    schedulePolicy: policy.value,
    factoryPolicyBundleDigest: testFactoryPreparationFixture().policyDigest,
    scheduledFor: ids.scheduledFor ?? TEST_FACTORY_SCHEDULED_FOR,
    deadlineAt: ids.deadlineAt ?? TEST_FACTORY_SCHEDULE_DEADLINE,
    createdAt: ids.createdAt ?? TEST_FACTORY_SCHEDULE_NOW,
    correlationId: ids.correlationId ?? "20000000-0000-4000-8000-000000000002"
  });
  const registered = codec.scheduleEvent({
    schemaVersion: "agentlab.schedule-event.v1",
    eventId: ids.eventId ?? "20000000-0000-4000-8000-000000000003",
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
  return { policy, run, registered };
}

async function registerScheduledPreparation(databasePath: string) {
  const fixture = testFactoryPreparationFixture();
  const request = codec.intakeRequest({ ...fixture.request, trigger: "scheduled" });
  const authority = codec.preparationAuthority({
    ...fixture.authority,
    requestDigest: request.digest,
    expiresAt: "2026-09-01T12:01:00.000Z"
  });
  const event = codec.preparationEvent({
    schemaVersion: "agentlab.preparation-event.v1",
    eventId: "f0000000-0000-4000-8000-00000000000f",
    taskId: request.value.taskId,
    sequence: 1,
    requestDigest: request.digest,
    authorityDigest: authority.digest,
    previousEventDigest: null,
    kind: "registered",
    from: null,
    to: "registered",
    actor: schedulerActor(),
    occurredAt: authority.value.issuedAt,
    reasonCode: "request-registered",
    summary: null,
    correlationId: "e0000000-0000-4000-8000-00000000000e"
  });
  const preparations = new SqliteFactoryPreparationRepository(databasePath);
  try {
    return await preparations.register(request, authority, event);
  } finally {
    preparations.close();
  }
}

function nextEvent(previous: FactoryScheduleEvent, previousEventDigest: string, runDigest: string) {
  return {
    schemaVersion: "agentlab.schedule-event.v1" as const,
    runId: previous.runId,
    runDigest,
    sequence: previous.sequence + 1,
    previousEventDigest,
    actor: schedulerActor(),
    occurredAt: TEST_FACTORY_SCHEDULE_NOW,
    correlationId: previous.correlationId
  };
}

function schedulerActor() {
  return {
    kind: "control-plane" as const,
    role: "policy-engine" as const,
    id: "agentlab-scheduler",
    sessionId: null
  };
}

function temporaryDatabase(): string {
  const root = mkdtempSync(join(tmpdir(), "agentlab-schedule-repository-"));
  temporaryRoots.push(root);
  return join(root, "agentlab.sqlite");
}
