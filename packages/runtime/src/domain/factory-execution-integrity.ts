import type { FactoryExecutionEvent, FactoryExecutionRun } from "@agentlab/contracts";

import type { CanonicalFactoryDocument } from "./factory-documents.js";

export function assertFactoryExecutionRegistration(
  run: CanonicalFactoryDocument<FactoryExecutionRun>,
  event: CanonicalFactoryDocument<FactoryExecutionEvent>
): void {
  if (
    event.value.kind !== "registered" ||
    event.value.runId !== run.value.runId ||
    event.value.runDigest !== run.digest ||
    event.value.taskId !== run.value.taskId ||
    event.value.contractDigest !== run.value.contractDigest ||
    event.value.sequence !== 1 ||
    event.value.previousEventDigest !== null ||
    event.value.occurredAt !== run.value.createdAt ||
    event.value.correlationId !== run.value.correlationId
  ) {
    throw new Error("Initial execution event does not register its exact immutable run.");
  }
  assertFactoryExecutionEvent(run, event, []);
}

export function assertFactoryExecutionEvent(
  run: CanonicalFactoryDocument<FactoryExecutionRun>,
  event: CanonicalFactoryDocument<FactoryExecutionEvent>,
  history: readonly CanonicalFactoryDocument<FactoryExecutionEvent>[]
): void {
  if (
    event.value.runId !== run.value.runId ||
    event.value.runDigest !== run.digest ||
    event.value.taskId !== run.value.taskId ||
    event.value.contractDigest !== run.value.contractDigest ||
    !isPolicyEngineActor(event.value)
  ) {
    throw new Error("Execution event violates its run identity or control-plane authority.");
  }
  const previous = history.at(-1);
  if (
    event.value.sequence !== history.length + 1 ||
    event.value.previousEventDigest !== (previous?.digest ?? null) ||
    event.value.from !== (previous?.value.to ?? null)
  ) {
    throw new Error("Execution event does not extend the exact journal head.");
  }
  if (event.value.occurredAt < (previous?.value.occurredAt ?? run.value.createdAt)) {
    throw new Error("Execution event timestamp predates its predecessor.");
  }

  if (event.value.kind === "registered") {
    if (history.length !== 0 || event.value.occurredAt !== run.value.createdAt) {
      throw new Error("Execution registration must be the first event at run creation time.");
    }
    return;
  }
  if (event.value.kind === "attempt-started") {
    const starts = history.filter(({ value }) => value.kind === "attempt-started");
    const workspaceId = event.value.workspaceId;
    if (
      event.value.attempt !== starts.length + 1 ||
      event.value.attempt > run.value.maximumAttempts ||
      starts.some(({ value }) =>
        value.kind === "attempt-started" ? value.workspaceId === workspaceId : false
      )
    ) {
      throw new Error("Execution attempt is not the next unique authorized workspace.");
    }
    return;
  }

  const active = activeFactoryExecutionCoordinates(history);
  if (event.value.kind === "operation-started") {
    const currentOperationId = event.value.operationId;
    if (
      active?.operationId !== null ||
      active.attempt !== event.value.attempt ||
      active.workspaceId !== event.value.workspaceId ||
      history.some(({ value }) => operationId(value) === currentOperationId)
    ) {
      throw new Error("Execution operation does not belong to the exact active workspace.");
    }
    return;
  }
  if (event.value.kind === "operation-finished") {
    const started = previous?.value;
    if (started?.kind !== "operation-started" || !sameOperation(started, event.value)) {
      throw new Error("Execution operation result does not match the exact active process.");
    }
    return;
  }
  if (event.value.kind === "attempt-closed") {
    if (
      active?.operationId !== null ||
      active.attempt !== event.value.attempt ||
      active.workspaceId !== event.value.workspaceId
    ) {
      throw new Error("Execution attempt closure does not match the exact active workspace.");
    }
    return;
  }
  if (event.value.kind === "execution-abandoned") {
    if (
      event.value.attempt !== (active?.attempt ?? null) ||
      event.value.workspaceId !== (active?.workspaceId ?? null) ||
      event.value.operationId !== (active?.operationId ?? null)
    ) {
      throw new Error("Execution abandonment does not identify the exact active resources.");
    }
  }
}

export interface ActiveFactoryExecutionCoordinates {
  readonly attempt: number;
  readonly workspaceId: string;
  readonly operationId: string | null;
}

export function activeFactoryExecutionCoordinates(
  history: readonly CanonicalFactoryDocument<FactoryExecutionEvent>[]
): ActiveFactoryExecutionCoordinates | null {
  const last = history.at(-1)?.value;
  if (last?.to !== "workspace-active" && last?.to !== "operation-active") return null;
  const attempt = [...history]
    .reverse()
    .find(({ value }) => value.kind === "attempt-started")?.value;
  if (attempt?.kind !== "attempt-started") {
    throw new Error("Active execution journal has no workspace coordinates.");
  }
  const operation =
    last.to === "operation-active"
      ? [...history].reverse().find(({ value }) => value.kind === "operation-started")?.value
      : null;
  if (last.to === "operation-active" && operation?.kind !== "operation-started") {
    throw new Error("Active execution journal has no process coordinates.");
  }
  return {
    attempt: attempt.attempt,
    workspaceId: attempt.workspaceId,
    operationId: operation?.kind === "operation-started" ? operation.operationId : null
  };
}

function operationId(event: FactoryExecutionEvent): string | null {
  return event.kind === "operation-started" || event.kind === "operation-finished"
    ? event.operationId
    : event.kind === "execution-abandoned"
      ? event.operationId
      : null;
}

function sameOperation(
  started: Extract<FactoryExecutionEvent, { readonly kind: "operation-started" }>,
  finished: Extract<FactoryExecutionEvent, { readonly kind: "operation-finished" }>
): boolean {
  return (
    started.attempt === finished.attempt &&
    started.workspaceId === finished.workspaceId &&
    started.operationId === finished.operationId &&
    started.operationKind === finished.operationKind &&
    started.role === finished.role &&
    started.gateId === finished.gateId &&
    started.requestDigest === finished.requestDigest
  );
}

function isPolicyEngineActor(event: FactoryExecutionEvent): boolean {
  return (
    event.actor.kind === "control-plane" &&
    event.actor.role === "policy-engine" &&
    event.actor.sessionId === null
  );
}
