import { DatabaseSync } from "node:sqlite";

import type { FactoryExecutionEvent, FactoryExecutionRun } from "@agentlab/contracts";

import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../../domain/factory-documents.js";
import {
  assertFactoryExecutionEvent,
  assertFactoryExecutionRegistration
} from "../../domain/factory-execution-integrity.js";
import type {
  FactoryExecutionRepository,
  FactoryExecutionSnapshot
} from "../../domain/factory-execution-repository.js";
import { NodeFactoryDocumentCodec } from "./canonical-factory-documents.js";
import { openSqliteDatabase, type SqliteDatabaseOptions } from "./sqlite-database.js";

interface ExecutionRunRow {
  readonly run_id: unknown;
  readonly run_digest: unknown;
  readonly task_id: unknown;
  readonly contract_digest: unknown;
  readonly repository_id: unknown;
  readonly base_revision: unknown;
  readonly maximum_attempts: unknown;
  readonly created_at: unknown;
  readonly correlation_id: unknown;
  readonly run_json: unknown;
}

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

const RUN_COLUMNS = `
  run_id, run_digest, task_id, contract_digest, repository_id, base_revision,
  maximum_attempts, created_at, correlation_id, run_json
`;

const EVENT_COLUMNS = `
  event_id, run_id, run_digest, task_id, contract_digest, sequence, event_digest,
  previous_event_digest, kind, from_state, to_state, attempt, workspace_id,
  operation_id, operation_kind, execution_role, gate_id, request_digest, result,
  record_digest, disposition, task_state, occurred_at, reason_code, correlation_id,
  event_json
`;

const maximumExecutionEvents = 10_000;

export interface SqliteFactoryExecutionRepositoryOptions extends SqliteDatabaseOptions {
  readonly documents?: FactoryDocumentCodec;
}

/** SQLite-backed append-only execution journal with materialized integrity columns. */
export class SqliteFactoryExecutionRepository implements FactoryExecutionRepository {
  readonly #database: DatabaseSync;
  readonly #documents: FactoryDocumentCodec;

  public constructor(databasePath: string, options: SqliteFactoryExecutionRepositoryOptions = {}) {
    this.#database = openSqliteDatabase(databasePath, options);
    this.#documents = options.documents ?? new NodeFactoryDocumentCodec();
  }

  public register(
    runClaim: CanonicalFactoryDocument<FactoryExecutionRun>,
    initialEventClaim: CanonicalFactoryDocument<FactoryExecutionEvent>
  ): Promise<FactoryExecutionSnapshot> {
    const run = this.#verifiedRun(runClaim);
    const initialEvent = this.#verifiedEvent(initialEventClaim);
    assertFactoryExecutionRegistration(run, initialEvent);
    const snapshot = this.#inTransaction(() => {
      this.#database
        .prepare(
          `INSERT INTO factory_execution_runs (
            run_id, run_digest, task_id, contract_digest, repository_id, base_revision,
            maximum_attempts, created_at, correlation_id, run_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          run.value.runId,
          run.digest,
          run.value.taskId,
          run.value.contractDigest,
          run.value.repository.id,
          run.value.repository.baseRevision,
          run.value.maximumAttempts,
          run.value.createdAt,
          run.value.correlationId,
          run.json
        );
      this.#insertEvent(initialEvent);
      return snapshotFrom(run, initialEvent);
    });
    return Promise.resolve(snapshot);
  }

  public findByTaskId(taskId: string): Promise<FactoryExecutionSnapshot | null> {
    const run = this.#findRun(taskId);
    if (run === null) return Promise.resolve(null);
    return Promise.resolve(this.#snapshot(run));
  }

  public listRecoverable(limit: number): Promise<readonly FactoryExecutionSnapshot[]> {
    assertListLimit(limit);
    const rows = this.#database
      .prepare(
        `SELECT ${RUN_COLUMNS}
         FROM factory_execution_runs AS run
         WHERE (
           SELECT event.to_state
           FROM factory_execution_events AS event
           WHERE event.run_id = run.run_id
           ORDER BY event.sequence DESC
           LIMIT 1
         ) IN ('ready', 'workspace-active', 'operation-active')
         ORDER BY run.created_at, run.task_id
         LIMIT ?`
      )
      .all(limit) as unknown as ExecutionRunRow[];
    return Promise.resolve(rows.map((row) => this.#snapshot(this.#runFromRow(row))));
  }

  public listEvents(taskId: string): Promise<readonly FactoryExecutionEvent[]> {
    const run = this.#findRun(taskId);
    if (run === null) return Promise.resolve([]);
    return Promise.resolve(this.#readEventDocuments(run).map(({ value }) => value));
  }

  public append(
    eventClaim: CanonicalFactoryDocument<FactoryExecutionEvent>
  ): Promise<FactoryExecutionSnapshot | null> {
    const event = this.#verifiedEvent(eventClaim);
    const result = this.#inTransaction(() => {
      const run = this.#findRun(event.value.taskId);
      if (
        run?.value.runId !== event.value.runId ||
        run.digest !== event.value.runDigest ||
        run.value.contractDigest !== event.value.contractDigest
      ) {
        return null;
      }
      const history = this.#readEventDocuments(run);
      const previous = history.at(-1);
      if (
        previous === undefined ||
        event.value.sequence !== previous.value.sequence + 1 ||
        event.value.previousEventDigest !== previous.digest ||
        event.value.from !== previous.value.to
      ) {
        return null;
      }
      assertFactoryExecutionEvent(run, event, history);
      this.#insertEvent(event);
      return snapshotFrom(run, event);
    });
    return Promise.resolve(result);
  }

  public close(): void {
    this.#database.close();
  }

  #findRun(taskId: string): CanonicalFactoryDocument<FactoryExecutionRun> | null {
    const row = this.#database
      .prepare(`SELECT ${RUN_COLUMNS} FROM factory_execution_runs WHERE task_id = ?`)
      .get(taskId) as ExecutionRunRow | undefined;
    return row === undefined ? null : this.#runFromRow(row);
  }

  #runFromRow(row: ExecutionRunRow): CanonicalFactoryDocument<FactoryExecutionRun> {
    const run = this.#documents.executionRun(parseJson(row.run_json, "factory execution run"));
    if (
      row.run_id !== run.value.runId ||
      row.run_digest !== run.digest ||
      row.task_id !== run.value.taskId ||
      row.contract_digest !== run.value.contractDigest ||
      row.repository_id !== run.value.repository.id ||
      row.base_revision !== run.value.repository.baseRevision ||
      row.maximum_attempts !== run.value.maximumAttempts ||
      row.created_at !== run.value.createdAt ||
      row.correlation_id !== run.value.correlationId ||
      row.run_json !== run.json
    ) {
      throw new Error(`Stored factory execution ${run.value.runId} failed integrity validation.`);
    }
    return run;
  }

  #snapshot(run: CanonicalFactoryDocument<FactoryExecutionRun>): FactoryExecutionSnapshot {
    const last = this.#readEventDocuments(run).at(-1);
    if (last === undefined) throw new Error(`Factory execution ${run.value.runId} has no event.`);
    return snapshotFrom(run, last);
  }

  #readEventDocuments(
    run: CanonicalFactoryDocument<FactoryExecutionRun>
  ): readonly CanonicalFactoryDocument<FactoryExecutionEvent>[] {
    const rows = this.#database
      .prepare(
        `SELECT ${EVENT_COLUMNS}
         FROM factory_execution_events
         WHERE run_id = ?
         ORDER BY sequence
         LIMIT ?`
      )
      .all(run.value.runId, maximumExecutionEvents + 1) as unknown as ExecutionEventRow[];
    if (rows.length > maximumExecutionEvents) {
      throw new Error(`Factory execution ${run.value.runId} exceeds the event limit.`);
    }
    const events: CanonicalFactoryDocument<FactoryExecutionEvent>[] = [];
    for (const row of rows) {
      const event = this.#eventFromRow(row);
      assertFactoryExecutionEvent(run, event, events);
      events.push(event);
    }
    return events;
  }

  #eventFromRow(row: ExecutionEventRow): CanonicalFactoryDocument<FactoryExecutionEvent> {
    const event = this.#documents.executionEvent(
      parseJson(row.event_json, "factory execution event")
    );
    const fields = materializedFields(event.value);
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
      throw new Error(`Stored execution event ${event.value.eventId} failed integrity validation.`);
    }
    return event;
  }

  #insertEvent(event: CanonicalFactoryDocument<FactoryExecutionEvent>): void {
    const fields = materializedFields(event.value);
    this.#database
      .prepare(
        `INSERT INTO factory_execution_events (
          event_id, run_id, run_digest, task_id, contract_digest, sequence, event_digest,
          previous_event_digest, kind, from_state, to_state, attempt, workspace_id,
          operation_id, operation_kind, execution_role, gate_id, request_digest, result,
          record_digest, disposition, task_state, occurred_at, reason_code, correlation_id,
          event_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.value.eventId,
        event.value.runId,
        event.value.runDigest,
        event.value.taskId,
        event.value.contractDigest,
        event.value.sequence,
        event.digest,
        event.value.previousEventDigest,
        event.value.kind,
        event.value.from,
        event.value.to,
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
        event.value.occurredAt,
        event.value.reasonCode,
        event.value.correlationId,
        event.json
      );
  }

  #verifiedRun(
    claimed: CanonicalFactoryDocument<FactoryExecutionRun>
  ): CanonicalFactoryDocument<FactoryExecutionRun> {
    const actual = this.#documents.executionRun(claimed.value);
    assertDocumentClaim(claimed, actual, "execution run");
    return actual;
  }

  #verifiedEvent(
    claimed: CanonicalFactoryDocument<FactoryExecutionEvent>
  ): CanonicalFactoryDocument<FactoryExecutionEvent> {
    const actual = this.#documents.executionEvent(claimed.value);
    assertDocumentClaim(claimed, actual, "execution event");
    return actual;
  }

  #inTransaction<Value>(operation: () => Value): Value {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error: unknown) {
      try {
        this.#database.exec("ROLLBACK");
      } catch (rollbackError: unknown) {
        throw new AggregateError(
          [error, rollbackError],
          "Factory execution transaction and rollback failed.",
          { cause: error }
        );
      }
      throw error;
    }
  }
}

function snapshotFrom(
  run: CanonicalFactoryDocument<FactoryExecutionRun>,
  lastEvent: CanonicalFactoryDocument<FactoryExecutionEvent>
): FactoryExecutionSnapshot {
  return {
    run: run.value,
    runDigest: run.digest,
    state: lastEvent.value.to,
    sequence: lastEvent.value.sequence,
    lastEvent: lastEvent.value,
    lastEventDigest: lastEvent.digest
  };
}

function materializedFields(event: FactoryExecutionEvent) {
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

function assertDocumentClaim<Value>(
  claimed: CanonicalFactoryDocument<Value>,
  actual: CanonicalFactoryDocument<Value>,
  label: string
): void {
  if (claimed.digest !== actual.digest || claimed.json !== actual.json) {
    throw new Error(`Claimed canonical ${label} does not match its value.`);
  }
}

function parseJson(value: unknown, label: string): unknown {
  if (typeof value !== "string") throw new Error(`Stored ${label} is not JSON text.`);
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error(`Stored ${label} is invalid JSON.`, { cause: error });
  }
}

function assertListLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Factory execution list limit must be an integer from 1 through 100.");
  }
}
