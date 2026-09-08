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
import { latestSchemaVersion } from "../../packages/runtime/src/infrastructure/persistence/migrations.js";
import { SqliteFactoryScheduleRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-schedule-repository.js";
import { testDigest } from "../helpers/factory.js";
import {
  persistFactoryCanaryAdmissionFixture,
  testFactoryCanaryAdmissionFixture
} from "../helpers/factory-canary-admission.js";
import { TEST_ROLE_IDENTITY_POLICY_DIGEST } from "../helpers/factory-evaluation.js";
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
    const schedule = scheduleDocuments();
    const fixture = testFactoryCanaryAdmissionFixture({
      schedulePolicyDigest: schedule.policy.digest,
      authorityExpiresAt: "2026-09-01T12:00:00.000Z",
      canaryMaximumLifetimeSeconds: 172_800
    });
    const reservation = await persistFactoryCanaryAdmissionFixture(databasePath, fixture);
    const preparation = fixture.preparation;
    const repository = new SqliteFactoryScheduleRepository(databasePath);

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
      const legacyClaim = codec.scheduleEvent({
        ...nextEvent(schedule.registered.value, schedule.registered.digest, schedule.run.digest),
        eventId: "30000000-0000-4000-8000-000000000002",
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
      expect(() => repository.append(legacyClaim)).toThrow(/canary claim mismatch/u);
      const substitutedClaim = codec.scheduleEvent({
        ...legacyClaim.value,
        schemaVersion: "agentlab.schedule-event.v2",
        eventId: "30000000-0000-4000-8000-000000000001",
        canaryReservationDigest: testDigest("e")
      });
      expect(() => repository.append(substitutedClaim)).toThrow(/canary claim mismatch/u);
      const claim = codec.scheduleEvent({
        ...nextEvent(schedule.registered.value, schedule.registered.digest, schedule.run.digest),
        schemaVersion: "agentlab.schedule-event.v2",
        eventId: "30000000-0000-4000-8000-000000000003",
        kind: "task-claimed",
        from: "ready",
        to: "task-active",
        taskId: preparation.request.taskId,
        requestDigest: preparation.requestDigest,
        authorityDigest: preparation.authorityDigest,
        taskCorrelationId,
        canaryReservationDigest: reservation.digest,
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
          schemaVersion: "agentlab.schedule-event.v2" as const,
          eventId: "50000000-0000-4000-8000-000000000005",
          kind: "task-finished",
          from: "task-active",
          to: "ready",
          taskId: preparation.request.taskId,
          taskCorrelationId: "90000000-0000-4000-8000-000000000009",
          canaryReservationDigest: reservation.digest,
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
        schemaVersion: "agentlab.schedule-event.v2",
        eventId: "60000000-0000-4000-8000-000000000006",
        kind: "task-finished",
        from: "task-active",
        to: "ready",
        taskId: preparation.request.taskId,
        taskCorrelationId,
        canaryReservationDigest: reservation.digest,
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
      await expect(
        repository.findTaskCompletion(preparation.request.taskId)
      ).resolves.toMatchObject({
        runDigest: schedule.run.digest,
        state: "completed",
        event: {
          schemaVersion: "agentlab.schedule-event.v2",
          canaryReservationDigest: reservation.digest,
          result: "stopped"
        }
      });
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

  it("migrates a version-15 schedule ledger to canary-bound claim enforcement", async () => {
    const databasePath = temporaryDatabase();
    const schedule = scheduleDocuments();
    const initial = new SqliteFactoryScheduleRepository(databasePath);
    await initial.register(schedule.run, schedule.registered);
    initial.close();
    const legacy = new DatabaseSync(databasePath);
    try {
      legacy.exec(`
        DROP TRIGGER factory_schedule_events_daily_quota_finish_guard;
        DROP TRIGGER factory_schedule_events_daily_quota_claim_guard;
        DROP TABLE factory_daily_quota_reservations;
        DROP TRIGGER factory_pull_request_dispatches_canary_guard;
        DROP INDEX factory_pull_request_dispatches_canary_idx;
        ALTER TABLE factory_pull_request_dispatches DROP COLUMN canary_reservation_digest;
        DROP TRIGGER factory_schedule_events_canary_finish_guard;
        DROP TRIGGER factory_schedule_events_canary_claim_guard;
        DROP TABLE factory_eval_production_events;
        DROP TABLE factory_eval_production_jobs;
        DROP TABLE factory_maintenance_discovery_events;
        DROP TABLE factory_maintenance_discovery_runs;
        DROP TABLE factory_external_pr_replacement_draft_records;
        DROP TABLE factory_external_pr_replacement_draft_events;
        DROP TABLE factory_external_pr_replacement_draft_runs;
        DROP TABLE factory_external_pr_repair_qualification_bundles;
        DROP TABLE factory_external_pr_repair_qualification_events;
        DROP TABLE factory_external_pr_repair_qualification_runs;
        DROP TABLE factory_external_pr_repair_execution_bundles;
        DROP TABLE factory_external_pr_repair_execution_events;
        DROP TABLE factory_external_pr_repair_execution_runs;
        DROP TABLE factory_external_pr_repair_authorizations;
        DROP TABLE factory_external_pr_repair_decisions;
        DROP TABLE factory_external_pr_feedback_records;
        DROP TABLE factory_external_pr_feedback_events;
        DROP TABLE factory_incident_containments;
        DROP TABLE factory_autonomous_merge_records;
        DROP TABLE factory_autonomous_merge_events;
        DROP TABLE factory_autonomous_merge_runs;
        DROP TABLE factory_ledger_authority_receipts;
        DROP TABLE factory_merge_control_events;
        DROP TRIGGER factory_control_events_identity_guard;
        DROP TABLE factory_external_pr_feedback_runs;
        DROP TABLE factory_external_pr_review_bundles;
        DROP TABLE factory_external_pr_review_events;
        DROP TABLE factory_external_pr_review_runs;
        DROP TABLE factory_external_pr_discovery_candidates;
        DROP TABLE factory_external_pr_discovery_snapshots;
        DROP TABLE factory_external_pr_discovery_events;
        DROP TABLE factory_external_pr_discovery_runs;
        PRAGMA user_version = 15;
      `);
    } finally {
      legacy.close();
    }

    const migrated = new SqliteFactoryScheduleRepository(databasePath);
    await expect(
      migrated.findBySlot(schedule.policy.value.id, TEST_FACTORY_SCHEDULED_FOR)
    ).resolves.toMatchObject({ runDigest: schedule.run.digest, state: "ready" });
    migrated.close();
    const database = new DatabaseSync(databasePath);
    try {
      expect(
        (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version
      ).toBe(latestSchemaVersion);
      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM sqlite_master
             WHERE type = 'trigger' AND name LIKE 'factory_schedule_events_canary_%_guard'`
          )
          .get()
      ).toEqual({ count: 2 });
    } finally {
      database.close();
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
    schemaVersion: "agentlab.schedule-run.v2",
    runId: ids.runId ?? "10000000-0000-4000-8000-000000000001",
    schedulePolicyDigest: policy.digest,
    schedulePolicy: policy.value,
    factoryPolicyBundleDigest: testFactoryPreparationFixture().policyDigest,
    roleIdentityPolicyDigest: TEST_ROLE_IDENTITY_POLICY_DIGEST,
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
