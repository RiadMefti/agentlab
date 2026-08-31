import type {
  FactoryBudget,
  FactoryBudgetUsage,
  FactoryScheduleEvent,
  FactoryScheduleRun
} from "@agentlab/contracts";

import type { CanonicalFactoryDocument, FactoryDocumentCodec } from "./factory-documents.js";
import { factoryTimestampAddSeconds } from "./factory-timestamp.js";

export function assertFactoryScheduleRun(
  run: CanonicalFactoryDocument<FactoryScheduleRun>,
  documents: Pick<FactoryDocumentCodec, "schedulePolicy">
): void {
  const policy = documents.schedulePolicy(run.value.schedulePolicy);
  if (policy.digest !== run.value.schedulePolicyDigest) {
    throw new Error("Factory schedule run does not match its policy digest.");
  }
  const expectedSlotSuffix = `T${run.value.schedulePolicy.cadence.at}:00.000Z`;
  const expectedDeadline = factoryTimestampAddSeconds(
    run.value.scheduledFor,
    run.value.schedulePolicy.cadence.startDeadlineSeconds
  );
  if (
    !run.value.scheduledFor.endsWith(expectedSlotSuffix) ||
    run.value.deadlineAt !== expectedDeadline
  ) {
    throw new Error("Factory schedule run does not match its exact daily UTC slot.");
  }
}

export function assertFactoryScheduleRegistration(
  run: CanonicalFactoryDocument<FactoryScheduleRun>,
  event: CanonicalFactoryDocument<FactoryScheduleEvent>
): void {
  if (
    event.value.kind !== "registered" ||
    event.value.runId !== run.value.runId ||
    event.value.runDigest !== run.digest ||
    event.value.sequence !== 1 ||
    event.value.previousEventDigest !== null ||
    event.value.occurredAt !== run.value.createdAt ||
    event.value.correlationId !== run.value.correlationId
  ) {
    throw new Error("Factory schedule registration does not match its immutable run.");
  }
}

export function assertFactoryScheduleEvent(
  run: CanonicalFactoryDocument<FactoryScheduleRun>,
  event: CanonicalFactoryDocument<FactoryScheduleEvent>,
  history: readonly CanonicalFactoryDocument<FactoryScheduleEvent>[]
): void {
  if (event.value.kind === "registered") {
    throw new Error("Factory schedule registration can only be the initial event.");
  }
  const previous = history.at(-1);
  if (
    previous === undefined ||
    event.value.runId !== run.value.runId ||
    event.value.runDigest !== run.digest ||
    event.value.correlationId !== run.value.correlationId ||
    event.value.sequence !== previous.value.sequence + 1 ||
    event.value.previousEventDigest !== previous.digest ||
    event.value.from !== previous.value.to ||
    event.value.occurredAt < previous.value.occurredAt
  ) {
    throw new Error("Factory schedule event does not extend its exact run chain.");
  }
  const selectedTaskIds = new Set(
    history.flatMap(({ value }) =>
      value.kind === "task-claimed" || value.kind === "task-skipped" ? [value.taskId] : []
    )
  );
  if (
    (event.value.kind === "task-claimed" || event.value.kind === "task-skipped") &&
    selectedTaskIds.has(event.value.taskId)
  ) {
    throw new Error("Factory schedule run cannot select the same task twice.");
  }
  if (event.value.kind === "task-finished") {
    const claim = previous.value;
    if (
      claim.kind !== "task-claimed" ||
      claim.taskId !== event.value.taskId ||
      claim.taskCorrelationId !== event.value.taskCorrelationId
    ) {
      throw new Error("Factory schedule task outcome does not match its active claim.");
    }
  }
  if (event.value.kind === "completed") {
    assertCompletion(event.value, history, run.value.schedulePolicy.tickBudget);
  }
}

function assertCompletion(
  event: Extract<FactoryScheduleEvent, { readonly kind: "completed" }>,
  history: readonly CanonicalFactoryDocument<FactoryScheduleEvent>[],
  budget: FactoryBudget
): void {
  const claims = history.filter(({ value }) => value.kind === "task-claimed");
  const finished = history.filter(({ value }) => value.kind === "task-finished");
  const skipped = history.filter(({ value }) => value.kind === "task-skipped");
  const usage = claims.reduce<FactoryBudgetUsage>((total, claim) => {
    if (claim.value.kind !== "task-claimed") return total;
    return addReservation(total, claim.value.reservation);
  }, emptyReservedUsage());
  if (
    event.tasksClaimed !== claims.length ||
    event.tasksFinished !== finished.length ||
    event.tasksSkipped !== skipped.length ||
    !sameUsage(event.reservedUsage, usage) ||
    exceedsBudget(usage, budget)
  ) {
    throw new Error("Factory schedule completion does not match its recorded quota usage.");
  }
}

function sameUsage(left: FactoryBudgetUsage, right: FactoryBudgetUsage): boolean {
  return (
    left.wallClockSeconds === right.wallClockSeconds &&
    left.agentTurns === right.agentTurns &&
    left.toolCalls === right.toolCalls &&
    left.inputTokens === right.inputTokens &&
    left.outputTokens === right.outputTokens &&
    left.costMicrousd === right.costMicrousd &&
    left.processes === right.processes &&
    left.outputBytes === right.outputBytes &&
    left.workers === right.workers &&
    left.repairAttempts === right.repairAttempts &&
    left.changedFiles === right.changedFiles &&
    left.changedLines === right.changedLines
  );
}

export function emptyReservedUsage(): FactoryBudgetUsage {
  return {
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
  };
}

export function addReservation(
  total: FactoryBudgetUsage,
  reservation: FactoryBudget
): FactoryBudgetUsage {
  return {
    wallClockSeconds: safeAdd(total.wallClockSeconds, reservation.wallClockSeconds),
    agentTurns: safeAdd(total.agentTurns, reservation.maxAgentTurns),
    toolCalls: safeAdd(total.toolCalls, reservation.maxToolCalls),
    inputTokens: safeAdd(total.inputTokens, reservation.maxInputTokens),
    outputTokens: safeAdd(total.outputTokens, reservation.maxOutputTokens),
    costMicrousd: safeAdd(total.costMicrousd, reservation.maxCostMicrousd),
    processes: safeAdd(total.processes, reservation.maxProcesses),
    outputBytes: safeAdd(total.outputBytes, reservation.maxOutputBytes),
    workers: safeAdd(total.workers, reservation.maxWorkers),
    repairAttempts: safeAdd(total.repairAttempts, reservation.maxRepairAttempts),
    changedFiles: safeAdd(total.changedFiles, reservation.maxChangedFiles),
    changedLines: safeAdd(total.changedLines, reservation.maxChangedLines)
  };
}

export function exceedsBudget(usage: FactoryBudgetUsage, budget: FactoryBudget): boolean {
  return (
    usage.wallClockSeconds > budget.wallClockSeconds ||
    usage.agentTurns > budget.maxAgentTurns ||
    usage.toolCalls > budget.maxToolCalls ||
    usage.inputTokens > budget.maxInputTokens ||
    usage.outputTokens > budget.maxOutputTokens ||
    usage.costMicrousd > budget.maxCostMicrousd ||
    usage.processes > budget.maxProcesses ||
    usage.outputBytes > budget.maxOutputBytes ||
    usage.workers > budget.maxWorkers ||
    usage.repairAttempts > budget.maxRepairAttempts ||
    usage.changedFiles > budget.maxChangedFiles ||
    usage.changedLines > budget.maxChangedLines
  );
}

function safeAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new Error("Factory schedule quota total overflowed.");
  return result;
}
