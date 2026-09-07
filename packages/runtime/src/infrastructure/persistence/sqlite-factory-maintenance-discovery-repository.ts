import { DatabaseSync } from "node:sqlite";

import type {
  FactoryMaintenanceDiscoveryEvent,
  FactoryMaintenanceDiscoveryRun
} from "@agentlab/contracts";

import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../../domain/factory-documents.js";
import {
  assertFactoryMaintenanceDiscoveryEvent,
  assertFactoryMaintenanceDiscoveryRegistration,
  assertFactoryMaintenanceDiscoveryRun
} from "../../domain/factory-maintenance-discovery-integrity.js";
import type {
  FactoryMaintenanceDiscoveryRepository,
  FactoryMaintenanceDiscoverySnapshot
} from "../../domain/factory-maintenance-discovery-repository.js";
import { NodeFactoryDocumentCodec } from "./canonical-factory-documents.js";
import { openSqliteDatabase, type SqliteDatabaseOptions } from "./sqlite-database.js";

interface RunRow {
  readonly run_id: unknown;
  readonly run_digest: unknown;
  readonly discovery_policy_id: unknown;
  readonly discovery_policy_digest: unknown;
  readonly schedule_policy_digest: unknown;
  readonly factory_policy_bundle_digest: unknown;
  readonly preparation_grant_digest: unknown;
  readonly role_identity_policy_digest: unknown;
  readonly repository_id: unknown;
  readonly base_revision: unknown;
  readonly scheduled_for: unknown;
  readonly deadline_at: unknown;
  readonly created_at: unknown;
  readonly correlation_id: unknown;
  readonly run_json: unknown;
}

interface EventRow {
  readonly event_id: unknown;
  readonly run_id: unknown;
  readonly run_digest: unknown;
  readonly sequence: unknown;
  readonly event_digest: unknown;
  readonly previous_event_digest: unknown;
  readonly kind: unknown;
  readonly from_state: unknown;
  readonly to_state: unknown;
  readonly execution_id: unknown;
  readonly finding_key: unknown;
  readonly finding_digest: unknown;
  readonly task_id: unknown;
  readonly run_record_digest: unknown;
  readonly occurred_at: unknown;
  readonly reason_code: unknown;
  readonly correlation_id: unknown;
  readonly event_json: unknown;
}

const RUN_COLUMNS = `
  run_id, run_digest, discovery_policy_id, discovery_policy_digest, schedule_policy_digest,
  factory_policy_bundle_digest, preparation_grant_digest, role_identity_policy_digest,
  repository_id, base_revision, scheduled_for, deadline_at, created_at, correlation_id, run_json
`;

const EVENT_COLUMNS = `
  event_id, run_id, run_digest, sequence, event_digest, previous_event_digest, kind,
  from_state, to_state, execution_id, finding_key, finding_digest, task_id, run_record_digest,
  occurred_at, reason_code, correlation_id, event_json
`;

const maximumEvents = 1_000;

export interface SqliteFactoryMaintenanceDiscoveryRepositoryOptions extends SqliteDatabaseOptions {
  readonly documents?: FactoryDocumentCodec;
}

/** SQLite-backed append-only recovery journal for autonomous maintenance discovery. */
export class SqliteFactoryMaintenanceDiscoveryRepository implements FactoryMaintenanceDiscoveryRepository {
  readonly #database: DatabaseSync;
  readonly #documents: FactoryDocumentCodec;

  public constructor(
    databasePath: string,
    options: SqliteFactoryMaintenanceDiscoveryRepositoryOptions = {}
  ) {
    this.#database = openSqliteDatabase(databasePath, options);
    this.#documents = options.documents ?? new NodeFactoryDocumentCodec();
  }

  public register(
    runClaim: CanonicalFactoryDocument<FactoryMaintenanceDiscoveryRun>,
    eventClaim: CanonicalFactoryDocument<FactoryMaintenanceDiscoveryEvent>
  ): Promise<FactoryMaintenanceDiscoverySnapshot> {
    const run = this.#verifiedRun(runClaim);
    const event = this.#verifiedEvent(eventClaim);
    assertFactoryMaintenanceDiscoveryRun(run, this.#documents);
    assertFactoryMaintenanceDiscoveryRegistration(run, event);
    return Promise.resolve(
      this.#transaction(() => {
        this.#database
          .prepare(
            `INSERT INTO factory_maintenance_discovery_runs (
              run_id, run_digest, discovery_policy_id, discovery_policy_digest,
              schedule_policy_digest, factory_policy_bundle_digest, preparation_grant_digest,
              role_identity_policy_digest, repository_id, base_revision, scheduled_for,
              deadline_at, created_at, correlation_id, run_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            run.value.runId,
            run.digest,
            run.value.discoveryPolicy.id,
            run.value.discoveryPolicyDigest,
            run.value.schedulePolicyDigest,
            run.value.factoryPolicyBundleDigest,
            run.value.preparationGrantDigest,
            run.value.roleIdentityPolicyDigest,
            run.value.repository.id,
            run.value.repository.baseRevision,
            run.value.scheduledFor,
            run.value.deadlineAt,
            run.value.createdAt,
            run.value.correlationId,
            run.json
          );
        this.#insertEvent(event);
        return snapshotFrom(run, [event]);
      })
    );
  }

  public findBySlot(
    discoveryPolicyId: string,
    scheduledFor: string
  ): Promise<FactoryMaintenanceDiscoverySnapshot | null> {
    const row = this.#database
      .prepare(
        `SELECT ${RUN_COLUMNS} FROM factory_maintenance_discovery_runs
         WHERE discovery_policy_id = ? AND scheduled_for = ?`
      )
      .get(discoveryPolicyId, scheduledFor) as RunRow | undefined;
    return Promise.resolve(row === undefined ? null : this.#snapshot(this.#runFromRow(row)));
  }

  public findOpen(): Promise<FactoryMaintenanceDiscoverySnapshot | null> {
    const rows = this.#database
      .prepare(
        `SELECT ${RUN_COLUMNS} FROM factory_maintenance_discovery_runs AS run
         WHERE COALESCE((
           SELECT event.to_state FROM factory_maintenance_discovery_events AS event
           WHERE event.run_id = run.run_id ORDER BY event.sequence DESC LIMIT 1
         ), 'missing') NOT IN ('completed', 'failed')
         ORDER BY run.scheduled_for, run.run_id LIMIT 2`
      )
      .all() as unknown as RunRow[];
    if (rows.length > 1) {
      throw new Error("Maintenance discovery has multiple open runs; recovery is required.");
    }
    const row = rows[0];
    return Promise.resolve(row === undefined ? null : this.#snapshot(this.#runFromRow(row)));
  }

  public append(
    eventClaim: CanonicalFactoryDocument<FactoryMaintenanceDiscoveryEvent>
  ): Promise<FactoryMaintenanceDiscoverySnapshot | null> {
    const event = this.#verifiedEvent(eventClaim);
    return Promise.resolve(
      this.#transaction(() => {
        const run = this.#findRun(event.value.runId);
        if (run?.digest !== event.value.runDigest) return null;
        const history = this.#readEvents(run);
        assertFactoryMaintenanceDiscoveryEvent(run, event, history);
        this.#insertEvent(event);
        return snapshotFrom(run, [...history, event]);
      })
    );
  }

  public close(): void {
    this.#database.close();
  }

  #snapshot(
    run: CanonicalFactoryDocument<FactoryMaintenanceDiscoveryRun>
  ): FactoryMaintenanceDiscoverySnapshot {
    return snapshotFrom(run, this.#readEvents(run));
  }

  #findRun(runId: string): CanonicalFactoryDocument<FactoryMaintenanceDiscoveryRun> | null {
    const row = this.#database
      .prepare(`SELECT ${RUN_COLUMNS} FROM factory_maintenance_discovery_runs WHERE run_id = ?`)
      .get(runId) as RunRow | undefined;
    return row === undefined ? null : this.#runFromRow(row);
  }

  #runFromRow(row: RunRow): CanonicalFactoryDocument<FactoryMaintenanceDiscoveryRun> {
    const run = this.#documents.maintenanceDiscoveryRun(parseJson(row.run_json, "discovery run"));
    if (
      row.run_id !== run.value.runId ||
      row.run_digest !== run.digest ||
      row.discovery_policy_id !== run.value.discoveryPolicy.id ||
      row.discovery_policy_digest !== run.value.discoveryPolicyDigest ||
      row.schedule_policy_digest !== run.value.schedulePolicyDigest ||
      row.factory_policy_bundle_digest !== run.value.factoryPolicyBundleDigest ||
      row.preparation_grant_digest !== run.value.preparationGrantDigest ||
      row.role_identity_policy_digest !== run.value.roleIdentityPolicyDigest ||
      row.repository_id !== run.value.repository.id ||
      row.base_revision !== run.value.repository.baseRevision ||
      row.scheduled_for !== run.value.scheduledFor ||
      row.deadline_at !== run.value.deadlineAt ||
      row.created_at !== run.value.createdAt ||
      row.correlation_id !== run.value.correlationId ||
      row.run_json !== run.json
    ) {
      throw new Error(
        `Stored maintenance discovery run ${run.value.runId} failed integrity validation.`
      );
    }
    assertFactoryMaintenanceDiscoveryRun(run, this.#documents);
    return run;
  }

  #readEvents(
    run: CanonicalFactoryDocument<FactoryMaintenanceDiscoveryRun>
  ): readonly CanonicalFactoryDocument<FactoryMaintenanceDiscoveryEvent>[] {
    const rows = this.#database
      .prepare(
        `SELECT ${EVENT_COLUMNS} FROM factory_maintenance_discovery_events
         WHERE run_id = ? ORDER BY sequence LIMIT ?`
      )
      .all(run.value.runId, maximumEvents + 1) as unknown as EventRow[];
    if (rows.length > maximumEvents)
      throw new Error("Maintenance discovery event ceiling exceeded.");
    const events: CanonicalFactoryDocument<FactoryMaintenanceDiscoveryEvent>[] = [];
    for (const row of rows) {
      const event = this.#eventFromRow(row);
      if (events.length === 0) assertFactoryMaintenanceDiscoveryRegistration(run, event);
      else assertFactoryMaintenanceDiscoveryEvent(run, event, events);
      events.push(event);
    }
    if (events.length === 0)
      throw new Error("Maintenance discovery run has no registration event.");
    return events;
  }

  #eventFromRow(row: EventRow): CanonicalFactoryDocument<FactoryMaintenanceDiscoveryEvent> {
    const event = this.#documents.maintenanceDiscoveryEvent(
      parseJson(row.event_json, "discovery event")
    );
    const coordinates = eventCoordinates(event.value);
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
      row.execution_id !== coordinates.executionId ||
      row.finding_key !== coordinates.findingKey ||
      row.finding_digest !== coordinates.findingDigest ||
      row.task_id !== coordinates.taskId ||
      row.run_record_digest !== coordinates.runRecordDigest ||
      row.occurred_at !== event.value.occurredAt ||
      row.reason_code !== event.value.reasonCode ||
      row.correlation_id !== event.value.correlationId ||
      row.event_json !== event.json
    ) {
      throw new Error(
        `Stored maintenance discovery event ${event.value.eventId} failed integrity validation.`
      );
    }
    return event;
  }

  #insertEvent(event: CanonicalFactoryDocument<FactoryMaintenanceDiscoveryEvent>): void {
    const coordinates = eventCoordinates(event.value);
    this.#database
      .prepare(
        `INSERT INTO factory_maintenance_discovery_events (
          event_id, run_id, run_digest, sequence, event_digest, previous_event_digest, kind,
          from_state, to_state, execution_id, finding_key, finding_digest, task_id,
          run_record_digest, occurred_at, reason_code, correlation_id, event_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
        coordinates.executionId,
        coordinates.findingKey,
        coordinates.findingDigest,
        coordinates.taskId,
        coordinates.runRecordDigest,
        event.value.occurredAt,
        event.value.reasonCode,
        event.value.correlationId,
        event.json
      );
  }

  #verifiedRun(
    claim: CanonicalFactoryDocument<FactoryMaintenanceDiscoveryRun>
  ): CanonicalFactoryDocument<FactoryMaintenanceDiscoveryRun> {
    const actual = this.#documents.maintenanceDiscoveryRun(claim.value);
    if (actual.digest !== claim.digest || actual.json !== claim.json) {
      throw new Error("Claimed maintenance discovery run is not canonical.");
    }
    return actual;
  }

  #verifiedEvent(
    claim: CanonicalFactoryDocument<FactoryMaintenanceDiscoveryEvent>
  ): CanonicalFactoryDocument<FactoryMaintenanceDiscoveryEvent> {
    const actual = this.#documents.maintenanceDiscoveryEvent(claim.value);
    if (actual.digest !== claim.digest || actual.json !== claim.json) {
      throw new Error("Claimed maintenance discovery event is not canonical.");
    }
    return actual;
  }

  #transaction<Value>(operation: () => Value): Value {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      this.#database.exec("COMMIT");
      return value;
    } catch (error: unknown) {
      try {
        this.#database.exec("ROLLBACK");
      } catch {
        // Preserve the primary integrity error.
      }
      throw error;
    }
  }
}

function snapshotFrom(
  run: CanonicalFactoryDocument<FactoryMaintenanceDiscoveryRun>,
  events: readonly CanonicalFactoryDocument<FactoryMaintenanceDiscoveryEvent>[]
): FactoryMaintenanceDiscoverySnapshot {
  const last = events.at(-1);
  if (last === undefined) throw new Error("Maintenance discovery snapshot has no event.");
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

function eventCoordinates(event: FactoryMaintenanceDiscoveryEvent) {
  return {
    executionId:
      event.kind === "agent-started" ||
      event.kind === "agent-finished" ||
      event.kind === "agent-failed"
        ? event.executionId
        : null,
    findingKey:
      event.kind === "finding-admitted" || event.kind === "finding-skipped"
        ? event.findingKey
        : null,
    findingDigest:
      event.kind === "finding-admitted" || event.kind === "finding-skipped"
        ? event.findingDigest
        : null,
    taskId: event.kind === "finding-admitted" ? event.taskId : null,
    runRecordDigest:
      event.kind === "agent-finished" || event.kind === "agent-failed"
        ? event.runRecordDigest
        : null
  };
}

function parseJson(value: unknown, label: string): unknown {
  if (typeof value !== "string") throw new Error(`Stored maintenance ${label} is not text.`);
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error(`Stored maintenance ${label} is not valid JSON.`, { cause: error });
  }
}
