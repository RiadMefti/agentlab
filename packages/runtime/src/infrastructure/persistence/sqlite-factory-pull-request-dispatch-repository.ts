import { DatabaseSync } from "node:sqlite";

import type {
  FactoryPullRequestDispatchEvent,
  FactoryPullRequestDispatchRun
} from "@agentlab/contracts";

import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../../domain/factory-documents.js";
import {
  assertPullRequestDispatchEvent,
  assertPullRequestDispatchRegistration,
  assertPullRequestDispatchRun
} from "../../domain/factory-pull-request-dispatch-integrity.js";
import type {
  FactoryPullRequestDispatchRepository,
  FactoryPullRequestDispatchSnapshot
} from "../../domain/factory-pull-request-dispatch-repository.js";
import { NodeFactoryDocumentCodec } from "./canonical-factory-documents.js";
import { openSqliteDatabase, type SqliteDatabaseOptions } from "./sqlite-database.js";

interface DispatchRunRow {
  readonly dispatch_id: unknown;
  readonly dispatch_digest: unknown;
  readonly task_id: unknown;
  readonly contract_digest: unknown;
  readonly proposal_digest: unknown;
  readonly broker_id: unknown;
  readonly repository_id: unknown;
  readonly base_revision: unknown;
  readonly branch_name: unknown;
  readonly created_at: unknown;
  readonly correlation_id: unknown;
  readonly dispatch_json: unknown;
}

interface DispatchEventRow {
  readonly event_id: unknown;
  readonly dispatch_id: unknown;
  readonly dispatch_digest: unknown;
  readonly task_id: unknown;
  readonly contract_digest: unknown;
  readonly sequence: unknown;
  readonly event_digest: unknown;
  readonly previous_event_digest: unknown;
  readonly kind: unknown;
  readonly from_state: unknown;
  readonly to_state: unknown;
  readonly record_digest: unknown;
  readonly pull_request_number: unknown;
  readonly head_revision: unknown;
  readonly remote_created: unknown;
  readonly evidence_bundle_digest: unknown;
  readonly task_event_digest: unknown;
  readonly occurred_at: unknown;
  readonly reason_code: unknown;
  readonly correlation_id: unknown;
  readonly event_json: unknown;
}

const RUN_COLUMNS = `
  dispatch_id, dispatch_digest, task_id, contract_digest, proposal_digest, broker_id,
  repository_id, base_revision, branch_name, created_at, correlation_id, dispatch_json
`;

const EVENT_COLUMNS = `
  event_id, dispatch_id, dispatch_digest, task_id, contract_digest, sequence, event_digest,
  previous_event_digest, kind, from_state, to_state, record_digest, pull_request_number,
  head_revision, remote_created, evidence_bundle_digest, task_event_digest, occurred_at,
  reason_code, correlation_id, event_json
`;

export interface SqliteFactoryPullRequestDispatchRepositoryOptions extends SqliteDatabaseOptions {
  readonly documents?: FactoryDocumentCodec;
}

/** SQLite-backed append-only journal for one exact draft-PR authority dispatch. */
export class SqliteFactoryPullRequestDispatchRepository implements FactoryPullRequestDispatchRepository {
  readonly #database: DatabaseSync;
  readonly #documents: FactoryDocumentCodec;

  public constructor(
    databasePath: string,
    options: SqliteFactoryPullRequestDispatchRepositoryOptions = {}
  ) {
    this.#database = openSqliteDatabase(databasePath, options);
    this.#documents = options.documents ?? new NodeFactoryDocumentCodec();
  }

  public register(
    runClaim: CanonicalFactoryDocument<FactoryPullRequestDispatchRun>,
    initialEventClaim: CanonicalFactoryDocument<FactoryPullRequestDispatchEvent>
  ): Promise<FactoryPullRequestDispatchSnapshot> {
    const run = this.#verifiedRun(runClaim);
    const proposal = this.#documents.pullRequestProposal(run.value.proposal);
    assertPullRequestDispatchRun(run, proposal);
    const initialEvent = this.#verifiedEvent(initialEventClaim);
    assertPullRequestDispatchRegistration(run, initialEvent);
    const snapshot = this.#inTransaction(() => {
      this.#database
        .prepare(
          `INSERT INTO factory_pull_request_dispatches (
            dispatch_id, dispatch_digest, task_id, contract_digest, proposal_digest, broker_id,
            repository_id, base_revision, branch_name, created_at, correlation_id, dispatch_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          run.value.dispatchId,
          run.digest,
          run.value.taskId,
          run.value.contractDigest,
          run.value.proposalDigest,
          run.value.brokerId,
          run.value.proposal.repositoryId,
          run.value.proposal.baseRevision,
          run.value.proposal.branchName,
          run.value.createdAt,
          run.value.correlationId,
          run.json
        );
      this.#insertEvent(initialEvent);
      return snapshotFrom(run, [initialEvent], this.#documents);
    });
    return Promise.resolve(snapshot);
  }

  public findByTaskId(taskId: string): Promise<FactoryPullRequestDispatchSnapshot | null> {
    const run = this.#findRun(taskId);
    return Promise.resolve(run === null ? null : this.#snapshot(run));
  }

  public listRecoverable(limit: number): Promise<readonly FactoryPullRequestDispatchSnapshot[]> {
    assertListLimit(limit);
    const rows = this.#database
      .prepare(
        `SELECT ${RUN_COLUMNS}
         FROM factory_pull_request_dispatches AS dispatch
         WHERE (
           SELECT event.to_state
           FROM factory_pull_request_dispatch_events AS event
           WHERE event.dispatch_id = dispatch.dispatch_id
           ORDER BY event.sequence DESC
           LIMIT 1
         ) != 'completed'
         ORDER BY dispatch.created_at, dispatch.task_id
         LIMIT ?`
      )
      .all(limit) as unknown as DispatchRunRow[];
    return Promise.resolve(rows.map((row) => this.#snapshot(this.#runFromRow(row))));
  }

  public listEvents(taskId: string): Promise<readonly FactoryPullRequestDispatchEvent[]> {
    const run = this.#findRun(taskId);
    if (run === null) return Promise.resolve([]);
    return Promise.resolve(this.#readEventDocuments(run).map(({ value }) => value));
  }

  public append(
    eventClaim: CanonicalFactoryDocument<FactoryPullRequestDispatchEvent>
  ): Promise<FactoryPullRequestDispatchSnapshot | null> {
    const event = this.#verifiedEvent(eventClaim);
    const result = this.#inTransaction(() => {
      const run = this.#findRun(event.value.taskId);
      if (
        run?.value.dispatchId !== event.value.dispatchId ||
        run.digest !== event.value.dispatchDigest ||
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
      assertPullRequestDispatchEvent(run, event, history);
      this.#insertEvent(event);
      return snapshotFrom(run, [...history, event], this.#documents);
    });
    return Promise.resolve(result);
  }

  public close(): void {
    this.#database.close();
  }

  #findRun(taskId: string): CanonicalFactoryDocument<FactoryPullRequestDispatchRun> | null {
    const row = this.#database
      .prepare(`SELECT ${RUN_COLUMNS} FROM factory_pull_request_dispatches WHERE task_id = ?`)
      .get(taskId) as DispatchRunRow | undefined;
    return row === undefined ? null : this.#runFromRow(row);
  }

  #runFromRow(row: DispatchRunRow): CanonicalFactoryDocument<FactoryPullRequestDispatchRun> {
    const run = this.#documents.pullRequestDispatchRun(
      parseJson(row.dispatch_json, "pull-request dispatch")
    );
    const proposal = this.#documents.pullRequestProposal(run.value.proposal);
    assertPullRequestDispatchRun(run, proposal);
    if (
      row.dispatch_id !== run.value.dispatchId ||
      row.dispatch_digest !== run.digest ||
      row.task_id !== run.value.taskId ||
      row.contract_digest !== run.value.contractDigest ||
      row.proposal_digest !== run.value.proposalDigest ||
      row.broker_id !== run.value.brokerId ||
      row.repository_id !== run.value.proposal.repositoryId ||
      row.base_revision !== run.value.proposal.baseRevision ||
      row.branch_name !== run.value.proposal.branchName ||
      row.created_at !== run.value.createdAt ||
      row.correlation_id !== run.value.correlationId ||
      row.dispatch_json !== run.json
    ) {
      throw new Error(
        `Stored pull-request dispatch ${run.value.dispatchId} failed integrity validation.`
      );
    }
    return run;
  }

  #snapshot(
    run: CanonicalFactoryDocument<FactoryPullRequestDispatchRun>
  ): FactoryPullRequestDispatchSnapshot {
    const history = this.#readEventDocuments(run);
    if (history.length === 0) {
      throw new Error(`Pull-request dispatch ${run.value.dispatchId} has no event.`);
    }
    return snapshotFrom(run, history, this.#documents);
  }

  #readEventDocuments(
    run: CanonicalFactoryDocument<FactoryPullRequestDispatchRun>
  ): readonly CanonicalFactoryDocument<FactoryPullRequestDispatchEvent>[] {
    const rows = this.#database
      .prepare(
        `SELECT ${EVENT_COLUMNS}
         FROM factory_pull_request_dispatch_events
         WHERE dispatch_id = ?
         ORDER BY sequence
         LIMIT 6`
      )
      .all(run.value.dispatchId) as unknown as DispatchEventRow[];
    if (rows.length > 5) {
      throw new Error(`Pull-request dispatch ${run.value.dispatchId} exceeds the event limit.`);
    }
    const events: CanonicalFactoryDocument<FactoryPullRequestDispatchEvent>[] = [];
    for (const row of rows) {
      const event = this.#eventFromRow(row);
      assertPullRequestDispatchEvent(run, event, events);
      events.push(event);
    }
    return events;
  }

  #eventFromRow(row: DispatchEventRow): CanonicalFactoryDocument<FactoryPullRequestDispatchEvent> {
    const event = this.#documents.pullRequestDispatchEvent(
      parseJson(row.event_json, "pull-request dispatch event")
    );
    const fields = materializedFields(event.value, this.#documents);
    if (
      row.event_id !== event.value.eventId ||
      row.dispatch_id !== event.value.dispatchId ||
      row.dispatch_digest !== event.value.dispatchDigest ||
      row.task_id !== event.value.taskId ||
      row.contract_digest !== event.value.contractDigest ||
      row.sequence !== event.value.sequence ||
      row.event_digest !== event.digest ||
      row.previous_event_digest !== event.value.previousEventDigest ||
      row.kind !== event.value.kind ||
      row.from_state !== event.value.from ||
      row.to_state !== event.value.to ||
      row.record_digest !== fields.recordDigest ||
      row.pull_request_number !== fields.pullRequestNumber ||
      row.head_revision !== fields.headRevision ||
      row.remote_created !== fields.remoteCreated ||
      row.evidence_bundle_digest !== fields.evidenceBundleDigest ||
      row.task_event_digest !== fields.taskEventDigest ||
      row.occurred_at !== event.value.occurredAt ||
      row.reason_code !== event.value.reasonCode ||
      row.correlation_id !== event.value.correlationId ||
      row.event_json !== event.json
    ) {
      throw new Error(`Stored dispatch event ${event.value.eventId} failed integrity validation.`);
    }
    return event;
  }

  #insertEvent(event: CanonicalFactoryDocument<FactoryPullRequestDispatchEvent>): void {
    const fields = materializedFields(event.value, this.#documents);
    this.#database
      .prepare(
        `INSERT INTO factory_pull_request_dispatch_events (
          event_id, dispatch_id, dispatch_digest, task_id, contract_digest, sequence,
          event_digest, previous_event_digest, kind, from_state, to_state, record_digest,
          pull_request_number, head_revision, remote_created, evidence_bundle_digest,
          task_event_digest, occurred_at, reason_code, correlation_id, event_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.value.eventId,
        event.value.dispatchId,
        event.value.dispatchDigest,
        event.value.taskId,
        event.value.contractDigest,
        event.value.sequence,
        event.digest,
        event.value.previousEventDigest,
        event.value.kind,
        event.value.from,
        event.value.to,
        fields.recordDigest,
        fields.pullRequestNumber,
        fields.headRevision,
        fields.remoteCreated,
        fields.evidenceBundleDigest,
        fields.taskEventDigest,
        event.value.occurredAt,
        event.value.reasonCode,
        event.value.correlationId,
        event.json
      );
  }

  #verifiedRun(
    claimed: CanonicalFactoryDocument<FactoryPullRequestDispatchRun>
  ): CanonicalFactoryDocument<FactoryPullRequestDispatchRun> {
    const actual = this.#documents.pullRequestDispatchRun(claimed.value);
    assertDocumentClaim(claimed, actual, "pull-request dispatch");
    return actual;
  }

  #verifiedEvent(
    claimed: CanonicalFactoryDocument<FactoryPullRequestDispatchEvent>
  ): CanonicalFactoryDocument<FactoryPullRequestDispatchEvent> {
    const actual = this.#documents.pullRequestDispatchEvent(claimed.value);
    assertDocumentClaim(claimed, actual, "pull-request dispatch event");
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
          "Pull-request dispatch transaction and rollback failed.",
          { cause: error }
        );
      }
      throw error;
    }
  }
}

function snapshotFrom(
  run: CanonicalFactoryDocument<FactoryPullRequestDispatchRun>,
  history: readonly CanonicalFactoryDocument<FactoryPullRequestDispatchEvent>[],
  documents: FactoryDocumentCodec
): FactoryPullRequestDispatchSnapshot {
  const last = history.at(-1);
  if (last === undefined) throw new Error("Pull-request dispatch snapshot has no event.");
  const remote = history.find(({ value }) => value.kind === "remote-observed")?.value;
  const evidence = history.find(({ value }) => value.kind === "evidence-recorded")?.value;
  const completed = history.find(({ value }) => value.kind === "task-recorded")?.value;
  if (remote?.kind === "remote-observed") documents.pullRequestRecord(remote.record);
  return {
    run: run.value,
    runDigest: run.digest,
    state: last.value.to,
    sequence: last.value.sequence,
    lastEvent: last.value,
    lastEventDigest: last.digest,
    record: remote?.kind === "remote-observed" ? remote.record : null,
    evidenceBundleDigest:
      evidence?.kind === "evidence-recorded" ? evidence.evidenceBundleDigest : null,
    taskEventDigest: completed?.kind === "task-recorded" ? completed.taskEventDigest : null
  };
}

function materializedFields(
  event: FactoryPullRequestDispatchEvent,
  documents: FactoryDocumentCodec
) {
  if (event.kind === "remote-observed") {
    const record = documents.pullRequestRecord(event.record);
    return {
      recordDigest: record.digest,
      pullRequestNumber: event.record.number,
      headRevision: event.record.headRevision,
      remoteCreated: event.created ? 1 : 0,
      evidenceBundleDigest: null,
      taskEventDigest: null
    };
  }
  if (event.kind === "evidence-recorded") {
    return {
      recordDigest: null,
      pullRequestNumber: null,
      headRevision: null,
      remoteCreated: null,
      evidenceBundleDigest: event.evidenceBundleDigest,
      taskEventDigest: null
    };
  }
  if (event.kind === "task-recorded") {
    return {
      recordDigest: null,
      pullRequestNumber: null,
      headRevision: null,
      remoteCreated: null,
      evidenceBundleDigest: null,
      taskEventDigest: event.taskEventDigest
    };
  }
  return {
    recordDigest: null,
    pullRequestNumber: null,
    headRevision: null,
    remoteCreated: null,
    evidenceBundleDigest: null,
    taskEventDigest: null
  };
}

function assertDocumentClaim<Value>(
  claimed: CanonicalFactoryDocument<Value>,
  actual: CanonicalFactoryDocument<Value>,
  label: string
): void {
  if (claimed.digest !== actual.digest || claimed.json !== actual.json) {
    throw new Error(`Claimed ${label} digest or JSON is not canonical.`);
  }
}

function parseJson(value: unknown, label: string): unknown {
  if (typeof value !== "string") throw new Error(`Stored ${label} JSON is not text.`);
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error(`Stored ${label} JSON is invalid.`, { cause: error });
  }
}

function assertListLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error("Pull-request dispatch list limit must be between 1 and 1000.");
  }
}
