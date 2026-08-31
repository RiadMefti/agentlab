import { DatabaseSync } from "node:sqlite";

import type { FactoryScheduleEvent, FactoryScheduleRun } from "@agentlab/contracts";

import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../../domain/factory-documents.js";
import {
  assertFactoryScheduleEvent,
  assertFactoryScheduleRegistration,
  assertFactoryScheduleRun
} from "../../domain/factory-schedule-integrity.js";
import type {
  FactoryScheduleRepository,
  FactoryScheduleRunSnapshot
} from "../../domain/factory-schedule-repository.js";
import { NodeFactoryDocumentCodec } from "./canonical-factory-documents.js";
import { openSqliteDatabase, type SqliteDatabaseOptions } from "./sqlite-database.js";

interface ScheduleRunRow {
  readonly run_id: unknown;
  readonly run_digest: unknown;
  readonly schedule_policy_id: unknown;
  readonly schedule_policy_digest: unknown;
  readonly factory_policy_bundle_digest: unknown;
  readonly scheduled_for: unknown;
  readonly deadline_at: unknown;
  readonly created_at: unknown;
  readonly correlation_id: unknown;
  readonly run_json: unknown;
}

interface ScheduleEventRow {
  readonly event_id: unknown;
  readonly run_id: unknown;
  readonly run_digest: unknown;
  readonly sequence: unknown;
  readonly event_digest: unknown;
  readonly previous_event_digest: unknown;
  readonly kind: unknown;
  readonly from_state: unknown;
  readonly to_state: unknown;
  readonly task_id: unknown;
  readonly task_correlation_id: unknown;
  readonly occurred_at: unknown;
  readonly reason_code: unknown;
  readonly correlation_id: unknown;
  readonly event_json: unknown;
}

const RUN_COLUMNS = `
  run_id, run_digest, schedule_policy_id, schedule_policy_digest, factory_policy_bundle_digest,
  scheduled_for, deadline_at, created_at, correlation_id, run_json
`;

const EVENT_COLUMNS = `
  event_id, run_id, run_digest, sequence, event_digest, previous_event_digest,
  kind, from_state, to_state, task_id, task_correlation_id, occurred_at,
  reason_code, correlation_id, event_json
`;

const maximumScheduleEvents = 1_000;

export interface SqliteFactoryScheduleRepositoryOptions extends SqliteDatabaseOptions {
  readonly documents?: FactoryDocumentCodec;
}

/** SQLite-backed append-only journal for idempotent policy-pinned daily worker slots. */
export class SqliteFactoryScheduleRepository implements FactoryScheduleRepository {
  readonly #database: DatabaseSync;
  readonly #documents: FactoryDocumentCodec;

  public constructor(databasePath: string, options: SqliteFactoryScheduleRepositoryOptions = {}) {
    this.#database = openSqliteDatabase(databasePath, options);
    this.#documents = options.documents ?? new NodeFactoryDocumentCodec();
  }

  public register(
    runClaim: CanonicalFactoryDocument<FactoryScheduleRun>,
    initialEventClaim: CanonicalFactoryDocument<FactoryScheduleEvent>
  ): Promise<FactoryScheduleRunSnapshot> {
    const run = this.#verifiedRun(runClaim);
    assertFactoryScheduleRun(run, this.#documents);
    const initialEvent = this.#verifiedEvent(initialEventClaim);
    assertFactoryScheduleRegistration(run, initialEvent);
    const snapshot = this.#inTransaction(() => {
      this.#database
        .prepare(
          `INSERT INTO factory_schedule_runs (
            run_id, run_digest, schedule_policy_id, schedule_policy_digest,
            factory_policy_bundle_digest,
            scheduled_for, deadline_at, created_at, correlation_id, run_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          run.value.runId,
          run.digest,
          run.value.schedulePolicy.id,
          run.value.schedulePolicyDigest,
          run.value.factoryPolicyBundleDigest,
          run.value.scheduledFor,
          run.value.deadlineAt,
          run.value.createdAt,
          run.value.correlationId,
          run.json
        );
      this.#insertEvent(initialEvent);
      return snapshotFrom(run, [initialEvent]);
    });
    return Promise.resolve(snapshot);
  }

  public findById(runId: string): Promise<FactoryScheduleRunSnapshot | null> {
    const row = this.#database
      .prepare(`SELECT ${RUN_COLUMNS} FROM factory_schedule_runs WHERE run_id = ?`)
      .get(runId) as ScheduleRunRow | undefined;
    return Promise.resolve(row === undefined ? null : this.#snapshot(this.#runFromRow(row)));
  }

  public findBySlot(
    schedulePolicyId: string,
    scheduledFor: string
  ): Promise<FactoryScheduleRunSnapshot | null> {
    const row = this.#database
      .prepare(
        `SELECT ${RUN_COLUMNS}
         FROM factory_schedule_runs
         WHERE schedule_policy_id = ? AND scheduled_for = ?`
      )
      .get(schedulePolicyId, scheduledFor) as ScheduleRunRow | undefined;
    return Promise.resolve(row === undefined ? null : this.#snapshot(this.#runFromRow(row)));
  }

  public findOpen(): Promise<FactoryScheduleRunSnapshot | null> {
    const rows = this.#database
      .prepare(
        `SELECT ${RUN_COLUMNS}
         FROM factory_schedule_runs AS schedule_run
         WHERE COALESCE((
           SELECT event.to_state
           FROM factory_schedule_events AS event
           WHERE event.run_id = schedule_run.run_id
           ORDER BY event.sequence DESC LIMIT 1
         ), 'missing') <> 'completed'
         ORDER BY schedule_run.scheduled_for, schedule_run.run_id
         LIMIT 2`
      )
      .all() as unknown as ScheduleRunRow[];
    if (rows.length > 1) {
      throw new Error("Factory scheduler has multiple open runs; operator recovery is required.");
    }
    const row = rows[0];
    return Promise.resolve(row === undefined ? null : this.#snapshot(this.#runFromRow(row)));
  }

  public listEvents(runId: string): Promise<readonly FactoryScheduleEvent[]> {
    const run = this.#findRun(runId);
    if (run === null) return Promise.resolve([]);
    return Promise.resolve(this.#readEvents(run).map(({ value }) => value));
  }

  public append(
    eventClaim: CanonicalFactoryDocument<FactoryScheduleEvent>
  ): Promise<FactoryScheduleRunSnapshot | null> {
    const event = this.#verifiedEvent(eventClaim);
    const result = this.#inTransaction(() => {
      const run = this.#findRun(event.value.runId);
      if (run?.digest !== event.value.runDigest) return null;
      const history = this.#readEvents(run);
      assertFactoryScheduleEvent(run, event, history);
      this.#insertEvent(event);
      return snapshotFrom(run, [...history, event]);
    });
    return Promise.resolve(result);
  }

  public close(): void {
    this.#database.close();
  }

  #snapshot(run: CanonicalFactoryDocument<FactoryScheduleRun>): FactoryScheduleRunSnapshot {
    const events = this.#readEvents(run);
    return snapshotFrom(run, events);
  }

  #findRun(runId: string): CanonicalFactoryDocument<FactoryScheduleRun> | null {
    const row = this.#database
      .prepare(`SELECT ${RUN_COLUMNS} FROM factory_schedule_runs WHERE run_id = ?`)
      .get(runId) as ScheduleRunRow | undefined;
    return row === undefined ? null : this.#runFromRow(row);
  }

  #runFromRow(row: ScheduleRunRow): CanonicalFactoryDocument<FactoryScheduleRun> {
    const run = this.#documents.scheduleRun(parseJson(row.run_json, "factory schedule run"));
    if (
      row.run_id !== run.value.runId ||
      row.run_digest !== run.digest ||
      row.schedule_policy_id !== run.value.schedulePolicy.id ||
      row.schedule_policy_digest !== run.value.schedulePolicyDigest ||
      row.factory_policy_bundle_digest !== run.value.factoryPolicyBundleDigest ||
      row.scheduled_for !== run.value.scheduledFor ||
      row.deadline_at !== run.value.deadlineAt ||
      row.created_at !== run.value.createdAt ||
      row.correlation_id !== run.value.correlationId ||
      row.run_json !== run.json
    ) {
      throw new Error(
        `Stored factory schedule run ${run.value.runId} failed integrity validation.`
      );
    }
    assertFactoryScheduleRun(run, this.#documents);
    return run;
  }

  #readEvents(
    run: CanonicalFactoryDocument<FactoryScheduleRun>
  ): readonly CanonicalFactoryDocument<FactoryScheduleEvent>[] {
    const rows = this.#database
      .prepare(
        `SELECT ${EVENT_COLUMNS}
         FROM factory_schedule_events
         WHERE run_id = ?
         ORDER BY sequence
         LIMIT ?`
      )
      .all(run.value.runId, maximumScheduleEvents + 1) as unknown as ScheduleEventRow[];
    if (rows.length > maximumScheduleEvents) {
      throw new Error(`Factory schedule run ${run.value.runId} exceeds its event limit.`);
    }
    const events: CanonicalFactoryDocument<FactoryScheduleEvent>[] = [];
    for (const row of rows) {
      const event = this.#eventFromRow(row);
      if (events.length === 0) assertFactoryScheduleRegistration(run, event);
      else assertFactoryScheduleEvent(run, event, events);
      events.push(event);
    }
    if (events.length === 0) {
      throw new Error(`Factory schedule run ${run.value.runId} has no registration event.`);
    }
    return events;
  }

  #eventFromRow(row: ScheduleEventRow): CanonicalFactoryDocument<FactoryScheduleEvent> {
    const event = this.#documents.scheduleEvent(
      parseJson(row.event_json, "factory schedule event")
    );
    const taskId = taskIdentity(event.value).taskId;
    const taskCorrelationId = taskIdentity(event.value).taskCorrelationId;
    if (
      row.event_id !== event.value.eventId ||
      row.run_id !== event.value.runId ||
      row.run_digest !== event.value.runDigest ||
      row.sequence !== event.value.sequence ||
      row.event_digest !== event.digest ||
      row.previous_event_digest !== event.value.previousEventDigest ||
      row.kind !== event.value.kind ||
      row.from_state !== event.value.from ||
      row.to_state !== event.value.to ||
      row.task_id !== taskId ||
      row.task_correlation_id !== taskCorrelationId ||
      row.occurred_at !== event.value.occurredAt ||
      row.reason_code !== event.value.reasonCode ||
      row.correlation_id !== event.value.correlationId ||
      row.event_json !== event.json
    ) {
      throw new Error(
        `Stored factory schedule event ${event.value.eventId} failed integrity validation.`
      );
    }
    return event;
  }

  #insertEvent(event: CanonicalFactoryDocument<FactoryScheduleEvent>): void {
    const identity = taskIdentity(event.value);
    this.#database
      .prepare(
        `INSERT INTO factory_schedule_events (
          event_id, run_id, run_digest, sequence, event_digest, previous_event_digest,
          kind, from_state, to_state, task_id, task_correlation_id, occurred_at,
          reason_code, correlation_id, event_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.value.eventId,
        event.value.runId,
        event.value.runDigest,
        event.value.sequence,
        event.digest,
        event.value.previousEventDigest,
        event.value.kind,
        event.value.from,
        event.value.to,
        identity.taskId,
        identity.taskCorrelationId,
        event.value.occurredAt,
        event.value.reasonCode,
        event.value.correlationId,
        event.json
      );
  }

  #verifiedRun(
    claimed: CanonicalFactoryDocument<FactoryScheduleRun>
  ): CanonicalFactoryDocument<FactoryScheduleRun> {
    const actual = this.#documents.scheduleRun(claimed.value);
    if (actual.digest !== claimed.digest || actual.json !== claimed.json) {
      throw new Error("Claimed factory schedule run is not canonical.");
    }
    return actual;
  }

  #verifiedEvent(
    claimed: CanonicalFactoryDocument<FactoryScheduleEvent>
  ): CanonicalFactoryDocument<FactoryScheduleEvent> {
    const actual = this.#documents.scheduleEvent(claimed.value);
    if (actual.digest !== claimed.digest || actual.json !== claimed.json) {
      throw new Error("Claimed factory schedule event is not canonical.");
    }
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
      } catch {
        // Preserve the primary integrity or persistence error.
      }
      throw error;
    }
  }
}

function snapshotFrom(
  run: CanonicalFactoryDocument<FactoryScheduleRun>,
  events: readonly CanonicalFactoryDocument<FactoryScheduleEvent>[]
): FactoryScheduleRunSnapshot {
  const last = events.at(-1);
  if (last === undefined) throw new Error("Factory schedule snapshot requires an event.");
  return {
    run: run.value,
    runDigest: run.digest,
    state: last.value.to,
    sequence: last.value.sequence,
    lastEvent: last.value,
    lastEventDigest: last.digest,
    events: events.map(({ value }) => value)
  };
}

function taskIdentity(event: FactoryScheduleEvent): {
  readonly taskId: string | null;
  readonly taskCorrelationId: string | null;
} {
  if (event.kind === "task-claimed") {
    return { taskId: event.taskId, taskCorrelationId: event.taskCorrelationId };
  }
  if (event.kind === "task-finished") {
    return { taskId: event.taskId, taskCorrelationId: event.taskCorrelationId };
  }
  if (event.kind === "task-skipped") {
    return { taskId: event.taskId, taskCorrelationId: null };
  }
  return { taskId: null, taskCorrelationId: null };
}

function parseJson(value: unknown, label: string): unknown {
  if (typeof value !== "string") throw new Error(`Stored ${label} is not text.`);
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error(`Stored ${label} is not valid JSON.`, { cause: error });
  }
}
