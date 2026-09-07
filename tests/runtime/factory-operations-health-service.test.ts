import type {
  FactoryDailyQuotaReservation,
  FactoryScheduleEvent,
  FactoryScheduleRun,
  ImmutableTaskContract,
  TaskEvent
} from "@agentlab/contracts";
import { describe, expect, it } from "vitest";

import { FactoryOperationsHealthService } from "../../packages/runtime/src/application/factory-operations-health-service.js";
import type { FactoryOperationsHealthObservation } from "../../packages/runtime/src/domain/factory-operations-health-source.js";
import { NodeFactoryDocumentCodec } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { testFactoryDailyQuotaPolicy } from "../helpers/factory-daily-quota.js";
import { testFactoryOperationsHealthPolicy } from "../helpers/factory-operations-health.js";
import { testFactorySchedulePolicy } from "../helpers/factory-schedule.js";
import {
  TEST_FACTORY_CORRELATION_ID,
  TEST_FACTORY_TASK_ID,
  testDigest,
  testFactoryActor,
  testFactoryContract
} from "../helpers/factory.js";

const documents = new NodeFactoryDocumentCodec();
const healthPolicy = documents.operationsHealthPolicy(testFactoryOperationsHealthPolicy());
const dailyQuotaPolicy = documents.dailyQuotaPolicy(testFactoryDailyQuotaPolicy());
const observedAt = "2026-08-31T13:00:00.000Z";

describe("FactoryOperationsHealthService", () => {
  it("reports a healthy dormant ledger without treating disabled authority as failure", async () => {
    const report = await service(emptyObservation()).inspect();

    expect(report.value).toMatchObject({
      status: "healthy",
      incidentRecommended: false,
      reasonCodes: [],
      authority: {
        schedulerEnabled: false,
        prBrokerEnabled: false,
        autonomousDraftsEnabled: false,
        mergeBrokerEnabled: false,
        autonomousMergesEnabled: false
      },
      schedules: { observed: 0, overdue: 0 },
      tasks: { observed: 0, quarantined: 0 },
      dailyQuota: {
        organization: { tasksReserved: 0, maximumBudgetUtilizationBasisPoints: 0 }
      }
    });
    expect(report.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("degrades on recent failed work and reviewed quota warning thresholds", async () => {
    const observation: FactoryOperationsHealthObservation = {
      ...emptyObservation(),
      authority: { scheduler: true, prBroker: true, mergeBroker: true },
      tasks: [taskObservation("failed", "2026-08-31T12:40:00.000Z")],
      dailyQuotaReservations: [quotaReservation()]
    };

    const report = await service(observation).inspect();

    expect(report.value.status).toBe("degraded");
    expect(report.value.incidentRecommended).toBe(false);
    expect(report.value.reasonCodes).toEqual(["daily-quota-warning", "recent-failed-task"]);
    expect(report.value.authority.autonomousDraftsEnabled).toBe(true);
    expect(report.value.authority.autonomousMergesEnabled).toBe(true);
    expect(report.value.dailyQuota.organization).toMatchObject({
      tasksReserved: 1,
      draftPullRequestsReserved: 1,
      maximumBudgetUtilizationBasisPoints: 10_000
    });
  });

  it("recommends containment for overdue schedules, stalled work, quarantine, or truncation", async () => {
    const observation: FactoryOperationsHealthObservation = {
      ...emptyObservation(),
      schedules: [scheduleObservation()],
      tasks: [
        taskObservation("executing", "2026-08-31T11:00:00.000Z"),
        taskObservation(
          "quarantined",
          "2026-08-31T12:50:00.000Z",
          "21111111-1111-4111-8111-111111111111"
        )
      ],
      truncatedSections: ["daily-quotas"]
    };

    const report = await service(observation).inspect();

    expect(report.value.status).toBe("critical");
    expect(report.value.incidentRecommended).toBe(true);
    expect(report.value.reasonCodes).toEqual([
      "observation-truncated",
      "overdue-schedule-run",
      "recent-quarantined-task",
      "stalled-autonomous-task"
    ]);
    expect(report.value.schedules).toMatchObject({ open: 1, overdue: 1 });
    expect(report.value.tasks).toMatchObject({ active: 1, quarantined: 1, stalled: 1 });
  });

  it("rejects duplicate source identities and quota policy drift", async () => {
    const task = taskObservation("failed", "2026-08-31T12:40:00.000Z");
    await expect(service({ ...emptyObservation(), tasks: [task, task] }).inspect()).rejects.toThrow(
      /duplicate tasks/u
    );
    await expect(
      service({
        ...emptyObservation(),
        dailyQuotaReservations: [{ ...quotaReservation(), quotaPolicyDigest: testDigest("f") }]
      }).inspect()
    ).rejects.toThrow(/policy drift/u);
    await expect(
      service({
        ...emptyObservation(),
        tasks: [taskObservation("failed", "2026-08-31T13:00:01.000Z")]
      }).inspect()
    ).rejects.toThrow(/future ledger evidence/u);
  });
});

function service(observation: FactoryOperationsHealthObservation) {
  return new FactoryOperationsHealthService({
    observerId: "operations-observer",
    healthPolicy,
    dailyQuotaPolicy,
    source: { observe: () => Promise.resolve(observation) },
    documents,
    now: () => observedAt,
    createId: () => "10000000-0000-4000-8000-000000000001"
  });
}

function emptyObservation(): FactoryOperationsHealthObservation {
  return {
    authority: { scheduler: false, prBroker: false },
    schedules: [],
    tasks: [],
    dailyQuotaReservations: [],
    truncatedSections: []
  };
}

function scheduleObservation(): FactoryOperationsHealthObservation["schedules"][number] {
  const schedulePolicy = documents.schedulePolicy(testFactorySchedulePolicy());
  const run: FactoryScheduleRun = documents.scheduleRun({
    schemaVersion: "agentlab.schedule-run.v1",
    runId: "30000000-0000-4000-8000-000000000003",
    schedulePolicyDigest: schedulePolicy.digest,
    schedulePolicy: schedulePolicy.value,
    factoryPolicyBundleDigest: testDigest("4"),
    scheduledFor: "2026-08-31T12:00:00.000Z",
    deadlineAt: "2026-08-31T12:30:00.000Z",
    createdAt: "2026-08-31T12:01:00.000Z",
    correlationId: "40000000-0000-4000-8000-000000000004"
  }).value;
  const runDocument = documents.scheduleRun(run);
  const lastEvent: FactoryScheduleEvent = documents.scheduleEvent({
    schemaVersion: "agentlab.schedule-event.v1",
    eventId: "50000000-0000-4000-8000-000000000005",
    runId: run.runId,
    runDigest: runDocument.digest,
    sequence: 1,
    previousEventDigest: null,
    kind: "registered",
    from: null,
    to: "ready",
    actor: {
      kind: "control-plane",
      role: "policy-engine",
      id: "agentlab-scheduler",
      sessionId: null
    },
    occurredAt: run.createdAt,
    reasonCode: "schedule-run-registered",
    correlationId: run.correlationId
  }).value;
  return { run, state: "ready", lastEvent };
}

function taskObservation(
  state: TaskEvent["to"],
  occurredAt: string,
  taskId: string = TEST_FACTORY_TASK_ID
): FactoryOperationsHealthObservation["tasks"][number] {
  const contract: ImmutableTaskContract = documents.taskContract({
    ...testFactoryContract(),
    taskId,
    trigger: "scheduled",
    expiresAt: "2026-08-31T14:00:00.000Z"
  }).value;
  const contractDocument = documents.taskContract(contract);
  const lastEvent: TaskEvent = documents.taskEvent({
    schemaVersion: "agentlab.task-event.v1",
    eventId:
      taskId === TEST_FACTORY_TASK_ID
        ? "60000000-0000-4000-8000-000000000006"
        : "70000000-0000-4000-8000-000000000007",
    taskId,
    sequence: 2,
    contractDigest: contractDocument.digest,
    previousEventDigest: testDigest("8"),
    from: "executing",
    to: state,
    actor: testFactoryActor,
    occurredAt,
    reasonCode: "health-test-state",
    summary: null,
    evidenceBundleDigest: null,
    correlationId: TEST_FACTORY_CORRELATION_ID
  }).value;
  return { contract, state, lastEvent };
}

function quotaReservation(): FactoryDailyQuotaReservation {
  const policy = dailyQuotaPolicy.value;
  const repositoryQuota = policy.repositories[0];
  if (repositoryQuota === undefined) throw new Error("Health quota test repository is missing.");
  return documents.dailyQuotaReservation({
    schemaVersion: "agentlab.daily-quota-reservation.v1",
    reservationId: "80000000-0000-4000-8000-000000000008",
    quotaPolicyDigest: dailyQuotaPolicy.digest,
    quotaPolicy: policy,
    organizationId: policy.organizationId,
    repositoryId: repositoryQuota.repositoryId,
    taskId: TEST_FACTORY_TASK_ID,
    scheduleRunId: "30000000-0000-4000-8000-000000000003",
    scheduleRunDigest: testDigest("9"),
    canaryReservationDigest: testDigest("a"),
    windowStart: "2026-08-31T00:00:00.000Z",
    windowEnd: "2026-09-01T00:00:00.000Z",
    repositoryQuota,
    organizationQuota: policy.organization,
    budget: repositoryQuota.budget,
    draftPullRequests: 1,
    reservedAt: "2026-08-31T12:05:00.000Z",
    correlationId: TEST_FACTORY_CORRELATION_ID
  }).value;
}
