import type { Sha256Digest } from "@agentlab/contracts";
import { describe, expect, it } from "vitest";

import {
  FactoryPullRequestCanaryAuthority,
  type FactoryPullRequestCanaryCoordinates
} from "../../packages/runtime/src/application/factory-pull-request-canary-authority.js";
import type { FactoryCanaryReservationSnapshot } from "../../packages/runtime/src/domain/factory-canary-reservation-repository.js";
import type { FactoryDailyQuotaReservationSnapshot } from "../../packages/runtime/src/domain/factory-daily-quota-repository.js";
import type { FactoryPreparationSnapshot } from "../../packages/runtime/src/domain/factory-preparation-repository.js";
import type { FactoryScheduledTaskCompletion } from "../../packages/runtime/src/domain/factory-schedule-repository.js";
import type { FactoryTaskSnapshot } from "../../packages/runtime/src/domain/factory-task-repository.js";
import {
  testDigest,
  testFactoryContract,
  TEST_FACTORY_CORRELATION_ID,
  TEST_FACTORY_TASK_ID
} from "../helpers/factory.js";
import {
  testFactoryCanaryAdmissionFixture,
  testFactoryCanaryReservationDocument
} from "../helpers/factory-canary-admission.js";
import { testFactorySchedulePolicy } from "../helpers/factory-schedule.js";
import { testFactoryDailyQuotaPolicy } from "../helpers/factory-daily-quota.js";

describe("FactoryPullRequestCanaryAuthority", () => {
  it("requires the exact current brokered reservation and completed scheduler handoff", async () => {
    const fixture = authorityFixture();

    await expect(fixture.authority.require(fixture.task, fixture.coordinates)).resolves.toBe(
      fixture.reservation.reservationDigest
    );
    await expect(
      fixture.authority.require(fixture.task, {
        ...fixture.coordinates,
        reservationDigest: testDigest("f")
      })
    ).rejects.toThrow(/missing its complete canary authority chain/u);
  });

  it("rejects an insufficient stage, expiry, or divergent schedule outcome", async () => {
    const wrongStage = authorityFixture({ stage: "local-proposal" });
    await expect(
      wrongStage.authority.require(wrongStage.task, wrongStage.coordinates)
    ).rejects.toThrow(/brokered canary reservation/u);

    const expired = authorityFixture({ now: "2026-09-01T12:00:00.000Z" });
    await expect(expired.authority.require(expired.task, expired.coordinates)).rejects.toThrow(
      /not currently valid/u
    );

    const mismatched = authorityFixture({ completionReservationDigest: testDigest("e") });
    await expect(
      mismatched.authority.require(mismatched.task, mismatched.coordinates)
    ).rejects.toThrow(/completed scheduler handoff/u);
  });

  it("independently rejects substituted daily quota evidence", async () => {
    const wrongDigest = authorityFixture({
      completionDailyQuotaReservationDigest: testDigest("f")
    });
    await expect(
      wrongDigest.authority.require(wrongDigest.task, wrongDigest.coordinates)
    ).rejects.toThrow(/changed its daily quota reservation/u);

    const wrongCorrelation = authorityFixture({
      dailyQuotaCorrelationId: "22222222-2222-4222-8222-222222222222"
    });
    await expect(
      wrongCorrelation.authority.require(wrongCorrelation.task, wrongCorrelation.coordinates)
    ).rejects.toThrow(/immutable identity/u);
  });

  it("keeps manually confirmed dispatch separate from canary authority", async () => {
    const fixture = authorityFixture();
    const manualTask = {
      ...fixture.task,
      contract: { ...fixture.task.contract, trigger: "manual" as const }
    };

    await expect(fixture.authority.require(manualTask, undefined)).resolves.toBeNull();
    await expect(fixture.authority.require(manualTask, fixture.coordinates)).rejects.toThrow(
      /cannot consume canary broker authority/u
    );
  });
});

function authorityFixture(
  options: {
    readonly stage?: "brokered-draft-pr" | "local-proposal";
    readonly now?: string;
    readonly completionReservationDigest?: Sha256Digest;
    readonly completionDailyQuotaReservationDigest?: Sha256Digest;
    readonly dailyQuotaCorrelationId?: string;
  } = {}
) {
  const documents = testFactoryCanaryAdmissionFixture().documents;
  const schedulePolicy = documents.schedulePolicy(testFactorySchedulePolicy());
  const dailyQuotaPolicy = documents.dailyQuotaPolicy(testFactoryDailyQuotaPolicy());
  const admission = testFactoryCanaryAdmissionFixture({
    schedulePolicyDigest: schedulePolicy.digest,
    authorityExpiresAt: "2026-09-01T12:00:00.000Z",
    canaryMaximumLifetimeSeconds: 172_800
  });
  const originalReservation = testFactoryCanaryReservationDocument(admission);
  const reservationDocument =
    options.stage === undefined
      ? originalReservation
      : documents.canaryTaskReservation({
          ...originalReservation.value,
          stage: options.stage
        });
  const contract = documents.taskContract({
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
  const prepared = documents.preparationEvent({
    ...admission.registered.value,
    eventId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    sequence: 2,
    previousEventDigest: admission.registered.digest,
    kind: "prepared",
    from: "planned",
    to: "prepared",
    occurredAt: "2026-08-30T12:20:00.000Z",
    reasonCode: "task-materialized",
    preparationBundleDigest: testDigest("b"),
    contractDigest: contract.digest,
    evidenceBundleDigest: testDigest("c")
  });
  const preparation: FactoryPreparationSnapshot = {
    ...admission.preparation,
    state: "prepared",
    sequence: prepared.value.sequence,
    lastEvent: prepared.value,
    lastEventDigest: prepared.digest
  };
  const taskEvent = documents.taskEvent({
    schemaVersion: "agentlab.task-event.v1",
    eventId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    taskId: TEST_FACTORY_TASK_ID,
    sequence: 8,
    contractDigest: contract.digest,
    previousEventDigest: testDigest("d"),
    from: "reviewing",
    to: "pr-proposed",
    actor: {
      kind: "agent",
      role: "reviewer",
      id: "reviewer",
      sessionId: "review-session"
    },
    occurredAt: "2026-08-30T12:40:00.000Z",
    reasonCode: "independent-review-passed",
    summary: null,
    evidenceBundleDigest: testDigest("e"),
    correlationId: options.dailyQuotaCorrelationId ?? TEST_FACTORY_CORRELATION_ID
  });
  const task: FactoryTaskSnapshot = {
    contract: contract.value,
    contractDigest: contract.digest,
    state: "pr-proposed",
    sequence: taskEvent.value.sequence,
    lastEvent: taskEvent.value,
    lastEventDigest: taskEvent.digest
  };
  const run = documents.scheduleRun({
    schemaVersion: "agentlab.schedule-run.v3",
    runId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    schedulePolicyDigest: schedulePolicy.digest,
    schedulePolicy: schedulePolicy.value,
    factoryPolicyBundleDigest: admission.preparation.authority.policyBundleDigest,
    roleIdentityPolicyDigest: reservationDocument.value.roleIdentityPolicyDigest,
    dailyQuotaPolicyDigest: dailyQuotaPolicy.digest,
    scheduledFor: "2026-08-30T12:30:00.000Z",
    deadlineAt: "2026-08-30T12:45:00.000Z",
    createdAt: "2026-08-30T12:31:00.000Z",
    correlationId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
  });
  const repositoryQuota = dailyQuotaPolicy.value.repositories[0];
  if (repositoryQuota === undefined) throw new Error("Daily quota test profile is missing.");
  const dailyQuotaDocument = documents.dailyQuotaReservation({
    schemaVersion: "agentlab.daily-quota-reservation.v1",
    reservationId: "11111111-1111-4111-8111-111111111111",
    quotaPolicyDigest: dailyQuotaPolicy.digest,
    quotaPolicy: dailyQuotaPolicy.value,
    organizationId: dailyQuotaPolicy.value.organizationId,
    repositoryId: task.contract.repository.id,
    taskId: task.contract.taskId,
    scheduleRunId: run.value.runId,
    scheduleRunDigest: run.digest,
    canaryReservationDigest: reservationDocument.digest,
    windowStart: "2026-08-30T00:00:00.000Z",
    windowEnd: "2026-08-31T00:00:00.000Z",
    repositoryQuota,
    organizationQuota: dailyQuotaPolicy.value.organization,
    budget: reservationDocument.value.budget,
    draftPullRequests: 1,
    reservedAt: "2026-08-30T12:31:30.000Z",
    correlationId: TEST_FACTORY_CORRELATION_ID
  });
  const finished = documents.scheduleEvent({
    schemaVersion: "agentlab.schedule-event.v3",
    eventId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
    runId: run.value.runId,
    runDigest: run.digest,
    sequence: 3,
    previousEventDigest: testDigest("1"),
    kind: "task-finished",
    from: "task-active",
    to: "ready",
    taskId: TEST_FACTORY_TASK_ID,
    taskCorrelationId: TEST_FACTORY_CORRELATION_ID,
    canaryReservationDigest: options.completionReservationDigest ?? reservationDocument.digest,
    dailyQuotaReservationDigest:
      options.completionDailyQuotaReservationDigest ?? dailyQuotaDocument.digest,
    result: "ready-for-broker",
    preparationState: "prepared",
    taskState: "pr-proposed",
    contractDigest: contract.digest,
    reasonCodes: [],
    actor: {
      kind: "control-plane",
      role: "policy-engine",
      id: "agentlab-scheduler",
      sessionId: null
    },
    occurredAt: "2026-08-30T12:41:00.000Z",
    reasonCode: "scheduled-task-ready-for-broker",
    correlationId: run.value.correlationId
  });
  if (finished.value.kind !== "task-finished") {
    throw new Error("Canary authority test requires a task completion event.");
  }
  const reservation: FactoryCanaryReservationSnapshot = {
    reservation: reservationDocument.value,
    reservationDigest: reservationDocument.digest
  };
  const completion: FactoryScheduledTaskCompletion = {
    run: run.value,
    runDigest: run.digest,
    state: "completed",
    event: finished.value
  };
  const dailyQuota: FactoryDailyQuotaReservationSnapshot = {
    reservation: dailyQuotaDocument.value,
    reservationDigest: dailyQuotaDocument.digest
  };
  const coordinates: FactoryPullRequestCanaryCoordinates = {
    reservationDigest: reservationDocument.digest,
    schedulePolicyDigest: schedulePolicy.digest,
    roleIdentityPolicyDigest: reservationDocument.value.roleIdentityPolicyDigest
  };
  const authority = new FactoryPullRequestCanaryAuthority({
    policyBundleDigest: admission.preparation.authority.policyBundleDigest,
    schedulePolicyDigest: schedulePolicy.digest,
    roleIdentityPolicyDigest: reservationDocument.value.roleIdentityPolicyDigest,
    dailyQuotaPolicy,
    preparations: { findById: () => Promise.resolve(preparation) },
    reservations: {
      findByReservationDigest: (digest) =>
        Promise.resolve(digest === reservation.reservationDigest ? reservation : null)
    },
    schedules: { findTaskCompletion: () => Promise.resolve(completion) },
    dailyQuotas: { findByTaskId: () => Promise.resolve(dailyQuota) },
    documents,
    now: () => options.now ?? "2026-08-30T12:42:00.000Z"
  });
  return { authority, task, preparation, reservation, completion, coordinates };
}
