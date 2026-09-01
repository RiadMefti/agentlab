import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { FactoryTaskState } from "@agentlab/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { NodeFactoryDocumentCodec } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { latestSchemaVersion } from "../../packages/runtime/src/infrastructure/persistence/migrations.js";
import { SqliteFactoryCanaryBrokerQueue } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-canary-broker-queue.js";
import { SqliteFactoryCanaryPullRequestMaintenanceQueue } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-canary-pull-request-maintenance-queue.js";
import { SqliteFactoryCanaryPullRequestRepairQueue } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-canary-pull-request-repair-queue.js";
import { SqliteFactoryCanaryPullRequestUpdateQueue } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-canary-pull-request-update-queue.js";
import { SqliteFactoryPullRequestDispatchRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-pull-request-dispatch-repository.js";
import { SqliteFactoryPullRequestRepairExecutionRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-pull-request-repair-execution-repository.js";
import { SqliteFactoryRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-repository.js";
import { SqliteFactoryScheduleRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-schedule-repository.js";
import {
  TEST_FACTORY_CORRELATION_ID,
  TEST_FACTORY_TASK_ID,
  testDigest,
  testEvidenceBundle,
  testFactoryContract,
  testTaskEvent
} from "../helpers/factory.js";
import {
  persistFactoryCanaryAdmissionFixture,
  testFactoryCanaryAdmissionFixture
} from "../helpers/factory-canary-admission.js";
import {
  TEST_FACTORY_SCHEDULE_DEADLINE,
  TEST_FACTORY_SCHEDULE_NOW,
  TEST_FACTORY_SCHEDULED_FOR,
  testFactorySchedulePolicy
} from "../helpers/factory-schedule.js";

const codec = new NodeFactoryDocumentCodec();
const temporaryRoots: string[] = [];
const dispatchId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const brokerActor = {
  kind: "broker",
  role: "pr-broker",
  id: "github-app/test",
  sessionId: null
} as const;

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("SqliteFactoryPullRequestDispatchRepository", () => {
  it("persists the exact five-checkpoint chain and removes completed work from recovery", async () => {
    const fixture = await repositoryFixture();
    try {
      await expect(
        fixture.dispatches.register(fixture.run, fixture.registered)
      ).resolves.toMatchObject({ state: "ready", record: null });
      const started = event(fixture.run, fixture.registered, {
        kind: "dispatch-started",
        from: "ready",
        to: "dispatch-active"
      });
      await fixture.dispatches.append(started);
      const observed = event(fixture.run, started, {
        kind: "remote-observed",
        from: "dispatch-active",
        to: "remote-open",
        record: pullRequestRecord(fixture),
        created: true
      });
      await expect(fixture.dispatches.append(observed)).resolves.toMatchObject({
        state: "remote-open",
        record: { number: 42 }
      });
      await expect(fixture.dispatches.listRecoverable(10)).resolves.toHaveLength(1);
      const evidenced = event(fixture.run, observed, {
        kind: "evidence-recorded",
        from: "remote-open",
        to: "evidence-recorded",
        evidenceBundleDigest: fixture.evidence.digest
      });
      await fixture.dispatches.append(evidenced);
      const taskEvent = await advanceTaskToPullRequestOpen(fixture);
      const completed = event(fixture.run, evidenced, {
        kind: "task-recorded",
        from: "evidence-recorded",
        to: "completed",
        taskEventDigest: taskEvent.digest
      });
      await expect(fixture.dispatches.append(completed)).resolves.toMatchObject({
        state: "completed",
        evidenceBundleDigest: fixture.evidence.digest,
        taskEventDigest: taskEvent.digest
      });
      await expect(fixture.dispatches.listRecoverable(10)).resolves.toEqual([]);
      await expect(fixture.dispatches.listEvents(TEST_FACTORY_TASK_ID)).resolves.toHaveLength(5);
      await expect(fixture.dispatches.append(completed)).resolves.toBeNull();
    } finally {
      fixture.dispatches.close();
      fixture.tasks.close();
    }
  });

  it("rejects forged claims and a remote record from another broker", async () => {
    const fixture = await repositoryFixture();
    try {
      expect(() =>
        fixture.dispatches.register({ ...fixture.run, json: "{}" }, fixture.registered)
      ).toThrow(/not canonical/u);
      await fixture.dispatches.register(fixture.run, fixture.registered);
      const started = event(fixture.run, fixture.registered, {
        kind: "dispatch-started",
        from: "ready",
        to: "dispatch-active"
      });
      await fixture.dispatches.append(started);
      const observed = event(fixture.run, started, {
        kind: "remote-observed",
        from: "dispatch-active",
        to: "remote-open",
        record: { ...pullRequestRecord(fixture), brokerId: "github-app/other" },
        created: true
      });
      expect(() => fixture.dispatches.append(observed)).toThrow(/exact authorized dispatch/u);
    } finally {
      fixture.dispatches.close();
      fixture.tasks.close();
    }
  });

  it("enforces immutable run rows and append-only event rows in SQLite", async () => {
    const fixture = await repositoryFixture();
    try {
      await fixture.dispatches.register(fixture.run, fixture.registered);
    } finally {
      fixture.dispatches.close();
      fixture.tasks.close();
    }
    const database = new DatabaseSync(fixture.databasePath);
    try {
      expect(() =>
        database.prepare("UPDATE factory_pull_request_dispatches SET broker_id = 'forged'").run()
      ).toThrow(/immutable/u);
      expect(() =>
        database.prepare("DELETE FROM factory_pull_request_dispatch_events").run()
      ).toThrow(/append-only/u);
    } finally {
      database.close();
    }
  });

  it("allows scheduled dispatch only from its exact completed brokered canary handoff", async () => {
    const fixture = await scheduledRepositoryFixture();
    const queue = new SqliteFactoryCanaryBrokerQueue(fixture.databasePath);
    const maintenanceQueue = new SqliteFactoryCanaryPullRequestMaintenanceQueue(
      fixture.databasePath
    );
    const repairQueue = new SqliteFactoryCanaryPullRequestRepairQueue(fixture.databasePath);
    const updateQueue = new SqliteFactoryCanaryPullRequestUpdateQueue(fixture.databasePath);
    const repairs = new SqliteFactoryPullRequestRepairExecutionRepository(fixture.databasePath);
    try {
      await expect(
        queue.listPending({
          repositoryId: "agentlab",
          observedAt: "2026-08-31T12:09:00.000Z",
          limit: 10
        })
      ).resolves.toMatchObject({
        truncated: false,
        items: [
          {
            taskId: TEST_FACTORY_TASK_ID,
            reservationDigest: fixture.reservationDigest,
            source: "undispatched",
            scheduledFor: TEST_FACTORY_SCHEDULED_FOR,
            finishedAt: "2026-08-31T12:07:00.000Z"
          }
        ]
      });
      expect(() =>
        fixture.dispatches.register(fixture.legacyRun, fixture.legacyRegistered)
      ).toThrow(/canary authority mismatch/u);
      expect(() =>
        fixture.dispatches.register(fixture.substitutedRun, fixture.substitutedRegistered)
      ).toThrow(/canary authority mismatch/u);
      await expect(
        fixture.dispatches.register(fixture.run, fixture.registered)
      ).resolves.toMatchObject({
        state: "ready",
        run: {
          schemaVersion: "agentlab.pull-request-dispatch.v2",
          canaryReservationDigest: fixture.reservationDigest
        }
      });
      await expect(
        queue.listPending({
          repositoryId: "agentlab",
          observedAt: "2026-08-31T12:09:00.000Z",
          limit: 10
        })
      ).resolves.toMatchObject({ items: [{ source: "recoverable" }] });
      const started = event(fixture.run, fixture.registered, {
        kind: "dispatch-started",
        from: "ready",
        to: "dispatch-active"
      });
      await fixture.dispatches.append(started);
      const observed = event(fixture.run, started, {
        kind: "remote-observed",
        from: "dispatch-active",
        to: "remote-open",
        record: pullRequestRecord(fixture),
        created: true
      });
      await fixture.dispatches.append(observed);
      const evidenced = event(fixture.run, observed, {
        kind: "evidence-recorded",
        from: "remote-open",
        to: "evidence-recorded",
        evidenceBundleDigest: fixture.evidence.digest
      });
      await fixture.dispatches.append(evidenced);
      const taskEvent = codec.taskEvent({
        schemaVersion: "agentlab.task-event.v1",
        eventId: "61616161-6161-4161-8161-616161616161",
        taskId: fixture.contract.value.taskId,
        sequence: fixture.taskLastEvent.value.sequence + 1,
        contractDigest: fixture.contract.digest,
        previousEventDigest: fixture.taskLastEvent.digest,
        from: "pr-proposed",
        to: "pr-open",
        actor: brokerActor,
        occurredAt: "2026-08-31T12:14:00.000Z",
        reasonCode: "draft-pr-opened",
        summary: null,
        evidenceBundleDigest: fixture.evidence.digest,
        correlationId: TEST_FACTORY_CORRELATION_ID
      });
      await fixture.tasks.append(taskEvent);
      const completedDispatch = event(fixture.run, evidenced, {
        kind: "task-recorded",
        from: "evidence-recorded",
        to: "completed",
        taskEventDigest: taskEvent.digest
      });
      await fixture.dispatches.append(completedDispatch);
      await expect(
        queue.listPending({
          repositoryId: "agentlab",
          observedAt: "2026-08-31T12:15:00.000Z",
          limit: 10
        })
      ).resolves.toEqual({ items: [], truncated: false });
      const currentRecordDigest = codec.pullRequestRecord(pullRequestRecord(fixture)).digest;
      await expect(
        maintenanceQueue.listPending({
          repositoryId: "agentlab",
          observedAt: "2026-08-31T12:15:00.000Z",
          maintenanceSlot: "2026-08-31T12:00:00.000Z",
          limit: 10
        })
      ).resolves.toMatchObject({
        truncated: false,
        items: [
          {
            taskId: TEST_FACTORY_TASK_ID,
            reservationDigest: fixture.reservationDigest,
            currentPullRequestRecordDigest: currentRecordDigest,
            currentHeadRevision: "b".repeat(40),
            source: "unobserved",
            observationDigest: null
          }
        ]
      });
      const observationDigest = testDigest("6");
      const observationEvidence = maintenanceEvidence(fixture, {
        sequence: 2,
        bundleId: "62626262-6262-4262-8262-626262626262",
        itemId: "63636363-6363-4363-8363-636363636363",
        previousBundleDigest: fixture.evidence.digest,
        subjectDigest: observationDigest,
        mediaType: "application/vnd.agentlab.pull-request-observation.v1+json",
        claims: [
          { name: "disposition", value: "actionable" },
          { name: "maintenance-slot", value: "2026-08-31T12:00:00.000Z" },
          { name: "head-revision", value: "b".repeat(40) },
          { name: "pull-request-record-digest", value: currentRecordDigest },
          { name: "canary-reservation-digest", value: fixture.reservationDigest },
          { name: "schedule-policy-digest", value: fixture.schedulePolicyDigest },
          {
            name: "role-identity-policy-digest",
            value: fixture.roleIdentityPolicyDigest
          }
        ]
      });
      await fixture.tasks.appendEvidence(observationEvidence);
      await expect(
        maintenanceQueue.listPending({
          repositoryId: "agentlab",
          observedAt: "2026-08-31T12:16:00.000Z",
          maintenanceSlot: "2026-08-31T12:00:00.000Z",
          limit: 10
        })
      ).resolves.toMatchObject({
        items: [
          {
            source: "observed-actionable",
            observationDigest
          }
        ]
      });
      const authorizationEvidence = maintenanceEvidence(fixture, {
        sequence: 3,
        bundleId: "64646464-6464-4464-8464-646464646464",
        itemId: "65656565-6565-4565-8565-656565656565",
        previousBundleDigest: observationEvidence.digest,
        subjectDigest: testDigest("7"),
        mediaType: "application/vnd.agentlab.pull-request-repair-authorization.v1+json",
        result: "pass",
        claims: [
          { name: "observation-digest", value: observationDigest },
          { name: "pull-request-record-digest", value: currentRecordDigest },
          { name: "head-revision", value: "b".repeat(40) }
        ]
      });
      await fixture.tasks.appendEvidence(authorizationEvidence);
      await expect(
        maintenanceQueue.listPending({
          repositoryId: "agentlab",
          observedAt: "2026-08-31T12:17:00.000Z",
          maintenanceSlot: "2026-08-31T12:00:00.000Z",
          limit: 10
        })
      ).resolves.toEqual({ items: [], truncated: false });
      await expect(
        repairQueue.listPending({
          observedAt: "2026-08-31T12:17:00.000Z",
          schedulePolicyDigest: fixture.schedulePolicyDigest,
          factoryPolicyBundleDigest: fixture.contract.value.gateProfile.policyDigest,
          roleIdentityPolicyDigest: fixture.roleIdentityPolicyDigest,
          limit: 10
        })
      ).resolves.toMatchObject({
        truncated: false,
        items: [
          {
            source: "authorized",
            taskId: TEST_FACTORY_TASK_ID,
            repositoryId: "agentlab",
            authorizationDigest: testDigest("7"),
            observationDigest,
            reservationDigest: fixture.reservationDigest,
            pullRequestRecordDigest: currentRecordDigest,
            headRevision: "b".repeat(40)
          }
        ]
      });
      const repairing = codec.taskEvent({
        schemaVersion: "agentlab.task-event.v1",
        eventId: "66666666-6666-4666-8666-666666666661",
        taskId: fixture.contract.value.taskId,
        sequence: taskEvent.value.sequence + 1,
        contractDigest: fixture.contract.digest,
        previousEventDigest: taskEvent.digest,
        from: "pr-open",
        to: "repairing",
        actor: taskEvent.value.actor,
        occurredAt: "2026-08-31T12:18:00.000Z",
        reasonCode: "authorized-pr-repair-started",
        summary: null,
        evidenceBundleDigest: authorizationEvidence.digest,
        correlationId: TEST_FACTORY_CORRELATION_ID
      });
      await fixture.tasks.append(repairing);
      const repairRun = codec.pullRequestRepairRun({
        schemaVersion: "agentlab.pull-request-repair-run.v1",
        runId: "67676767-6767-4767-8767-676767676767",
        taskId: fixture.contract.value.taskId,
        contractDigest: fixture.contract.digest,
        policyBundleDigest: fixture.contract.value.gateProfile.policyDigest,
        authorizationId: "68686868-6868-4868-8868-686868686868",
        authorizationDigest: testDigest("7"),
        observationDigest,
        priorPatchProposalDigest: fixture.run.value.proposal.patchProposalDigest,
        repository: fixture.contract.value.repository,
        contractRepairAttempt: 1,
        maximumAttempts: 1,
        createdAt: "2026-08-31T12:19:00.000Z",
        correlationId: TEST_FACTORY_CORRELATION_ID
      });
      const repairRegistered = codec.executionEvent({
        ...repairExecutionEventBase(repairRun, null, "2026-08-31T12:19:00.000Z"),
        kind: "registered",
        from: null,
        to: "ready"
      });
      await repairs.register(repairRun, repairRegistered);
      const repairFinished = codec.executionEvent({
        ...repairExecutionEventBase(repairRun, repairRegistered, "2026-08-31T12:20:00.000Z"),
        kind: "execution-finished",
        from: "ready",
        to: "completed",
        taskState: "pr-proposed"
      });
      await repairs.append(repairFinished);
      let previousRepairTask = repairing;
      for (const [index, state] of (["verifying", "reviewing", "pr-proposed"] as const).entries()) {
        const next = codec.taskEvent({
          schemaVersion: "agentlab.task-event.v1",
          eventId: `69696969-6969-4969-8969-${String(index + 1).padStart(12, "0")}`,
          taskId: fixture.contract.value.taskId,
          sequence: previousRepairTask.value.sequence + 1,
          contractDigest: fixture.contract.digest,
          previousEventDigest: previousRepairTask.digest,
          from: previousRepairTask.value.to,
          to: state,
          actor: previousRepairTask.value.actor,
          occurredAt: `2026-08-31T12:${String(21 + index).padStart(2, "0")}:00.000Z`,
          reasonCode:
            state === "pr-proposed" ? "post-pr-independent-review-passed" : "stage-complete",
          summary: null,
          evidenceBundleDigest: null,
          correlationId: TEST_FACTORY_CORRELATION_ID
        });
        await fixture.tasks.append(next);
        previousRepairTask = next;
      }
      await expect(
        updateQueue.listPending({
          repositoryId: "agentlab",
          observedAt: "2026-08-31T13:00:00.000Z",
          schedulePolicyDigest: fixture.schedulePolicyDigest,
          factoryPolicyBundleDigest: fixture.contract.value.gateProfile.policyDigest,
          roleIdentityPolicyDigest: fixture.roleIdentityPolicyDigest,
          limit: 10
        })
      ).resolves.toMatchObject({
        truncated: false,
        items: [
          {
            source: "authorized",
            taskId: TEST_FACTORY_TASK_ID,
            repositoryId: "agentlab",
            authorizationDigest: testDigest("7"),
            observationDigest,
            repairRunDigest: repairRun.digest,
            repairFinishedAt: "2026-08-31T12:20:00.000Z",
            reservationDigest: fixture.reservationDigest,
            pullRequestRecordDigest: currentRecordDigest,
            headRevision: "b".repeat(40),
            brokerId: brokerActor.id
          }
        ]
      });
      expect(() =>
        queue.listPending({
          repositoryId: "agentlab",
          observedAt: "2026-08-31T12:15:00.000Z",
          limit: 0
        })
      ).toThrow(/too_small|greater than or equal to 1/iu);
      const database = new DatabaseSync(fixture.databasePath);
      try {
        expect(
          database
            .prepare(
              `SELECT canary_reservation_digest FROM factory_pull_request_dispatches
               WHERE task_id = ?`
            )
            .get(TEST_FACTORY_TASK_ID)
        ).toEqual({ canary_reservation_digest: fixture.reservationDigest });
      } finally {
        database.close();
      }
    } finally {
      repairs.close();
      updateQueue.close();
      repairQueue.close();
      maintenanceQueue.close();
      queue.close();
      fixture.dispatches.close();
      fixture.schedules.close();
      fixture.tasks.close();
    }
  });

  it("migrates version 16 to immutable canary-bound dispatch storage", async () => {
    const fixture = await repositoryFixture();
    fixture.dispatches.close();
    fixture.tasks.close();
    const legacy = new DatabaseSync(fixture.databasePath);
    try {
      legacy.exec(`
        DROP TRIGGER factory_pull_request_dispatches_canary_guard;
        DROP INDEX factory_pull_request_dispatches_canary_idx;
        ALTER TABLE factory_pull_request_dispatches DROP COLUMN canary_reservation_digest;
        DROP TABLE factory_eval_production_events;
        DROP TABLE factory_eval_production_jobs;
        DROP TABLE factory_maintenance_discovery_events;
        DROP TABLE factory_maintenance_discovery_runs;
        PRAGMA user_version = 16;
      `);
    } finally {
      legacy.close();
    }

    const migrated = new SqliteFactoryPullRequestDispatchRepository(fixture.databasePath);
    await expect(migrated.findByTaskId(TEST_FACTORY_TASK_ID)).resolves.toBeNull();
    migrated.close();
    const database = new DatabaseSync(fixture.databasePath);
    try {
      expect(
        (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version
      ).toBe(latestSchemaVersion);
      expect(
        database
          .prepare(
            `SELECT COUNT(*) AS count FROM pragma_table_info('factory_pull_request_dispatches')
             WHERE name = 'canary_reservation_digest'`
          )
          .get()
      ).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });

  it("migrates a version-7 database without changing existing task data", async () => {
    const fixture = await repositoryFixture();
    fixture.dispatches.close();
    fixture.tasks.close();
    const legacy = new DatabaseSync(fixture.databasePath);
    try {
      legacy.exec(`
        DROP TRIGGER factory_pull_request_dispatches_canary_guard;
        DROP TRIGGER factory_schedule_events_canary_finish_guard;
        DROP TRIGGER factory_schedule_events_canary_claim_guard;
        DROP TABLE factory_canary_task_reservations;
        DROP TABLE factory_eval_attestations;
        DROP TABLE factory_canary_cohorts;
        DROP TABLE factory_canary_approvals;
        DROP TABLE factory_eval_assessments;
        DROP TABLE factory_eval_runs;
        DROP TABLE factory_schedule_events;
        DROP TABLE factory_schedule_runs;
        DROP TABLE factory_pull_request_update_events;
        DROP TABLE factory_pull_request_updates;
        DROP TABLE factory_pull_request_repair_events;
        DROP TABLE factory_pull_request_repair_runs;
        DROP TABLE factory_pull_request_dispatch_events;
        DROP TABLE factory_pull_request_dispatches;
        DROP TABLE factory_eval_production_events;
        DROP TABLE factory_eval_production_jobs;
        DROP TABLE factory_maintenance_discovery_events;
        DROP TABLE factory_maintenance_discovery_runs;
        PRAGMA user_version = 7;
      `);
    } finally {
      legacy.close();
    }
    const migrated = new SqliteFactoryPullRequestDispatchRepository(fixture.databasePath);
    try {
      await expect(migrated.findByTaskId(TEST_FACTORY_TASK_ID)).resolves.toBeNull();
      const database = new DatabaseSync(fixture.databasePath);
      try {
        expect(
          (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version
        ).toBe(latestSchemaVersion);
        expect(database.prepare("SELECT task_id FROM factory_task_contracts").get()).toMatchObject({
          task_id: TEST_FACTORY_TASK_ID
        });
      } finally {
        database.close();
      }
    } finally {
      migrated.close();
    }
  });
});

async function scheduledRepositoryFixture() {
  const root = mkdtempSync(join(tmpdir(), "agentlab-canary-pr-dispatch-repository-"));
  temporaryRoots.push(root);
  const databasePath = join(root, "agentlab.sqlite");
  const schedulePolicy = codec.schedulePolicy(testFactorySchedulePolicy());
  const admission = testFactoryCanaryAdmissionFixture({
    schedulePolicyDigest: schedulePolicy.digest,
    authorityExpiresAt: "2026-09-01T12:00:00.000Z",
    canaryMaximumLifetimeSeconds: 172_800
  });
  const reservation = await persistFactoryCanaryAdmissionFixture(databasePath, admission);
  const tasks = new SqliteFactoryRepository(databasePath);
  const contract = codec.taskContract({
    ...testFactoryContract(),
    trigger: "scheduled",
    repository: admission.preparation.request.repository,
    conversationId: admission.preparation.request.conversationId,
    budget: admission.preparation.authority.budgetCeiling,
    gateProfile: {
      ...testFactoryContract().gateProfile,
      policyDigest: admission.preparation.authority.policyBundleDigest
    },
    expiresAt: admission.preparation.authority.expiresAt
  });
  const initial = codec.taskEvent(
    testTaskEvent({
      contractDigest: contract.digest,
      eventId: "31313131-3131-4131-8131-313131313131",
      sequence: 1,
      previousEventDigest: null,
      from: null,
      to: "intake"
    })
  );
  const evidence = codec.evidenceBundle(
    testEvidenceBundle({
      contractDigest: contract.digest,
      bundleId: "32323232-3232-4232-8232-323232323232",
      sequence: 1,
      previousBundleDigest: null,
      policyBundleDigest: contract.value.gateProfile.policyDigest
    })
  );
  await tasks.create(contract, initial, evidence);
  let previous = initial;
  for (const [index, state] of (
    [
      "qualified",
      "specified",
      "planned",
      "queued",
      "executing",
      "verifying",
      "reviewing",
      "pr-proposed"
    ] as const
  ).entries()) {
    const sequence = index + 2;
    const next = codec.taskEvent({
      schemaVersion: "agentlab.task-event.v1",
      eventId: `34343434-3434-4434-8434-${String(sequence).padStart(12, "0")}`,
      taskId: contract.value.taskId,
      sequence,
      contractDigest: contract.digest,
      previousEventDigest: previous.digest,
      from: previous.value.to,
      to: state,
      actor: previous.value.actor,
      occurredAt: `2026-08-30T12:${String(sequence).padStart(2, "0")}:00.000Z`,
      reasonCode: "stage-complete",
      summary: null,
      evidenceBundleDigest: null,
      correlationId: TEST_FACTORY_CORRELATION_ID
    });
    await tasks.append(next);
    previous = next;
  }

  const schedules = new SqliteFactoryScheduleRepository(databasePath);
  const scheduleRun = codec.scheduleRun({
    schemaVersion: "agentlab.schedule-run.v2",
    runId: "41414141-4141-4141-8141-414141414141",
    schedulePolicyDigest: schedulePolicy.digest,
    schedulePolicy: schedulePolicy.value,
    factoryPolicyBundleDigest: admission.preparation.authority.policyBundleDigest,
    roleIdentityPolicyDigest: reservation.value.roleIdentityPolicyDigest,
    scheduledFor: TEST_FACTORY_SCHEDULED_FOR,
    deadlineAt: TEST_FACTORY_SCHEDULE_DEADLINE,
    createdAt: TEST_FACTORY_SCHEDULE_NOW,
    correlationId: "42424242-4242-4242-8242-424242424242"
  });
  const registeredSchedule = codec.scheduleEvent({
    ...scheduleEventBase(scheduleRun, null, "2026-08-31T12:05:00.000Z"),
    kind: "registered",
    from: null,
    to: "ready",
    reasonCode: "schedule-slot-registered"
  });
  await schedules.register(scheduleRun, registeredSchedule);
  const claim = codec.scheduleEvent({
    ...scheduleEventBase(scheduleRun, registeredSchedule, "2026-08-31T12:06:00.000Z"),
    schemaVersion: "agentlab.schedule-event.v2",
    kind: "task-claimed",
    from: "ready",
    to: "task-active",
    taskId: contract.value.taskId,
    requestDigest: admission.preparation.requestDigest,
    authorityDigest: admission.preparation.authorityDigest,
    taskCorrelationId: TEST_FACTORY_CORRELATION_ID,
    canaryReservationDigest: reservation.digest,
    reservation: reservation.value.budget,
    reasonCode: "scheduled-task-claimed"
  });
  await schedules.append(claim);
  const finished = codec.scheduleEvent({
    ...scheduleEventBase(scheduleRun, claim, "2026-08-31T12:07:00.000Z"),
    schemaVersion: "agentlab.schedule-event.v2",
    kind: "task-finished",
    from: "task-active",
    to: "ready",
    taskId: contract.value.taskId,
    taskCorrelationId: TEST_FACTORY_CORRELATION_ID,
    canaryReservationDigest: reservation.digest,
    result: "ready-for-broker",
    preparationState: "prepared",
    taskState: "pr-proposed",
    contractDigest: contract.digest,
    reasonCodes: [],
    reasonCode: "scheduled-task-ready-for-broker"
  });
  await schedules.append(finished);
  const completed = codec.scheduleEvent({
    ...scheduleEventBase(scheduleRun, finished, "2026-08-31T12:08:00.000Z"),
    kind: "completed",
    from: "ready",
    to: "completed",
    tasksClaimed: 1,
    tasksFinished: 1,
    tasksSkipped: 0,
    reservedUsage: {
      wallClockSeconds: reservation.value.budget.wallClockSeconds,
      agentTurns: reservation.value.budget.maxAgentTurns,
      toolCalls: reservation.value.budget.maxToolCalls,
      inputTokens: reservation.value.budget.maxInputTokens,
      outputTokens: reservation.value.budget.maxOutputTokens,
      costMicrousd: reservation.value.budget.maxCostMicrousd,
      processes: reservation.value.budget.maxProcesses,
      outputBytes: reservation.value.budget.maxOutputBytes,
      workers: reservation.value.budget.maxWorkers,
      repairAttempts: reservation.value.budget.maxRepairAttempts,
      changedFiles: reservation.value.budget.maxChangedFiles,
      changedLines: reservation.value.budget.maxChangedLines
    },
    reasonCode: "schedule-slot-completed"
  });
  await schedules.append(completed);

  const proposal = codec.pullRequestProposal({
    schemaVersion: "agentlab.pull-request-proposal.v1",
    taskId: contract.value.taskId,
    contractDigest: contract.digest,
    patchProposalDigest: testDigest("2"),
    patchArtifactDigest: testDigest("3"),
    changeSet: {
      baseRevision: contract.value.repository.baseRevision,
      headRevision: null,
      changedPaths: ["docs/example.md"],
      binaryPaths: [],
      changedFiles: 1,
      changedLines: 2
    },
    policyEvaluationDigest: testDigest("4"),
    deduplicationKey: contract.value.deduplicationKey,
    repositoryId: contract.value.repository.id,
    baseRevision: contract.value.repository.baseRevision,
    baseBranch: "main",
    branchName: `agentlab/${contract.value.deduplicationKey.slice("sha256:".length)}`,
    title: "docs: scheduled canary dispatch",
    body: "Exact evaluated brokered proposal.",
    draft: true,
    createdAt: "2026-08-31T12:10:00.000Z"
  });
  const runValue = {
    dispatchId,
    taskId: contract.value.taskId,
    contractDigest: contract.digest,
    proposalDigest: proposal.digest,
    proposal: proposal.value,
    brokerId: brokerActor.id,
    createdAt: proposal.value.createdAt,
    correlationId: TEST_FACTORY_CORRELATION_ID
  } as const;
  const legacyRun = codec.pullRequestDispatchRun({
    schemaVersion: "agentlab.pull-request-dispatch.v1",
    ...runValue
  });
  const run = codec.pullRequestDispatchRun({
    schemaVersion: "agentlab.pull-request-dispatch.v2",
    ...runValue,
    canaryReservationDigest: reservation.digest,
    schedulePolicyDigest: schedulePolicy.digest,
    roleIdentityPolicyDigest: reservation.value.roleIdentityPolicyDigest
  });
  const substitutedRun = codec.pullRequestDispatchRun({
    ...run.value,
    canaryReservationDigest: testDigest("f")
  });
  return {
    databasePath,
    tasks,
    schedules,
    dispatches: new SqliteFactoryPullRequestDispatchRepository(databasePath),
    contract,
    initial,
    evidence,
    taskLastEvent: previous,
    reservationDigest: reservation.digest,
    schedulePolicyDigest: schedulePolicy.digest,
    roleIdentityPolicyDigest: reservation.value.roleIdentityPolicyDigest,
    legacyRun,
    legacyRegistered: codec.pullRequestDispatchEvent({
      ...eventBase(legacyRun, null),
      kind: "registered",
      from: null,
      to: "ready"
    }),
    run,
    registered: codec.pullRequestDispatchEvent({
      ...eventBase(run, null),
      kind: "registered",
      from: null,
      to: "ready"
    }),
    substitutedRun,
    substitutedRegistered: codec.pullRequestDispatchEvent({
      ...eventBase(substitutedRun, null),
      kind: "registered",
      from: null,
      to: "ready"
    })
  };
}

function repairExecutionEventBase(
  run: ReturnType<NodeFactoryDocumentCodec["pullRequestRepairRun"]>,
  previous: ReturnType<NodeFactoryDocumentCodec["executionEvent"]> | null,
  occurredAt: string
) {
  const sequence = (previous?.value.sequence ?? 0) + 1;
  return {
    schemaVersion: "agentlab.execution-event.v1" as const,
    eventId: `70707070-7070-4070-8070-${String(sequence).padStart(12, "0")}`,
    runId: run.value.runId,
    runDigest: run.digest,
    taskId: run.value.taskId,
    contractDigest: run.value.contractDigest,
    sequence,
    previousEventDigest: previous?.digest ?? null,
    actor: {
      kind: "control-plane" as const,
      role: "policy-engine" as const,
      id: "agentlab-policy",
      sessionId: null
    },
    occurredAt,
    reasonCode: "test-repair-event",
    summary: null,
    correlationId: TEST_FACTORY_CORRELATION_ID
  };
}

function maintenanceEvidence(
  fixture: Awaited<ReturnType<typeof scheduledRepositoryFixture>>,
  input: {
    readonly sequence: number;
    readonly bundleId: string;
    readonly itemId: string;
    readonly previousBundleDigest: string;
    readonly subjectDigest: string;
    readonly mediaType: string;
    readonly result?: "pass" | "fail";
    readonly claims: readonly { readonly name: string; readonly value: string }[];
  }
) {
  return codec.evidenceBundle({
    schemaVersion: "agentlab.evidence-bundle.v1",
    bundleId: input.bundleId,
    taskId: fixture.contract.value.taskId,
    sequence: input.sequence,
    contractDigest: fixture.contract.digest,
    previousBundleDigest: input.previousBundleDigest,
    policyBundleDigest: fixture.contract.value.gateProfile.policyDigest,
    createdAt: `2026-08-31T12:${String(14 + input.sequence).padStart(2, "0")}:00.000Z`,
    items: [
      {
        id: input.itemId,
        kind: "pull-request",
        result: input.result ?? "fail",
        subjectDigest: input.subjectDigest,
        artifact: { digest: input.subjectDigest, mediaType: input.mediaType, sizeBytes: 1 },
        producer: brokerActor,
        createdAt: `2026-08-31T12:${String(14 + input.sequence).padStart(2, "0")}:00.000Z`,
        claims: input.claims
      }
    ],
    attestations: []
  });
}

async function repositoryFixture() {
  const root = mkdtempSync(join(tmpdir(), "agentlab-pr-dispatch-repository-"));
  temporaryRoots.push(root);
  const databasePath = join(root, "agentlab.sqlite");
  const tasks = new SqliteFactoryRepository(databasePath);
  const contract = codec.taskContract(testFactoryContract());
  const initial = codec.taskEvent(
    testTaskEvent({
      contractDigest: contract.digest,
      eventId: "33333333-3333-4333-8333-333333333333",
      sequence: 1,
      previousEventDigest: null,
      from: null,
      to: "intake"
    })
  );
  const evidence = codec.evidenceBundle(
    testEvidenceBundle({
      contractDigest: contract.digest,
      bundleId: "66666666-6666-4666-8666-666666666666",
      sequence: 1,
      previousBundleDigest: null
    })
  );
  await tasks.create(contract, initial, evidence);
  const proposal = codec.pullRequestProposal({
    schemaVersion: "agentlab.pull-request-proposal.v1",
    taskId: contract.value.taskId,
    contractDigest: contract.digest,
    patchProposalDigest: testDigest("2"),
    patchArtifactDigest: testDigest("3"),
    changeSet: {
      baseRevision: contract.value.repository.baseRevision,
      headRevision: null,
      changedPaths: ["docs/example.md"],
      binaryPaths: [],
      changedFiles: 1,
      changedLines: 2
    },
    policyEvaluationDigest: testDigest("4"),
    deduplicationKey: contract.value.deduplicationKey,
    repositoryId: contract.value.repository.id,
    baseRevision: contract.value.repository.baseRevision,
    baseBranch: "main",
    branchName: `agentlab/${contract.value.deduplicationKey.slice("sha256:".length)}`,
    title: "docs: durable broker dispatch",
    body: "Exact reviewed proposal.",
    draft: true,
    createdAt: "2026-08-30T13:00:00.000Z"
  });
  const run = codec.pullRequestDispatchRun({
    schemaVersion: "agentlab.pull-request-dispatch.v1",
    dispatchId,
    taskId: contract.value.taskId,
    contractDigest: contract.digest,
    proposalDigest: proposal.digest,
    proposal: proposal.value,
    brokerId: brokerActor.id,
    createdAt: proposal.value.createdAt,
    correlationId: TEST_FACTORY_CORRELATION_ID
  });
  const registered = codec.pullRequestDispatchEvent({
    ...eventBase(run, null),
    kind: "registered",
    from: null,
    to: "ready"
  });
  return {
    databasePath,
    tasks,
    dispatches: new SqliteFactoryPullRequestDispatchRepository(databasePath),
    contract,
    initial,
    evidence,
    run,
    registered
  };
}

function event(
  run: ReturnType<NodeFactoryDocumentCodec["pullRequestDispatchRun"]>,
  previous: ReturnType<NodeFactoryDocumentCodec["pullRequestDispatchEvent"]>,
  fields: Readonly<Record<string, unknown>>
) {
  return codec.pullRequestDispatchEvent({ ...eventBase(run, previous), ...fields });
}

function scheduleEventBase(
  run: ReturnType<NodeFactoryDocumentCodec["scheduleRun"]>,
  previous: ReturnType<NodeFactoryDocumentCodec["scheduleEvent"]> | null,
  occurredAt: string
) {
  const sequence = (previous?.value.sequence ?? 0) + 1;
  return {
    schemaVersion: "agentlab.schedule-event.v1" as const,
    eventId: `51515151-5151-4151-8151-${String(sequence).padStart(12, "0")}`,
    runId: run.value.runId,
    runDigest: run.digest,
    sequence,
    previousEventDigest: previous?.digest ?? null,
    actor: {
      kind: "control-plane" as const,
      role: "policy-engine" as const,
      id: "agentlab-scheduler",
      sessionId: null
    },
    occurredAt,
    correlationId: run.value.correlationId
  };
}

function eventBase(
  run: ReturnType<NodeFactoryDocumentCodec["pullRequestDispatchRun"]>,
  previous: ReturnType<NodeFactoryDocumentCodec["pullRequestDispatchEvent"]> | null
) {
  const sequence = (previous?.value.sequence ?? 0) + 1;
  return {
    schemaVersion: "agentlab.pull-request-dispatch-event.v1" as const,
    eventId: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    dispatchId: run.value.dispatchId,
    dispatchDigest: run.digest,
    taskId: run.value.taskId,
    contractDigest: run.value.contractDigest,
    sequence,
    previousEventDigest: previous?.digest ?? null,
    actor: brokerActor,
    occurredAt:
      previous === null ? run.value.createdAt : minutesAfter(run.value.createdAt, sequence - 1),
    reasonCode: "test-dispatch-event",
    summary: null,
    correlationId: TEST_FACTORY_CORRELATION_ID
  };
}

function pullRequestRecord(
  fixture: Pick<
    Awaited<ReturnType<typeof repositoryFixture>>,
    "run" | "contract" | "initial" | "evidence" | "tasks" | "dispatches" | "databasePath"
  >
) {
  const proposal = fixture.run.value.proposal;
  return {
    schemaVersion: "agentlab.pull-request-record.v1" as const,
    taskId: fixture.run.value.taskId,
    contractDigest: fixture.run.value.contractDigest,
    proposalDigest: fixture.run.value.proposalDigest,
    repositoryId: proposal.repositoryId,
    number: 42,
    url: "https://github.com/example/agentlab/pull/42",
    baseRevision: proposal.baseRevision,
    headRevision: "b".repeat(40),
    branchName: proposal.branchName,
    draft: true as const,
    brokerId: brokerActor.id,
    createdAt: minutesAfter(fixture.run.value.createdAt, 1)
  };
}

function minutesAfter(timestamp: string, minutes: number): string {
  return new Date(Date.parse(timestamp) + minutes * 60_000).toISOString();
}

async function advanceTaskToPullRequestOpen(
  fixture: Awaited<ReturnType<typeof repositoryFixture>>
) {
  let previous = fixture.initial;
  const states: readonly FactoryTaskState[] = [
    "qualified",
    "specified",
    "planned",
    "queued",
    "executing",
    "verifying",
    "reviewing",
    "pr-proposed",
    "pr-open"
  ];
  for (const [index, state] of states.entries()) {
    const sequence = index + 2;
    const eventDocument = codec.taskEvent({
      schemaVersion: "agentlab.task-event.v1",
      eventId: `99999999-9999-4999-8999-${String(sequence).padStart(12, "0")}`,
      taskId: fixture.contract.value.taskId,
      sequence,
      contractDigest: fixture.contract.digest,
      previousEventDigest: previous.digest,
      from: previous.value.to,
      to: state,
      actor: state === "pr-open" ? brokerActor : previous.value.actor,
      occurredAt: `2026-08-30T12:${String(sequence).padStart(2, "0")}:00.000Z`,
      reasonCode: state === "pr-open" ? "draft-pr-opened" : "stage-complete",
      summary: null,
      evidenceBundleDigest: state === "pr-open" ? fixture.evidence.digest : null,
      correlationId: TEST_FACTORY_CORRELATION_ID
    });
    await fixture.tasks.append(eventDocument);
    previous = eventDocument;
  }
  return previous;
}
