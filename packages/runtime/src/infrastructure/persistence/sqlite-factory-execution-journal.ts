import type { DatabaseSync } from "node:sqlite";

import type { FactoryExecutionEvent } from "@agentlab/contracts";

import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../../domain/factory-documents.js";
import { assertFactoryExecutionEvent } from "../../domain/factory-execution-integrity.js";
import type {
  FactoryExecutionJournalRun,
  FactoryExecutionJournalSnapshot
} from "../../domain/factory-execution-repository.js";

interface ExecutionEventRow {
  readonly event_id: unknown;
  readonly run_id: unknown;
  readonly run_digest: unknown;
  readonly task_id: unknown;
  readonly contract_digest: unknown;
  readonly sequence: unknown;
  readonly event_digest: unknown;
  readonly previous_event_digest: unknown;
  readonly kind: unknown;
  readonly from_state: unknown;
  readonly to_state: unknown;
  readonly attempt: unknown;
  readonly workspace_id: unknown;
  readonly operation_id: unknown;
  readonly operation_kind: unknown;
  readonly execution_role: unknown;
  readonly gate_id: unknown;
  readonly request_digest: unknown;
  readonly result: unknown;
  readonly record_digest: unknown;
  readonly disposition: unknown;
  readonly task_state: unknown;
  readonly occurred_at: unknown;
  readonly reason_code: unknown;
  readonly correlation_id: unknown;
  readonly event_json: unknown;
}

export type FactoryExecutionEventTable =
  "factory_execution_events" | "factory_pull_request_repair_events";

export const factoryExecutionEventColumns = `
  event_id, run_id, run_digest, task_id, contract_digest, sequence, event_digest,
  previous_event_digest, kind, from_state, to_state, attempt, workspace_id,
  operation_id, operation_kind, execution_role, gate_id, request_digest, result,
  record_digest, disposition, task_state, occurred_at, reason_code, correlation_id,
  event_json
`;

const maximumExecutionEvents = 10_000;

export function readFactoryExecutionEvents<Run extends FactoryExecutionJournalRun>(input: {
  readonly database: DatabaseSync;
  readonly documents: FactoryDocumentCodec;
  readonly table: FactoryExecutionEventTable;
  readonly run: CanonicalFactoryDocument<Run>;
  readonly label: string;
}): readonly CanonicalFactoryDocument<FactoryExecutionEvent>[] {
  const rows = input.database
    .prepare(
      `SELECT ${factoryExecutionEventColumns}
       FROM ${input.table}
       WHERE run_id = ?
       ORDER BY sequence
       LIMIT ?`
    )
    .all(input.run.value.runId, maximumExecutionEvents + 1) as unknown as ExecutionEventRow[];
  if (rows.length > maximumExecutionEvents) {
    throw new Error(`${input.label} ${input.run.value.runId} exceeds the event limit.`);
  }
  const events: CanonicalFactoryDocument<FactoryExecutionEvent>[] = [];
  for (const row of rows) {
    const event = factoryExecutionEventFromRow(input.documents, row, input.label);
    assertFactoryExecutionEvent(input.run, event, events);
    events.push(event);
  }
  return events;
}

export function insertFactoryExecutionEvent(input: {
  readonly database: DatabaseSync;
  readonly table: FactoryExecutionEventTable;
  readonly event: CanonicalFactoryDocument<FactoryExecutionEvent>;
}): void {
  const fields = materializedFactoryExecutionEventFields(input.event.value);
  input.database
    .prepare(
      `INSERT INTO ${input.table} (
        event_id, run_id, run_digest, task_id, contract_digest, sequence, event_digest,
        previous_event_digest, kind, from_state, to_state, attempt, workspace_id,
        operation_id, operation_kind, execution_role, gate_id, request_digest, result,
        record_digest, disposition, task_state, occurred_at, reason_code, correlation_id,
        event_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.event.value.eventId,
      input.event.value.runId,
      input.event.value.runDigest,
      input.event.value.taskId,
      input.event.value.contractDigest,
      input.event.value.sequence,
      input.event.digest,
      input.event.value.previousEventDigest,
      input.event.value.kind,
      input.event.value.from,
      input.event.value.to,
      fields.attempt,
      fields.workspaceId,
      fields.operationId,
      fields.operationKind,
      fields.role,
      fields.gateId,
      fields.requestDigest,
      fields.result,
      fields.recordDigest,
      fields.disposition,
      fields.taskState,
      input.event.value.occurredAt,
      input.event.value.reasonCode,
      input.event.value.correlationId,
      input.event.json
    );
}

export function factoryExecutionSnapshotFrom<Run extends FactoryExecutionJournalRun>(
  run: CanonicalFactoryDocument<Run>,
  lastEvent: CanonicalFactoryDocument<FactoryExecutionEvent>
): FactoryExecutionJournalSnapshot<Run> {
  return {
    run: run.value,
    runDigest: run.digest,
    state: lastEvent.value.to,
    sequence: lastEvent.value.sequence,
    lastEvent: lastEvent.value,
    lastEventDigest: lastEvent.digest
  };
}

export function verifyFactoryExecutionEventClaim(
  documents: FactoryDocumentCodec,
  claimed: CanonicalFactoryDocument<FactoryExecutionEvent>
): CanonicalFactoryDocument<FactoryExecutionEvent> {
  const actual = documents.executionEvent(claimed.value);
  assertCanonicalFactoryDocumentClaim(claimed, actual, "execution event");
  return actual;
}

export function assertCanonicalFactoryDocumentClaim<Value>(
  claimed: CanonicalFactoryDocument<Value>,
  actual: CanonicalFactoryDocument<Value>,
  label: string
): void {
  if (claimed.digest !== actual.digest || claimed.json !== actual.json) {
    throw new Error(`Claimed canonical ${label} does not match its value.`);
  }
}

export function parseStoredFactoryJson(value: unknown, label: string): unknown {
  if (typeof value !== "string") throw new Error(`Stored ${label} is not JSON text.`);
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error(`Stored ${label} is invalid JSON.`, { cause: error });
  }
}

export function withImmediateFactoryTransaction<Value>(
  database: DatabaseSync,
  label: string,
  operation: () => Value
): Value {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error: unknown) {
    try {
      database.exec("ROLLBACK");
    } catch (rollbackError: unknown) {
      throw new AggregateError(
        [error, rollbackError],
        `${label} transaction and rollback failed.`,
        {
          cause: error
        }
      );
    }
    throw error;
  }
}

export function assertFactoryExecutionListLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Factory execution list limit must be an integer from 1 through 100.");
  }
}

function factoryExecutionEventFromRow(
  documents: FactoryDocumentCodec,
  row: ExecutionEventRow,
  label: string
): CanonicalFactoryDocument<FactoryExecutionEvent> {
  const event = documents.executionEvent(parseStoredFactoryJson(row.event_json, `${label} event`));
  const fields = materializedFactoryExecutionEventFields(event.value);
  if (
    row.event_id !== event.value.eventId ||
    row.run_id !== event.value.runId ||
    row.run_digest !== event.value.runDigest ||
    row.task_id !== event.value.taskId ||
    row.contract_digest !== event.value.contractDigest ||
    row.sequence !== event.value.sequence ||
    row.event_digest !== event.digest ||
    row.previous_event_digest !== event.value.previousEventDigest ||
    row.kind !== event.value.kind ||
    row.from_state !== event.value.from ||
    row.to_state !== event.value.to ||
    row.attempt !== fields.attempt ||
    row.workspace_id !== fields.workspaceId ||
    row.operation_id !== fields.operationId ||
    row.operation_kind !== fields.operationKind ||
    row.execution_role !== fields.role ||
    row.gate_id !== fields.gateId ||
    row.request_digest !== fields.requestDigest ||
    row.result !== fields.result ||
    row.record_digest !== fields.recordDigest ||
    row.disposition !== fields.disposition ||
    row.task_state !== fields.taskState ||
    row.occurred_at !== event.value.occurredAt ||
    row.reason_code !== event.value.reasonCode ||
    row.correlation_id !== event.value.correlationId ||
    row.event_json !== event.json
  ) {
    throw new Error(`Stored ${label} event ${event.value.eventId} failed integrity validation.`);
  }
  return event;
}

function materializedFactoryExecutionEventFields(event: FactoryExecutionEvent) {
  const attempt = "attempt" in event ? event.attempt : null;
  const workspaceId = "workspaceId" in event ? event.workspaceId : null;
  const operation =
    event.kind === "operation-started" || event.kind === "operation-finished" ? event : null;
  return {
    attempt,
    workspaceId,
    operationId:
      operation?.operationId ?? (event.kind === "execution-abandoned" ? event.operationId : null),
    operationKind: operation?.operationKind ?? null,
    role: operation?.role ?? null,
    gateId: operation?.gateId ?? null,
    requestDigest: operation?.requestDigest ?? null,
    result: event.kind === "operation-finished" ? event.result : null,
    recordDigest: event.kind === "operation-finished" ? event.recordDigest : null,
    disposition: event.kind === "attempt-closed" ? event.disposition : null,
    taskState: event.kind === "execution-finished" ? event.taskState : null
  };
}
