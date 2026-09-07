import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { FactoryBudget, FactoryDailyQuotaPolicy } from "@agentlab/contracts";
import { afterEach, describe, expect, it } from "vitest";

import {
  FactoryDailyQuotaCapacityError,
  type FactoryDailyQuotaScope
} from "../../packages/runtime/src/domain/factory-daily-quota-repository.js";
import type { CanonicalFactoryDocument } from "../../packages/runtime/src/domain/factory-documents.js";
import { NodeFactoryDocumentCodec } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { SqliteFactoryCanaryReservationRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-canary-reservation-repository.js";
import { SqliteFactoryDailyQuotaRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-daily-quota-repository.js";
import { SqliteFactoryPreparationRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-preparation-repository.js";
import { SqliteFactoryScheduleRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-schedule-repository.js";
import {
  persistFactoryCanaryAdmissionFixture,
  testFactoryCanaryAdmissionFixture,
  testFactoryCanaryReservationDocument,
  type FactoryCanaryAdmissionFixture
} from "../helpers/factory-canary-admission.js";
import { testFactoryDailyQuotaPolicy } from "../helpers/factory-daily-quota.js";
import { testFactoryEvalBudget } from "../helpers/factory-evaluation.js";
import { testFactorySchedulePolicy } from "../helpers/factory-schedule.js";
import { testDigest } from "../helpers/factory.js";

const documents = new NodeFactoryDocumentCodec();
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("SqliteFactoryDailyQuotaRepository", () => {
  it("stores one canonical immutable reservation and binds it to canary, run, repository, budget, and UTC day", async () => {
    const fixture = await quotaFixture();
    const quota = quotaDocument(fixture);
    try {
      await expect(fixture.quotas.reserve(quota)).resolves.toEqual({
        reservation: quota.value,
        reservationDigest: quota.digest
      });
      await expect(fixture.quotas.findByTaskId(fixture.canary.value.taskId)).resolves.toEqual({
        reservation: quota.value,
        reservationDigest: quota.digest
      });
      await expect(fixture.quotas.findByReservationDigest(quota.digest)).resolves.toEqual({
        reservation: quota.value,
        reservationDigest: quota.digest
      });

      const database = new DatabaseSync(fixture.databasePath);
      try {
        expect(() =>
          database
            .prepare("UPDATE factory_daily_quota_reservations SET reserved_at = reserved_at")
            .run()
        ).toThrow(/immutable/u);
        expect(() =>
          database.prepare("DELETE FROM factory_daily_quota_reservations").run()
        ).toThrow(/immutable/u);
      } finally {
        database.close();
      }

      const anotherRepository = quotaDocument(fixture, {
        reservationId: "81000000-0000-4000-8000-000000000001",
        repositoryId: "another/repository"
      });
      expect(() => fixture.quotas.reserve(anotherRepository)).toThrow(/identity mismatch/u);
      const smallerBudget = quotaDocument(fixture, {
        reservationId: "82000000-0000-4000-8000-000000000002",
        budget: { ...quota.value.budget, maxToolCalls: quota.value.budget.maxToolCalls - 1 }
      });
      expect(() => fixture.quotas.reserve(smallerBudget)).toThrow(/identity mismatch/u);
      const wrongDay = quotaDocument(fixture, {
        reservationId: "83000000-0000-4000-8000-000000000003",
        windowStart: "2026-09-01T00:00:00.000Z",
        windowEnd: "2026-09-02T00:00:00.000Z",
        reservedAt: "2026-09-01T12:05:00.000Z"
      });
      expect(() => fixture.quotas.reserve(wrongDay)).toThrow(/identity mismatch/u);
    } finally {
      fixture.close();
    }
  });

  it("enforces repository and organization ceilings atomically", async () => {
    for (const scope of ["repository", "organization"] as const) {
      const fixture = await quotaFixture({ capacityScope: scope });
      try {
        const second = await persistAdditionalCanaryTask(fixture);
        await fixture.quotas.reserve(quotaDocument(fixture));
        const secondQuota = quotaDocument(fixture, {
          reservationId: "84000000-0000-4000-8000-000000000004",
          canary: second,
          correlationId: "85000000-0000-4000-8000-000000000005"
        });
        expect(() => fixture.quotas.reserve(secondQuota)).toThrow(
          new FactoryDailyQuotaCapacityError(scope)
        );
        await expect(fixture.quotas.findByTaskId(second.value.taskId)).resolves.toBeNull();
      } finally {
        fixture.close();
      }
    }
  });

  it("rejects a v3 task claim until its exact quota reservation is durable", async () => {
    const fixture = await quotaFixture();
    try {
      const quota = quotaDocument(fixture);
      const claim = documents.scheduleEvent({
        schemaVersion: "agentlab.schedule-event.v3",
        eventId: "86000000-0000-4000-8000-000000000006",
        runId: fixture.run.value.runId,
        runDigest: fixture.run.digest,
        sequence: 2,
        previousEventDigest: fixture.registered.digest,
        kind: "task-claimed",
        from: "ready",
        to: "task-active",
        taskId: fixture.admission.preparation.request.taskId,
        requestDigest: fixture.admission.preparation.requestDigest,
        authorityDigest: fixture.admission.preparation.authorityDigest,
        taskCorrelationId: quota.value.correlationId,
        canaryReservationDigest: fixture.canary.digest,
        dailyQuotaReservationDigest: quota.digest,
        reservation: fixture.canary.value.budget,
        actor: schedulerActor(),
        occurredAt: "2026-08-31T12:05:00.000Z",
        reasonCode: "scheduled-task-claimed",
        correlationId: fixture.run.value.correlationId
      });
      expect(() => fixture.schedules.append(claim)).toThrow(/daily quota claim mismatch/u);
      await fixture.quotas.reserve(quota);
      await expect(fixture.schedules.append(claim)).resolves.toMatchObject({
        state: "task-active",
        lastEventDigest: claim.digest
      });
    } finally {
      fixture.close();
    }
  });
});

interface QuotaFixture {
  readonly databasePath: string;
  readonly admission: FactoryCanaryAdmissionFixture;
  readonly canary: ReturnType<typeof testFactoryCanaryReservationDocument>;
  readonly policy: CanonicalFactoryDocument<FactoryDailyQuotaPolicy>;
  readonly run: ReturnType<NodeFactoryDocumentCodec["scheduleRun"]>;
  readonly registered: ReturnType<NodeFactoryDocumentCodec["scheduleEvent"]>;
  readonly quotas: SqliteFactoryDailyQuotaRepository;
  readonly schedules: SqliteFactoryScheduleRepository;
  close(): void;
}

async function quotaFixture(
  options: { readonly capacityScope?: FactoryDailyQuotaScope } = {}
): Promise<QuotaFixture> {
  const root = mkdtempSync(join(tmpdir(), "agentlab-daily-quota-"));
  temporaryRoots.push(root);
  const databasePath = join(root, "agentlab.sqlite");
  const schedulePolicy = documents.schedulePolicy(testFactorySchedulePolicy());
  const canaryBudget = aggregate(testFactoryEvalBudget(), 2);
  const admission = testFactoryCanaryAdmissionFixture({
    maximumTasks: 2,
    canaryBudget,
    schedulePolicyDigest: schedulePolicy.digest,
    authorityExpiresAt: "2026-09-01T12:00:00.000Z",
    canaryMaximumLifetimeSeconds: 172_800
  });
  const canary = await persistFactoryCanaryAdmissionFixture(databasePath, admission);
  const aggregateBudget = canaryBudget;
  const maximumRepositoryTasks = options.capacityScope === "repository" ? 1 : 2;
  const maximumOrganizationTasks = options.capacityScope === "organization" ? 1 : 2;
  const policy = documents.dailyQuotaPolicy(
    testFactoryDailyQuotaPolicy({
      repositories: [
        {
          repositoryId: "agentlab",
          maximumTasksPerDay: maximumRepositoryTasks,
          maximumDraftPullRequestsPerDay: maximumRepositoryTasks,
          budget: aggregateBudget
        },
        {
          repositoryId: "another/repository",
          maximumTasksPerDay: 2,
          maximumDraftPullRequestsPerDay: 2,
          budget: aggregateBudget
        }
      ],
      organization: {
        maximumTasksPerDay: maximumOrganizationTasks,
        maximumDraftPullRequestsPerDay: maximumOrganizationTasks,
        budget: aggregateBudget
      }
    })
  );
  const run = documents.scheduleRun({
    schemaVersion: "agentlab.schedule-run.v3",
    runId: "70000000-0000-4000-8000-000000000007",
    schedulePolicyDigest: schedulePolicy.digest,
    schedulePolicy: schedulePolicy.value,
    factoryPolicyBundleDigest: admission.preparation.authority.policyBundleDigest,
    roleIdentityPolicyDigest: admission.canary.cohort.value.roleIdentityPolicyDigest,
    dailyQuotaPolicyDigest: policy.digest,
    scheduledFor: "2026-08-31T12:00:00.000Z",
    deadlineAt: "2026-08-31T12:30:00.000Z",
    createdAt: "2026-08-31T12:05:00.000Z",
    correlationId: "71000000-0000-4000-8000-000000000007"
  });
  const registered = documents.scheduleEvent({
    schemaVersion: "agentlab.schedule-event.v1",
    eventId: "72000000-0000-4000-8000-000000000007",
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
  const schedules = new SqliteFactoryScheduleRepository(databasePath, { documents });
  await schedules.register(run, registered);
  const quotas = new SqliteFactoryDailyQuotaRepository(databasePath, { documents });
  return {
    databasePath,
    admission,
    canary,
    policy,
    run,
    registered,
    quotas,
    schedules,
    close: () => {
      quotas.close();
      schedules.close();
    }
  };
}

async function persistAdditionalCanaryTask(
  fixture: QuotaFixture
): Promise<ReturnType<typeof testFactoryCanaryReservationDocument>> {
  const admission = testFactoryCanaryAdmissionFixture({
    taskId: "73000000-0000-4000-8000-000000000007",
    deduplicationKey: testDigest("7"),
    maximumTasks: 2,
    canaryBudget: fixture.admission.canary.cohort.value.budget,
    schedulePolicyDigest: fixture.run.value.schedulePolicyDigest,
    authorityExpiresAt: "2026-09-01T12:00:00.000Z",
    canaryMaximumLifetimeSeconds: 172_800
  });
  if (admission.canary.cohort.digest !== fixture.admission.canary.cohort.digest) {
    throw new Error("Additional quota task changed its shared canary cohort.");
  }
  const preparations = new SqliteFactoryPreparationRepository(fixture.databasePath, { documents });
  const reservations = new SqliteFactoryCanaryReservationRepository(fixture.databasePath, {
    documents
  });
  try {
    await preparations.register(admission.request, admission.authority, admission.registered);
    const reservation = testFactoryCanaryReservationDocument(admission, {
      reservationId: "74000000-0000-4000-8000-000000000007"
    });
    await reservations.reserve(reservation);
    return reservation;
  } finally {
    reservations.close();
    preparations.close();
  }
}

function quotaDocument(
  fixture: QuotaFixture,
  options: {
    readonly reservationId?: string;
    readonly repositoryId?: string;
    readonly budget?: FactoryBudget;
    readonly canary?: ReturnType<typeof testFactoryCanaryReservationDocument>;
    readonly correlationId?: string;
    readonly windowStart?: string;
    readonly windowEnd?: string;
    readonly reservedAt?: string;
  } = {}
) {
  const canary = options.canary ?? fixture.canary;
  const repositoryId = options.repositoryId ?? canary.value.repository.id;
  const repositoryQuota = fixture.policy.value.repositories.find(
    (candidate) => candidate.repositoryId === repositoryId
  );
  if (repositoryQuota === undefined) throw new Error("Test policy lost its quota profile.");
  return documents.dailyQuotaReservation({
    schemaVersion: "agentlab.daily-quota-reservation.v1",
    reservationId: options.reservationId ?? "80000000-0000-4000-8000-000000000008",
    quotaPolicyDigest: fixture.policy.digest,
    quotaPolicy: fixture.policy.value,
    organizationId: fixture.policy.value.organizationId,
    repositoryId,
    taskId: canary.value.taskId,
    scheduleRunId: fixture.run.value.runId,
    scheduleRunDigest: fixture.run.digest,
    canaryReservationDigest: canary.digest,
    windowStart: options.windowStart ?? "2026-08-31T00:00:00.000Z",
    windowEnd: options.windowEnd ?? "2026-09-01T00:00:00.000Z",
    repositoryQuota,
    organizationQuota: fixture.policy.value.organization,
    budget: options.budget ?? canary.value.budget,
    draftPullRequests: 1,
    reservedAt: options.reservedAt ?? "2026-08-31T12:05:00.000Z",
    correlationId: options.correlationId ?? "87000000-0000-4000-8000-000000000007"
  });
}

function aggregate(budget: FactoryBudget, factor: number): FactoryBudget {
  return {
    wallClockSeconds: budget.wallClockSeconds * factor,
    maxAgentTurns: budget.maxAgentTurns * factor,
    maxToolCalls: budget.maxToolCalls * factor,
    maxInputTokens: budget.maxInputTokens * factor,
    maxOutputTokens: budget.maxOutputTokens * factor,
    maxCostMicrousd: budget.maxCostMicrousd * factor,
    maxProcesses: budget.maxProcesses * factor,
    maxOutputBytes: budget.maxOutputBytes * factor,
    maxWorkers: budget.maxWorkers * factor,
    maxRepairAttempts: budget.maxRepairAttempts * factor,
    maxChangedFiles: budget.maxChangedFiles * factor,
    maxChangedLines: budget.maxChangedLines * factor
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
