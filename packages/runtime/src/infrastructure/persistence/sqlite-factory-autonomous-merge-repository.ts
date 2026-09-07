import { DatabaseSync } from "node:sqlite";

import {
  factoryTimestampSchema,
  type FactoryAutonomousMergeAuthorization,
  type FactoryAutonomousMergeEvent,
  type FactoryAutonomousMergePolicy,
  type FactoryAutonomousMergeRecord,
  type FactoryAutonomousMergeRun,
  type Sha256Digest
} from "@agentlab/contracts";

import {
  assertFactoryAutonomousMergeEvent,
  assertFactoryAutonomousMergeRecord,
  assertFactoryAutonomousMergeRegistration,
  assertFactoryAutonomousMergeRun
} from "../../domain/factory-autonomous-merge-integrity.js";
import {
  FactoryAutonomousMergeCapacityError,
  type FactoryAutonomousMergeCandidate,
  type FactoryAutonomousMergeJournalSnapshot,
  type FactoryAutonomousMergeRepository
} from "../../domain/factory-autonomous-merge-repository.js";
import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../../domain/factory-documents.js";
import { factoryTimestampAddSeconds } from "../../domain/factory-timestamp.js";
import { NodeFactoryDocumentCodec } from "./canonical-factory-documents.js";
import { openSqliteDatabase, type SqliteDatabaseOptions } from "./sqlite-database.js";

interface RunRow {
  readonly run_digest: unknown;
  readonly run_json: unknown;
  readonly authorization_digest: unknown;
  readonly authorization_json: unknown;
}

interface EventRow {
  readonly event_digest: unknown;
  readonly event_json: unknown;
}

interface RecordRow {
  readonly record_digest: unknown;
  readonly record_json: unknown;
}

interface StoredRun {
  readonly run: CanonicalFactoryDocument<FactoryAutonomousMergeRun>;
  readonly authorization: CanonicalFactoryDocument<FactoryAutonomousMergeAuthorization>;
}

export interface SqliteFactoryAutonomousMergeRepositoryOptions extends SqliteDatabaseOptions {
  readonly documents?: FactoryDocumentCodec;
}

/** Crash-durable, single-use autonomous merge intent journal. */
export class SqliteFactoryAutonomousMergeRepository implements FactoryAutonomousMergeRepository {
  readonly #database: DatabaseSync;
  readonly #documents: FactoryDocumentCodec;

  public constructor(
    databasePath: string,
    options: SqliteFactoryAutonomousMergeRepositoryOptions = {}
  ) {
    this.#database = openSqliteDatabase(databasePath, options);
    this.#documents = options.documents ?? new NodeFactoryDocumentCodec();
  }

  public listActive(input: {
    readonly repositoryId: string;
    readonly mergePolicyDigest: Sha256Digest;
    readonly limit: number;
  }): Promise<readonly FactoryAutonomousMergeJournalSnapshot[]> {
    assertLimit(input.limit);
    const rows = this.#database
      .prepare(
        `SELECT run_digest, run_json, authorization_digest, authorization_json
         FROM factory_autonomous_merge_runs AS run
         WHERE repository_id = ? AND merge_policy_digest = ?
           AND (SELECT event.to_state FROM factory_autonomous_merge_events AS event
             WHERE event.merge_run_id = run.merge_run_id
             ORDER BY event.sequence DESC LIMIT 1)
             IN ('ready', 'ready-intent-recorded', 'ready-for-review',
               'enqueue-intent-recorded', 'enqueued', 'merged', 'merge-evidence-recorded')
         ORDER BY created_at, merge_run_id LIMIT ?`
      )
      .all(input.repositoryId, input.mergePolicyDigest, input.limit) as unknown as RunRow[];
    return Promise.resolve(rows.map((row) => this.#snapshot(this.#storedRun(row))));
  }

  public countCompletedForUtcDay(input: {
    readonly repositoryId: string;
    readonly mergePolicyDigest: Sha256Digest;
    readonly windowStart: string;
    readonly windowEnd: string;
  }): Promise<number> {
    const row = this.#database
      .prepare(
        `SELECT COUNT(*) AS count
         FROM factory_autonomous_merge_records AS record
         JOIN factory_autonomous_merge_runs AS run ON run.merge_run_id = record.merge_run_id
         WHERE run.repository_id = ? AND run.merge_policy_digest = ?
           AND record.merged_at >= ? AND record.merged_at < ?
           AND EXISTS (
             SELECT 1 FROM factory_autonomous_merge_events AS event
             WHERE event.merge_run_id = run.merge_run_id AND event.kind = 'completed'
           )`
      )
      .get(input.repositoryId, input.mergePolicyDigest, input.windowStart, input.windowEnd) as
      { readonly count?: unknown } | undefined;
    if (typeof row?.count !== "number" || !Number.isSafeInteger(row.count) || row.count < 0) {
      throw new Error("Autonomous merge daily count is invalid.");
    }
    return Promise.resolve(row.count);
  }

  public register(
    policyClaim: CanonicalFactoryDocument<FactoryAutonomousMergePolicy>,
    runClaim: CanonicalFactoryDocument<FactoryAutonomousMergeRun>,
    eventClaim: CanonicalFactoryDocument<FactoryAutonomousMergeEvent>,
    candidate: FactoryAutonomousMergeCandidate
  ): Promise<FactoryAutonomousMergeJournalSnapshot> {
    const policy = this.#documents.autonomousMergePolicy(policyClaim.value);
    const run = this.#verifiedRun(runClaim);
    const event = this.#verifiedEvent(eventClaim);
    const authorization = this.#verifiedAuthorization(candidate.authorization);
    if (policy.digest !== policyClaim.digest || policy.json !== policyClaim.json) {
      throw new Error("Autonomous merge policy claim is not canonical.");
    }
    const verifiedCandidate = { ...candidate, authorization };
    assertFactoryAutonomousMergeRun(policy, verifiedCandidate, run, this.#documents);
    assertFactoryAutonomousMergeRegistration(run, event);
    return Promise.resolve(
      this.#transaction(() => {
        this.#assertCandidatePresent(verifiedCandidate);
        if (
          this.#countCapacity(run.value.repositoryId, run.value.createdAt) >=
          policy.value.maximumMergesPerUtcDay
        ) {
          throw new FactoryAutonomousMergeCapacityError();
        }
        this.#database
          .prepare(
            `INSERT INTO factory_autonomous_merge_runs (
              merge_run_id, run_digest, authorization_id, authorization_digest,
              authorization_json, task_id, contract_digest, repository_id, pull_request_number,
              expected_head_revision, merge_policy_digest, created_at, deadline_at,
              correlation_id, run_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            run.value.mergeRunId,
            run.digest,
            run.value.authorizationId,
            authorization.digest,
            authorization.json,
            run.value.taskId,
            run.value.contractDigest,
            run.value.repositoryId,
            run.value.pullRequestNumber,
            run.value.expectedHeadRevision,
            run.value.mergePolicyDigest,
            run.value.createdAt,
            run.value.deadlineAt,
            run.value.correlationId,
            run.json
          );
        this.#insertEvent(event);
        return snapshotFrom(run, [event], null);
      })
    );
  }

  public append(
    eventClaim: CanonicalFactoryDocument<FactoryAutonomousMergeEvent>
  ): Promise<FactoryAutonomousMergeJournalSnapshot | null> {
    const event = this.#verifiedEvent(eventClaim);
    if (event.value.kind === "evidence-recorded") {
      throw new Error(
        "Autonomous merge record must be persisted atomically with its evidence event."
      );
    }
    return Promise.resolve(
      this.#transaction(() => {
        const stored = this.#findRun(event.value.mergeRunId);
        if (stored?.run.digest !== event.value.runDigest) return null;
        const history = this.#readEvents(stored.run);
        assertFactoryAutonomousMergeEvent(stored.run, event, history);
        const record = this.#readRecord(stored, history);
        if (event.value.kind === "completed" && record === null) {
          throw new Error("Autonomous merge completion has no durable merge record.");
        }
        this.#insertEvent(event);
        return snapshotFrom(stored.run, [...history, event], record?.value ?? null);
      })
    );
  }

  public record(
    eventClaim: CanonicalFactoryDocument<FactoryAutonomousMergeEvent>,
    recordClaim: CanonicalFactoryDocument<FactoryAutonomousMergeRecord>
  ): Promise<FactoryAutonomousMergeJournalSnapshot | null> {
    const event = this.#verifiedEvent(eventClaim);
    const record = this.#verifiedRecord(recordClaim);
    return Promise.resolve(
      this.#transaction(() => {
        const stored = this.#findRun(event.value.mergeRunId);
        if (stored?.run.digest !== event.value.runDigest) return null;
        const history = this.#readEvents(stored.run);
        assertFactoryAutonomousMergeEvent(stored.run, event, history);
        assertFactoryAutonomousMergeRecord(
          stored.run,
          stored.authorization,
          event,
          record,
          history
        );
        this.#database
          .prepare(
            `INSERT INTO factory_autonomous_merge_records (
              merge_run_id, run_digest, record_digest, authorization_digest,
              merged_revision, merge_queue_entry_id, merged_at, recorded_at, record_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            stored.run.value.mergeRunId,
            stored.run.digest,
            record.digest,
            stored.authorization.digest,
            record.value.mergedRevision,
            record.value.mergeQueueEntryId,
            record.value.mergedAt,
            record.value.recordedAt,
            record.json
          );
        this.#insertEvent(event);
        return snapshotFrom(stored.run, [...history, event], record.value);
      })
    );
  }

  public close(): void {
    this.#database.close();
  }

  public countCapacityForUtcDay(input: {
    readonly repositoryId: string;
    readonly at: string;
  }): Promise<number> {
    return Promise.resolve(this.#countCapacity(input.repositoryId, input.at));
  }

  #countCapacity(repositoryId: string, at: string): number {
    const timestamp = factoryTimestampSchema.parse(at);
    const windowStart = `${timestamp.slice(0, 10)}T00:00:00.000Z`;
    const windowEnd = factoryTimestampAddSeconds(windowStart, 86_400);
    // A run is a reservation, independent of the policy version that created it. Charge it once
    // for today's registration or merge, or for unresolved work carried into today. A terminal
    // pre-enqueue failure can release on the next day; an enqueue intent remains uncertain even
    // after quarantine. Only completed reconciliation can release that carryover automatically.
    const row = this.#database
      .prepare(
        `SELECT COUNT(*) AS count FROM factory_autonomous_merge_runs AS run
         WHERE run.repository_id = ? AND (
           (run.created_at >= ? AND run.created_at < ?)
           OR EXISTS (
             SELECT 1 FROM factory_autonomous_merge_events AS event
             WHERE event.merge_run_id = run.merge_run_id AND event.kind = 'merged'
               AND event.merged_at >= ? AND event.merged_at < ?
           )
           OR (
             NOT EXISTS (
               SELECT 1 FROM factory_autonomous_merge_events AS event
               WHERE event.merge_run_id = run.merge_run_id AND event.kind = 'completed'
             ) AND (
               COALESCE((SELECT event.to_state FROM factory_autonomous_merge_events AS event
                 WHERE event.merge_run_id = run.merge_run_id
                 ORDER BY event.sequence DESC LIMIT 1), '') NOT IN ('stale', 'quarantined')
               OR EXISTS (
                 SELECT 1 FROM factory_autonomous_merge_events AS event
                 WHERE event.merge_run_id = run.merge_run_id
                   AND event.kind = 'enqueue-intent-recorded'
               )
             )
           )
         )`
      )
      .get(repositoryId, windowStart, windowEnd, windowStart, windowEnd) as
      { readonly count?: unknown } | undefined;
    if (typeof row?.count !== "number" || !Number.isSafeInteger(row.count) || row.count < 0) {
      throw new Error("Autonomous merge daily capacity count is invalid.");
    }
    return row.count;
  }

  #assertCandidatePresent(candidate: FactoryAutonomousMergeCandidate): void {
    const authorization = candidate.authorization;
    const row = this.#database
      .prepare(
        `SELECT 1 AS present
         FROM factory_evidence_bundles AS bundle, json_each(bundle.bundle_json, '$.items') AS item
         WHERE bundle.bundle_digest = ?
           AND bundle.task_id = ?
           AND bundle.contract_digest = ?
           AND json_extract(item.value, '$.kind') = 'merge'
           AND json_extract(item.value, '$.result') = 'pass'
           AND json_extract(item.value, '$.subjectDigest') = ?
           AND json_extract(item.value, '$.artifact.digest') = ?
           AND json_extract(item.value, '$.artifact.mediaType') =
             'application/vnd.agentlab.autonomous-merge-authorization.v1+json'
           AND json_extract(item.value, '$.producer.kind') = 'control-plane'
           AND json_extract(item.value, '$.producer.role') = 'policy-engine'
           AND EXISTS (
             SELECT 1 FROM factory_task_events AS event
             WHERE event.task_id = bundle.task_id
               AND event.sequence = (
                 SELECT MAX(latest.sequence) FROM factory_task_events AS latest
                 WHERE latest.task_id = bundle.task_id
               )
               AND event.to_state = 'merge-ready'
               AND json_extract(event.event_json, '$.evidenceBundleDigest') =
                 bundle.bundle_digest
           )`
      )
      .get(
        candidate.evidenceBundleDigest,
        authorization.value.taskId,
        authorization.value.contractDigest,
        authorization.digest,
        authorization.digest
      ) as { readonly present?: unknown } | undefined;
    if (row?.present !== 1) {
      throw new Error("Autonomous merge run is not rooted in exact merge-ready evidence.");
    }
  }

  #findRun(mergeRunId: string): StoredRun | null {
    const row = this.#database
      .prepare(
        `SELECT run_digest, run_json, authorization_digest, authorization_json
         FROM factory_autonomous_merge_runs WHERE merge_run_id = ?`
      )
      .get(mergeRunId) as RunRow | undefined;
    return row === undefined ? null : this.#storedRun(row);
  }

  #storedRun(row: RunRow): StoredRun {
    const run = this.#documents.autonomousMergeRun(parseJson(row.run_json, "merge run"));
    const authorization = this.#documents.autonomousMergeAuthorization(
      parseJson(row.authorization_json, "merge authorization")
    );
    if (
      run.digest !== row.run_digest ||
      authorization.digest !== row.authorization_digest ||
      run.value.authorizationDigest !== authorization.digest ||
      run.value.authorizationId !== authorization.value.authorizationId
    ) {
      throw new Error("Stored autonomous merge run failed transitive digest validation.");
    }
    return { run, authorization };
  }

  #snapshot(stored: StoredRun): FactoryAutonomousMergeJournalSnapshot {
    const history = this.#readEvents(stored.run);
    return snapshotFrom(stored.run, history, this.#readRecord(stored, history)?.value ?? null);
  }

  #readEvents(
    run: CanonicalFactoryDocument<FactoryAutonomousMergeRun>
  ): readonly CanonicalFactoryDocument<FactoryAutonomousMergeEvent>[] {
    const rows = this.#database
      .prepare(
        `SELECT event_digest, event_json FROM factory_autonomous_merge_events
         WHERE merge_run_id = ? ORDER BY sequence LIMIT 11`
      )
      .all(run.value.mergeRunId) as unknown as EventRow[];
    if (rows.length < 1 || rows.length > 10) {
      throw new Error("Stored autonomous merge event count is invalid.");
    }
    const history: CanonicalFactoryDocument<FactoryAutonomousMergeEvent>[] = [];
    for (const row of rows) {
      const event = this.#documents.autonomousMergeEvent(parseJson(row.event_json, "merge event"));
      if (event.digest !== row.event_digest) {
        throw new Error("Stored autonomous merge event failed digest validation.");
      }
      if (history.length === 0) assertFactoryAutonomousMergeRegistration(run, event);
      else assertFactoryAutonomousMergeEvent(run, event, history);
      history.push(event);
    }
    return history;
  }

  #readRecord(
    stored: StoredRun,
    history: readonly CanonicalFactoryDocument<FactoryAutonomousMergeEvent>[]
  ): CanonicalFactoryDocument<FactoryAutonomousMergeRecord> | null {
    const row = this.#database
      .prepare(
        `SELECT record_digest, record_json FROM factory_autonomous_merge_records
         WHERE merge_run_id = ?`
      )
      .get(stored.run.value.mergeRunId) as RecordRow | undefined;
    if (row === undefined) return null;
    const record = this.#documents.autonomousMergeRecord(
      parseJson(row.record_json, "merge record")
    );
    const event = history.find(({ value }) => value.kind === "evidence-recorded");
    if (record.digest !== row.record_digest || event === undefined) {
      throw new Error("Stored autonomous merge record failed digest validation.");
    }
    assertFactoryAutonomousMergeRecord(
      stored.run,
      stored.authorization,
      event,
      record,
      history.slice(0, history.indexOf(event))
    );
    return record;
  }

  #insertEvent(event: CanonicalFactoryDocument<FactoryAutonomousMergeEvent>): void {
    this.#database
      .prepare(
        `INSERT INTO factory_autonomous_merge_events (
          event_id, merge_run_id, run_digest, sequence, event_digest, previous_event_digest,
          kind, from_state, to_state, merge_queue_entry_id, merged_revision, merged_at,
          record_digest, evidence_bundle_digest, task_event_digest, occurred_at, reason_code,
          correlation_id, event_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.value.eventId,
        event.value.mergeRunId,
        event.value.runDigest,
        event.value.sequence,
        event.digest,
        event.value.previousEventDigest,
        event.value.kind,
        event.value.from,
        event.value.to,
        "mergeQueueEntryId" in event.value ? event.value.mergeQueueEntryId : null,
        "mergedRevision" in event.value ? event.value.mergedRevision : null,
        "mergedAt" in event.value ? event.value.mergedAt : null,
        "recordDigest" in event.value ? event.value.recordDigest : null,
        "evidenceBundleDigest" in event.value ? event.value.evidenceBundleDigest : null,
        "taskEventDigest" in event.value ? event.value.taskEventDigest : null,
        event.value.occurredAt,
        event.value.reasonCode,
        event.value.correlationId,
        event.json
      );
  }

  #verifiedRun(claim: CanonicalFactoryDocument<FactoryAutonomousMergeRun>) {
    const document = this.#documents.autonomousMergeRun(claim.value);
    if (document.digest !== claim.digest || document.json !== claim.json) {
      throw new Error("Autonomous merge run claim is not canonical.");
    }
    return document;
  }

  #verifiedAuthorization(claim: CanonicalFactoryDocument<FactoryAutonomousMergeAuthorization>) {
    const document = this.#documents.autonomousMergeAuthorization(claim.value);
    if (document.digest !== claim.digest || document.json !== claim.json) {
      throw new Error("Autonomous merge authorization claim is not canonical.");
    }
    return document;
  }

  #verifiedEvent(claim: CanonicalFactoryDocument<FactoryAutonomousMergeEvent>) {
    const document = this.#documents.autonomousMergeEvent(claim.value);
    if (document.digest !== claim.digest || document.json !== claim.json) {
      throw new Error("Autonomous merge event claim is not canonical.");
    }
    return document;
  }

  #verifiedRecord(claim: CanonicalFactoryDocument<FactoryAutonomousMergeRecord>) {
    const document = this.#documents.autonomousMergeRecord(claim.value);
    if (document.digest !== claim.digest || document.json !== claim.json) {
      throw new Error("Autonomous merge record claim is not canonical.");
    }
    return document;
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
      } catch (rollback: unknown) {
        throw new AggregateError([error, rollback], "Autonomous merge rollback failed.");
      }
      throw error;
    }
  }
}

function snapshotFrom(
  run: CanonicalFactoryDocument<FactoryAutonomousMergeRun>,
  history: readonly CanonicalFactoryDocument<FactoryAutonomousMergeEvent>[],
  record: FactoryAutonomousMergeRecord | null
): FactoryAutonomousMergeJournalSnapshot {
  const last = history.at(-1);
  if (last === undefined) throw new Error("Autonomous merge journal has no events.");
  return {
    run: run.value,
    runDigest: run.digest,
    state: last.value.to,
    sequence: last.value.sequence,
    lastEvent: last.value,
    lastEventDigest: last.digest,
    history: history.map(({ value }) => value),
    record
  };
}

function assertLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) {
    throw new Error("Autonomous merge query limit is invalid.");
  }
}

function parseJson(value: unknown, label: string): unknown {
  if (typeof value !== "string") throw new Error(`Stored ${label} is not text.`);
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error(`Stored ${label} is not valid JSON.`, { cause: error });
  }
}
