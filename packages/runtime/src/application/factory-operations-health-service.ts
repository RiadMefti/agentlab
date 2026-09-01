import {
  factoryIdentifierSchema,
  factoryTimestampSchema,
  type FactoryBudget,
  type FactoryDailyQuotaPolicy,
  type FactoryDailyQuotaReservation,
  type FactoryOperationsHealthPolicy,
  type FactoryOperationsHealthReasonCode,
  type FactoryOperationsHealthReport
} from "@agentlab/contracts";

import { factoryDailyQuotaWindow } from "../domain/factory-daily-quota-integrity.js";
import type { FactoryDocumentCodec } from "../domain/factory-documents.js";
import type { CanonicalFactoryDocument } from "../domain/factory-documents.js";
import type {
  FactoryOperationsHealthObservation,
  FactoryOperationsHealthSource
} from "../domain/factory-operations-health-source.js";
import { isTerminalFactoryTaskState } from "../domain/factory-task-state.js";
import {
  factoryTimestampAddSeconds,
  factoryTimestampDifferenceSeconds,
  factoryTimestampSubtractSeconds
} from "../domain/factory-timestamp.js";

export interface FactoryOperationsHealthServiceDependencies {
  readonly observerId: string;
  readonly healthPolicy: CanonicalFactoryDocument<FactoryOperationsHealthPolicy>;
  readonly dailyQuotaPolicy: CanonicalFactoryDocument<FactoryDailyQuotaPolicy>;
  readonly source: Pick<FactoryOperationsHealthSource, "observe">;
  readonly documents: Pick<
    FactoryDocumentCodec,
    "dailyQuotaPolicy" | "operationsHealthPolicy" | "operationsHealthReport"
  >;
  readonly now: () => string;
  readonly createId: () => string;
}

/** Builds a deterministic, credentialless health projection without mutating factory authority. */
export class FactoryOperationsHealthService {
  readonly #observerId: string;

  public constructor(private readonly dependencies: FactoryOperationsHealthServiceDependencies) {
    this.#observerId = factoryIdentifierSchema.parse(dependencies.observerId);
  }

  public async inspect(): Promise<CanonicalFactoryDocument<FactoryOperationsHealthReport>> {
    const observedAt = factoryTimestampSchema.parse(this.dependencies.now());
    const policy = this.dependencies.documents.operationsHealthPolicy(
      this.dependencies.healthPolicy.value
    );
    if (policy.digest !== this.dependencies.healthPolicy.digest) {
      throw new Error("Factory operations health policy changed after configuration.");
    }
    const dailyQuotaPolicy = this.dependencies.documents.dailyQuotaPolicy(
      this.dependencies.dailyQuotaPolicy.value
    );
    if (dailyQuotaPolicy.digest !== this.dependencies.dailyQuotaPolicy.digest) {
      throw new Error("Factory daily quota policy changed after health configuration.");
    }
    const lookbackStartedAt = factoryTimestampSubtractSeconds(
      observedAt,
      policy.value.lookbackSeconds
    );
    const quotaWindow = factoryDailyQuotaWindow(observedAt);
    const observation = await this.dependencies.source.observe({
      lookbackStartedAt,
      observedAt,
      quotaWindowStart: quotaWindow.windowStart,
      organizationId: dailyQuotaPolicy.value.organizationId,
      repositoryIds: dailyQuotaPolicy.value.repositories.map(({ repositoryId }) => repositoryId),
      maximumRecordsPerSection: policy.value.maximumRecordsPerSection
    });
    assertUniqueObservation(observation);
    assertObservationNotFromFuture(observation, observedAt);

    const reasons = new Set<FactoryOperationsHealthReasonCode>();
    if (observation.truncatedSections.length > 0) reasons.add("observation-truncated");
    const schedules = scheduleSummary(
      observation,
      observedAt,
      policy.value.maximumScheduleOverrunSeconds,
      reasons
    );
    const tasks = taskSummary(
      observation,
      observedAt,
      lookbackStartedAt,
      policy.value.maximumInFlightSilenceSeconds,
      reasons
    );
    const dailyQuota = dailyQuotaSummary(
      observation.dailyQuotaReservations,
      dailyQuotaPolicy,
      quotaWindow,
      policy.value.quotaWarningBasisPoints,
      reasons
    );
    const reasonCodes = [...reasons].sort();
    const status = healthStatus(reasonCodes);
    return this.dependencies.documents.operationsHealthReport({
      schemaVersion: "agentlab.operations-health-report.v1",
      reportId: this.dependencies.createId(),
      observerId: this.#observerId,
      healthPolicyDigest: policy.digest,
      dailyQuotaPolicyDigest: dailyQuotaPolicy.digest,
      observedAt,
      lookbackStartedAt,
      authority: {
        schedulerEnabled: observation.authority.scheduler,
        prBrokerEnabled: observation.authority.prBroker,
        autonomousDraftsEnabled: observation.authority.scheduler && observation.authority.prBroker
      },
      schedules,
      tasks,
      dailyQuota,
      status,
      incidentRecommended: status === "critical",
      reasonCodes
    });
  }
}

function scheduleSummary(
  observation: FactoryOperationsHealthObservation,
  observedAt: string,
  maximumOverrunSeconds: number,
  reasons: Set<FactoryOperationsHealthReasonCode>
): FactoryOperationsHealthReport["schedules"] {
  const open = observation.schedules.filter(({ state }) => state !== "completed");
  if (open.length > 1) reasons.add("multiple-open-schedule-runs");
  const overdue = open.filter(({ run }) => {
    const deadline = factoryTimestampAddSeconds(run.deadlineAt, maximumOverrunSeconds);
    return observedAt >= deadline;
  });
  if (overdue.length > 0) reasons.add("overdue-schedule-run");
  const ages = open.map(({ run }) => {
    const age = factoryTimestampDifferenceSeconds(run.createdAt, observedAt);
    if (!Number.isSafeInteger(age) || age < 0) {
      throw new Error("Factory operations health observed a future schedule run.");
    }
    return age;
  });
  return {
    observed: observation.schedules.length,
    completed: observation.schedules.filter(({ state }) => state === "completed").length,
    open: open.length,
    overdue: overdue.length,
    oldestOpenAgeSeconds: ages.length === 0 ? null : Math.max(...ages),
    latestScheduledFor:
      observation.schedules.length === 0
        ? null
        : (observation.schedules
            .map(({ run }) => run.scheduledFor)
            .sort()
            .at(-1) ?? null),
    openRunIds: open.map(({ run }) => run.runId).sort(),
    overdueRunIds: overdue.map(({ run }) => run.runId).sort()
  };
}

function taskSummary(
  observation: FactoryOperationsHealthObservation,
  observedAt: string,
  lookbackStartedAt: string,
  maximumSilenceSeconds: number,
  reasons: Set<FactoryOperationsHealthReasonCode>
): FactoryOperationsHealthReport["tasks"] {
  const tasks = observation.tasks;
  const active = tasks.filter(({ state }) => !isTerminalFactoryTaskState(state));
  const recent = tasks.filter(({ lastEvent }) => lastEvent.occurredAt >= lookbackStartedAt);
  const needsAttention = recent.filter(({ state }) => state === "needs-attention");
  const failed = recent.filter(({ state }) => state === "failed");
  const quarantined = recent.filter(({ state }) => state === "quarantined");
  if (needsAttention.length > 0) reasons.add("recent-needs-attention-task");
  if (failed.length > 0) reasons.add("recent-failed-task");
  if (quarantined.length > 0) reasons.add("recent-quarantined-task");
  const autonomousActive = active.filter(({ contract }) => contract.trigger === "scheduled");
  const overdue = autonomousActive.filter(({ contract }) => observedAt >= contract.expiresAt);
  const silenceBoundary = factoryTimestampSubtractSeconds(observedAt, maximumSilenceSeconds);
  const stalled = autonomousActive.filter(
    ({ lastEvent, contract }) =>
      observedAt < contract.expiresAt && lastEvent.occurredAt <= silenceBoundary
  );
  if (overdue.length > 0) reasons.add("overdue-autonomous-task");
  if (stalled.length > 0) reasons.add("stalled-autonomous-task");
  const attentionTaskIds = new Set([
    ...needsAttention.map(({ contract }) => contract.taskId),
    ...failed.map(({ contract }) => contract.taskId),
    ...quarantined.map(({ contract }) => contract.taskId),
    ...overdue.map(({ contract }) => contract.taskId),
    ...stalled.map(({ contract }) => contract.taskId)
  ]);
  const completed = recent.filter(({ state }) => state === "completed").length;
  const adverse = needsAttention.length + failed.length + quarantined.length;
  return {
    observed: tasks.length,
    active: active.length,
    completed,
    needsAttention: needsAttention.length,
    failed: failed.length,
    quarantined: quarantined.length,
    otherTerminal:
      recent.filter(({ state }) => isTerminalFactoryTaskState(state)).length - completed - adverse,
    overdue: overdue.length,
    stalled: stalled.length,
    attentionTaskIds: [...attentionTaskIds].sort()
  };
}

function dailyQuotaSummary(
  reservations: readonly FactoryDailyQuotaReservation[],
  policy: CanonicalFactoryDocument<FactoryDailyQuotaPolicy>,
  window: { readonly windowStart: string; readonly windowEnd: string },
  warningBasisPoints: number,
  reasons: Set<FactoryOperationsHealthReasonCode>
): FactoryOperationsHealthReport["dailyQuota"] {
  for (const reservation of reservations) {
    const embeddedPolicy = new Set([reservation.quotaPolicyDigest, policy.digest]);
    if (
      embeddedPolicy.size !== 1 ||
      reservation.organizationId !== policy.value.organizationId ||
      reservation.windowStart !== window.windowStart ||
      reservation.windowEnd !== window.windowEnd
    ) {
      throw new Error("Factory operations health observed daily quota policy drift.");
    }
  }
  const organizationResult = quotaUsage(reservations, policy.value.organization);
  const repositoryResults = policy.value.repositories.map((ceiling) => {
    const result = quotaUsage(
      reservations.filter(({ repositoryId }) => repositoryId === ceiling.repositoryId),
      ceiling
    );
    return { repositoryId: ceiling.repositoryId, result };
  });
  const violated =
    organizationResult.violated || repositoryResults.some(({ result }) => result.violated);
  const warning =
    organizationResult.maximumUtilizationBasisPoints >= warningBasisPoints ||
    repositoryResults.some(
      ({ result }) => result.maximumUtilizationBasisPoints >= warningBasisPoints
    );
  if (violated) reasons.add("daily-quota-capacity-violated");
  else if (warning) reasons.add("daily-quota-warning");
  return {
    organizationId: policy.value.organizationId,
    windowStart: window.windowStart,
    windowEnd: window.windowEnd,
    organization: organizationResult.usage,
    repositories: repositoryResults.map(({ repositoryId, result }) => ({
      repositoryId,
      ...result.usage
    }))
  };
}

type QuotaCeiling = FactoryDailyQuotaPolicy["organization"];

function quotaUsage(
  reservations: readonly FactoryDailyQuotaReservation[],
  ceiling: QuotaCeiling
): {
  readonly usage: FactoryOperationsHealthReport["dailyQuota"]["organization"];
  readonly maximumUtilizationBasisPoints: number;
  readonly violated: boolean;
} {
  const tasksReserved = reservations.length;
  const draftPullRequestsReserved = sum(
    reservations.map(({ draftPullRequests }) => draftPullRequests)
  );
  const budgetTotals = Object.fromEntries(
    budgetKeys.map((key) => [key, sum(reservations.map(({ budget }) => budget[key]))])
  ) as Record<keyof FactoryBudget, number>;
  const taskUtilizationBasisPoints = utilization(tasksReserved, ceiling.maximumTasksPerDay);
  const draftPullRequestUtilizationBasisPoints = utilization(
    draftPullRequestsReserved,
    ceiling.maximumDraftPullRequestsPerDay
  );
  const budgetUtilizations = budgetKeys.map((key) =>
    utilization(budgetTotals[key], ceiling.budget[key])
  );
  const maximumBudgetUtilizationBasisPoints = Math.max(0, ...budgetUtilizations);
  const maximumUtilizationBasisPoints = Math.max(
    taskUtilizationBasisPoints,
    draftPullRequestUtilizationBasisPoints,
    maximumBudgetUtilizationBasisPoints
  );
  return {
    usage: {
      tasksReserved,
      draftPullRequestsReserved,
      costMicrousdReserved: budgetTotals.maxCostMicrousd,
      taskUtilizationBasisPoints,
      draftPullRequestUtilizationBasisPoints,
      maximumBudgetUtilizationBasisPoints
    },
    maximumUtilizationBasisPoints,
    violated: maximumUtilizationBasisPoints > 10_000
  };
}

function utilization(used: number, ceiling: number): number {
  if (ceiling === 0) return used === 0 ? 0 : 10_001;
  const result = Math.floor((used * 10_000) / ceiling);
  if (!Number.isSafeInteger(result)) throw new Error("Factory quota utilization overflowed.");
  return result;
}

function sum(values: readonly number[]): number {
  const result = values.reduce((total, value) => total + value, 0);
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error("Factory operations health aggregate overflowed.");
  }
  return result;
}

function healthStatus(
  reasonCodes: readonly FactoryOperationsHealthReasonCode[]
): FactoryOperationsHealthReport["status"] {
  if (reasonCodes.some((reason) => criticalReasons.has(reason))) return "critical";
  return reasonCodes.length === 0 ? "healthy" : "degraded";
}

function assertUniqueObservation(observation: FactoryOperationsHealthObservation): void {
  assertUnique(
    observation.schedules.map(({ run }) => run.runId),
    "schedule runs"
  );
  assertUnique(
    observation.tasks.map(({ contract }) => contract.taskId),
    "tasks"
  );
  assertUnique(
    observation.dailyQuotaReservations.map(({ taskId }) => taskId),
    "daily quota tasks"
  );
  assertUnique(observation.truncatedSections, "truncated sections");
}

function assertObservationNotFromFuture(
  observation: FactoryOperationsHealthObservation,
  observedAt: string
): void {
  if (
    observation.schedules.some(
      ({ run, lastEvent }) => run.createdAt > observedAt || lastEvent.occurredAt > observedAt
    ) ||
    observation.tasks.some(
      ({ contract, lastEvent }) =>
        contract.createdAt > observedAt || lastEvent.occurredAt > observedAt
    ) ||
    observation.dailyQuotaReservations.some(({ reservedAt }) => reservedAt > observedAt)
  ) {
    throw new Error("Factory operations health cannot consume future ledger evidence.");
  }
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`Factory operations health observed duplicate ${label}.`);
  }
}

const budgetKeys = [
  "wallClockSeconds",
  "maxAgentTurns",
  "maxToolCalls",
  "maxInputTokens",
  "maxOutputTokens",
  "maxCostMicrousd",
  "maxProcesses",
  "maxOutputBytes",
  "maxWorkers",
  "maxRepairAttempts",
  "maxChangedFiles",
  "maxChangedLines"
] as const satisfies readonly (keyof FactoryBudget)[];

const criticalReasons = new Set<FactoryOperationsHealthReasonCode>([
  "observation-truncated",
  "multiple-open-schedule-runs",
  "overdue-schedule-run",
  "overdue-autonomous-task",
  "stalled-autonomous-task",
  "recent-quarantined-task",
  "daily-quota-capacity-violated"
]);
