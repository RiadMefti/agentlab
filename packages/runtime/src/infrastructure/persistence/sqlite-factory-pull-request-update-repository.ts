import { DatabaseSync } from "node:sqlite";

import type {
  FactoryPullRequestUpdateEvent,
  FactoryPullRequestUpdateRun,
  Sha256Digest
} from "@agentlab/contracts";

import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../../domain/factory-documents.js";
import {
  assertPullRequestUpdateEvent,
  assertPullRequestUpdateRegistration,
  assertPullRequestUpdateRun
} from "../../domain/factory-pull-request-update-integrity.js";
import type {
  FactoryPullRequestUpdateRepository,
  FactoryPullRequestUpdateSnapshot
} from "../../domain/factory-pull-request-update-repository.js";
import { NodeFactoryDocumentCodec } from "./canonical-factory-documents.js";
import { openSqliteDatabase, type SqliteDatabaseOptions } from "./sqlite-database.js";

interface UpdateRunRow {
  readonly update_id: unknown;
  readonly update_digest: unknown;
  readonly task_id: unknown;
  readonly contract_digest: unknown;
  readonly proposal_digest: unknown;
  readonly repair_authorization_digest: unknown;
  readonly repair_run_digest: unknown;
  readonly repaired_patch_proposal_digest: unknown;
  readonly prior_record_digest: unknown;
  readonly broker_id: unknown;
  readonly repository_id: unknown;
  readonly base_revision: unknown;
  readonly branch_name: unknown;
  readonly pull_request_number: unknown;
  readonly prior_head_revision: unknown;
  readonly contract_repair_attempt: unknown;
  readonly created_at: unknown;
  readonly correlation_id: unknown;
  readonly update_json: unknown;
}

interface UpdateEventRow {
  readonly event_id: unknown;
  readonly update_id: unknown;
  readonly update_digest: unknown;
  readonly task_id: unknown;
  readonly contract_digest: unknown;
  readonly sequence: unknown;
  readonly event_digest: unknown;
  readonly previous_event_digest: unknown;
  readonly kind: unknown;
  readonly from_state: unknown;
  readonly to_state: unknown;
  readonly record_digest: unknown;
  readonly head_revision: unknown;
  readonly remote_updated: unknown;
  readonly evidence_bundle_digest: unknown;
  readonly task_event_digest: unknown;
  readonly occurred_at: unknown;
  readonly reason_code: unknown;
  readonly correlation_id: unknown;
  readonly event_json: unknown;
}

const RUN_COLUMNS = `
  update_id, update_digest, task_id, contract_digest, proposal_digest,
  repair_authorization_digest, repair_run_digest, repaired_patch_proposal_digest,
  prior_record_digest, broker_id, repository_id, base_revision, branch_name,
  pull_request_number, prior_head_revision, contract_repair_attempt, created_at,
  correlation_id, update_json
`;

const EVENT_COLUMNS = `
  event_id, update_id, update_digest, task_id, contract_digest, sequence, event_digest,
  previous_event_digest, kind, from_state, to_state, record_digest, head_revision,
  remote_updated, evidence_bundle_digest, task_event_digest, occurred_at, reason_code,
  correlation_id, event_json
`;

export interface SqliteFactoryPullRequestUpdateRepositoryOptions extends SqliteDatabaseOptions {
  readonly documents?: FactoryDocumentCodec;
}

/** SQLite-backed append-only journal for authorization-bound draft-branch updates. */
export class SqliteFactoryPullRequestUpdateRepository implements FactoryPullRequestUpdateRepository {
  readonly #database: DatabaseSync;
  readonly #documents: FactoryDocumentCodec;

  public constructor(
    databasePath: string,
    options: SqliteFactoryPullRequestUpdateRepositoryOptions = {}
  ) {
    this.#database = openSqliteDatabase(databasePath, options);
    this.#documents = options.documents ?? new NodeFactoryDocumentCodec();
  }

  public register(
    runClaim: CanonicalFactoryDocument<FactoryPullRequestUpdateRun>,
    initialEventClaim: CanonicalFactoryDocument<FactoryPullRequestUpdateEvent>
  ): Promise<FactoryPullRequestUpdateSnapshot> {
    const run = this.#verifiedRun(runClaim);
    const proposal = this.#documents.pullRequestUpdateProposal(run.value.proposal);
    assertPullRequestUpdateRun(run, proposal);
    const initialEvent = this.#verifiedEvent(initialEventClaim);
    assertPullRequestUpdateRegistration(run, initialEvent);
    const snapshot = this.#inTransaction(() => {
      const proposalValue = run.value.proposal;
      this.#database
        .prepare(
          `INSERT INTO factory_pull_request_updates (
            update_id, update_digest, task_id, contract_digest, proposal_digest,
            repair_authorization_digest, repair_run_digest, repaired_patch_proposal_digest,
            prior_record_digest, broker_id, repository_id, base_revision, branch_name,
            pull_request_number, prior_head_revision, contract_repair_attempt, created_at,
            correlation_id, update_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          run.value.updateId,
          run.digest,
          run.value.taskId,
          run.value.contractDigest,
          run.value.proposalDigest,
          proposalValue.repairAuthorizationDigest,
          proposalValue.repairRunDigest,
          proposalValue.repairedPatchProposalDigest,
          proposalValue.priorPullRequestRecordDigest,
          run.value.brokerId,
          proposalValue.repositoryId,
          proposalValue.baseRevision,
          proposalValue.branchName,
          proposalValue.pullRequestNumber,
          proposalValue.priorHeadRevision,
          proposalValue.contractRepairAttempt,
          run.value.createdAt,
          run.value.correlationId,
          run.json
        );
      this.#insertEvent(initialEvent);
      return snapshotFrom(run, [initialEvent], this.#documents);
    });
    return Promise.resolve(snapshot);
  }

  public findByAuthorizationDigest(
    authorizationDigest: Sha256Digest
  ): Promise<FactoryPullRequestUpdateSnapshot | null> {
    return Promise.resolve(this.#findOne("repair_authorization_digest", authorizationDigest));
  }

  public findByRepairRunDigest(
    repairRunDigest: Sha256Digest
  ): Promise<FactoryPullRequestUpdateSnapshot | null> {
    return Promise.resolve(this.#findOne("repair_run_digest", repairRunDigest));
  }

  public listByTaskId(taskId: string): Promise<readonly FactoryPullRequestUpdateSnapshot[]> {
    const rows = this.#database
      .prepare(
        `SELECT ${RUN_COLUMNS}
         FROM factory_pull_request_updates
         WHERE task_id = ?
         ORDER BY contract_repair_attempt
         LIMIT 21`
      )
      .all(taskId) as unknown as UpdateRunRow[];
    if (rows.length > 20) throw new Error(`Task ${taskId} exceeds the PR update limit.`);
    return Promise.resolve(rows.map((row) => this.#snapshot(this.#runFromRow(row))));
  }

  public listRecoverable(limit: number): Promise<readonly FactoryPullRequestUpdateSnapshot[]> {
    assertListLimit(limit);
    const rows = this.#database
      .prepare(
        `SELECT ${RUN_COLUMNS}
         FROM factory_pull_request_updates AS update_run
         WHERE (
           SELECT event.to_state
           FROM factory_pull_request_update_events AS event
           WHERE event.update_id = update_run.update_id
           ORDER BY event.sequence DESC LIMIT 1
         ) != 'completed'
         ORDER BY update_run.created_at, update_run.task_id, update_run.contract_repair_attempt
         LIMIT ?`
      )
      .all(limit) as unknown as UpdateRunRow[];
    return Promise.resolve(rows.map((row) => this.#snapshot(this.#runFromRow(row))));
  }

  public listEvents(updateId: string): Promise<readonly FactoryPullRequestUpdateEvent[]> {
    const run = this.#findRunById(updateId);
    if (run === null) return Promise.resolve([]);
    return Promise.resolve(this.#readEventDocuments(run).map(({ value }) => value));
  }

  public append(
    eventClaim: CanonicalFactoryDocument<FactoryPullRequestUpdateEvent>
  ): Promise<FactoryPullRequestUpdateSnapshot | null> {
    const event = this.#verifiedEvent(eventClaim);
    const result = this.#inTransaction(() => {
      const run = this.#findRunById(event.value.updateId);
      if (
        run?.digest !== event.value.updateDigest ||
        run.value.taskId !== event.value.taskId ||
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
      assertPullRequestUpdateEvent(run, event, history);
      this.#insertEvent(event);
      return snapshotFrom(run, [...history, event], this.#documents);
    });
    return Promise.resolve(result);
  }

  public close(): void {
    this.#database.close();
  }

  #findOne(
    column: "repair_authorization_digest" | "repair_run_digest",
    value: string
  ): FactoryPullRequestUpdateSnapshot | null {
    const row = this.#database
      .prepare(`SELECT ${RUN_COLUMNS} FROM factory_pull_request_updates WHERE ${column} = ?`)
      .get(value) as UpdateRunRow | undefined;
    return row === undefined ? null : this.#snapshot(this.#runFromRow(row));
  }

  #findRunById(updateId: string): CanonicalFactoryDocument<FactoryPullRequestUpdateRun> | null {
    const row = this.#database
      .prepare(`SELECT ${RUN_COLUMNS} FROM factory_pull_request_updates WHERE update_id = ?`)
      .get(updateId) as UpdateRunRow | undefined;
    return row === undefined ? null : this.#runFromRow(row);
  }

  #runFromRow(row: UpdateRunRow): CanonicalFactoryDocument<FactoryPullRequestUpdateRun> {
    const run = this.#documents.pullRequestUpdateRun(parseJson(row.update_json, "PR update"));
    const proposal = this.#documents.pullRequestUpdateProposal(run.value.proposal);
    assertPullRequestUpdateRun(run, proposal);
    const value = run.value;
    const proposalValue = value.proposal;
    if (
      row.update_id !== value.updateId ||
      row.update_digest !== run.digest ||
      row.task_id !== value.taskId ||
      row.contract_digest !== value.contractDigest ||
      row.proposal_digest !== value.proposalDigest ||
      row.repair_authorization_digest !== proposalValue.repairAuthorizationDigest ||
      row.repair_run_digest !== proposalValue.repairRunDigest ||
      row.repaired_patch_proposal_digest !== proposalValue.repairedPatchProposalDigest ||
      row.prior_record_digest !== proposalValue.priorPullRequestRecordDigest ||
      row.broker_id !== value.brokerId ||
      row.repository_id !== proposalValue.repositoryId ||
      row.base_revision !== proposalValue.baseRevision ||
      row.branch_name !== proposalValue.branchName ||
      row.pull_request_number !== proposalValue.pullRequestNumber ||
      row.prior_head_revision !== proposalValue.priorHeadRevision ||
      row.contract_repair_attempt !== proposalValue.contractRepairAttempt ||
      row.created_at !== value.createdAt ||
      row.correlation_id !== value.correlationId ||
      row.update_json !== run.json
    ) {
      throw new Error(`Stored pull-request update ${value.updateId} failed integrity validation.`);
    }
    return run;
  }

  #snapshot(
    run: CanonicalFactoryDocument<FactoryPullRequestUpdateRun>
  ): FactoryPullRequestUpdateSnapshot {
    return snapshotFrom(run, this.#readEventDocuments(run), this.#documents);
  }

  #readEventDocuments(
    run: CanonicalFactoryDocument<FactoryPullRequestUpdateRun>
  ): readonly CanonicalFactoryDocument<FactoryPullRequestUpdateEvent>[] {
    const rows = this.#database
      .prepare(
        `SELECT ${EVENT_COLUMNS}
         FROM factory_pull_request_update_events
         WHERE update_id = ?
         ORDER BY sequence
         LIMIT 6`
      )
      .all(run.value.updateId) as unknown as UpdateEventRow[];
    if (rows.length > 5)
      throw new Error(`PR update ${run.value.updateId} exceeds its event limit.`);
    const events: CanonicalFactoryDocument<FactoryPullRequestUpdateEvent>[] = [];
    for (const row of rows) {
      const event = this.#eventFromRow(row);
      assertPullRequestUpdateEvent(run, event, events);
      events.push(event);
    }
    if (events.length === 0) throw new Error(`PR update ${run.value.updateId} has no event.`);
    return events;
  }

  #eventFromRow(row: UpdateEventRow): CanonicalFactoryDocument<FactoryPullRequestUpdateEvent> {
    const event = this.#documents.pullRequestUpdateEvent(
      parseJson(row.event_json, "PR update event")
    );
    const fields = materializedFields(event.value, this.#documents);
    if (
      row.event_id !== event.value.eventId ||
      row.update_id !== event.value.updateId ||
      row.update_digest !== event.value.updateDigest ||
      row.task_id !== event.value.taskId ||
      row.contract_digest !== event.value.contractDigest ||
      row.sequence !== event.value.sequence ||
      row.event_digest !== event.digest ||
      row.previous_event_digest !== event.value.previousEventDigest ||
      row.kind !== event.value.kind ||
      row.from_state !== event.value.from ||
      row.to_state !== event.value.to ||
      row.record_digest !== fields.recordDigest ||
      row.head_revision !== fields.headRevision ||
      row.remote_updated !== fields.remoteUpdated ||
      row.evidence_bundle_digest !== fields.evidenceBundleDigest ||
      row.task_event_digest !== fields.taskEventDigest ||
      row.occurred_at !== event.value.occurredAt ||
      row.reason_code !== event.value.reasonCode ||
      row.correlation_id !== event.value.correlationId ||
      row.event_json !== event.json
    ) {
      throw new Error(`Stored PR update event ${event.value.eventId} failed integrity validation.`);
    }
    return event;
  }

  #insertEvent(event: CanonicalFactoryDocument<FactoryPullRequestUpdateEvent>): void {
    const fields = materializedFields(event.value, this.#documents);
    this.#database
      .prepare(
        `INSERT INTO factory_pull_request_update_events (
          event_id, update_id, update_digest, task_id, contract_digest, sequence,
          event_digest, previous_event_digest, kind, from_state, to_state, record_digest,
          head_revision, remote_updated, evidence_bundle_digest, task_event_digest,
          occurred_at, reason_code, correlation_id, event_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.value.eventId,
        event.value.updateId,
        event.value.updateDigest,
        event.value.taskId,
        event.value.contractDigest,
        event.value.sequence,
        event.digest,
        event.value.previousEventDigest,
        event.value.kind,
        event.value.from,
        event.value.to,
        fields.recordDigest,
        fields.headRevision,
        fields.remoteUpdated,
        fields.evidenceBundleDigest,
        fields.taskEventDigest,
        event.value.occurredAt,
        event.value.reasonCode,
        event.value.correlationId,
        event.json
      );
  }

  #verifiedRun(
    claimed: CanonicalFactoryDocument<FactoryPullRequestUpdateRun>
  ): CanonicalFactoryDocument<FactoryPullRequestUpdateRun> {
    const actual = this.#documents.pullRequestUpdateRun(claimed.value);
    assertDocumentClaim(claimed, actual, "pull-request update");
    return actual;
  }

  #verifiedEvent(
    claimed: CanonicalFactoryDocument<FactoryPullRequestUpdateEvent>
  ): CanonicalFactoryDocument<FactoryPullRequestUpdateEvent> {
    const actual = this.#documents.pullRequestUpdateEvent(claimed.value);
    assertDocumentClaim(claimed, actual, "pull-request update event");
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
          "Pull-request update transaction and rollback failed.",
          { cause: error }
        );
      }
      throw error;
    }
  }
}

function snapshotFrom(
  run: CanonicalFactoryDocument<FactoryPullRequestUpdateRun>,
  history: readonly CanonicalFactoryDocument<FactoryPullRequestUpdateEvent>[],
  documents: FactoryDocumentCodec
): FactoryPullRequestUpdateSnapshot {
  const last = history.at(-1);
  if (last === undefined) throw new Error("Pull-request update snapshot has no event.");
  const remote = history.find(({ value }) => value.kind === "remote-updated")?.value;
  const evidence = history.find(({ value }) => value.kind === "evidence-recorded")?.value;
  const completed = history.find(({ value }) => value.kind === "task-recorded")?.value;
  if (remote?.kind === "remote-updated") documents.pullRequestUpdateRecord(remote.record);
  return {
    run: run.value,
    runDigest: run.digest,
    state: last.value.to,
    sequence: last.value.sequence,
    lastEvent: last.value,
    lastEventDigest: last.digest,
    record: remote?.kind === "remote-updated" ? remote.record : null,
    remoteUpdated: remote?.kind === "remote-updated" ? remote.updated : null,
    evidenceBundleDigest:
      evidence?.kind === "evidence-recorded" ? evidence.evidenceBundleDigest : null,
    taskEventDigest: completed?.kind === "task-recorded" ? completed.taskEventDigest : null
  };
}

function materializedFields(event: FactoryPullRequestUpdateEvent, documents: FactoryDocumentCodec) {
  if (event.kind === "remote-updated") {
    return {
      recordDigest: documents.pullRequestUpdateRecord(event.record).digest,
      headRevision: event.record.headRevision,
      remoteUpdated: event.updated ? 1 : 0,
      evidenceBundleDigest: null,
      taskEventDigest: null
    };
  }
  return {
    recordDigest: null,
    headRevision: null,
    remoteUpdated: null,
    evidenceBundleDigest: event.kind === "evidence-recorded" ? event.evidenceBundleDigest : null,
    taskEventDigest: event.kind === "task-recorded" ? event.taskEventDigest : null
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
    throw new Error("Pull-request update list limit must be between 1 and 1000.");
  }
}
