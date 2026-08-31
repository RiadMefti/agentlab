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
import {
  assertCanonicalFactoryDocumentClaim,
  assertFactoryExecutionListLimit,
  factoryExecutionSnapshotFrom,
  insertFactoryExecutionEvent,
  parseStoredFactoryJson,
  readFactoryExecutionEvents,
  verifyFactoryExecutionEventClaim,
  withImmediateFactoryTransaction
} from "./sqlite-factory-execution-journal.js";

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

const RUN_COLUMNS = `
  run_id, run_digest, task_id, contract_digest, repository_id, base_revision,
  maximum_attempts, created_at, correlation_id, run_json
`;

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
    const snapshot = withImmediateFactoryTransaction(this.#database, "Factory execution", () => {
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
      insertFactoryExecutionEvent({
        database: this.#database,
        table: "factory_execution_events",
        event: initialEvent
      });
      return factoryExecutionSnapshotFrom(run, initialEvent);
    });
    return Promise.resolve(snapshot);
  }

  public findByTaskId(taskId: string): Promise<FactoryExecutionSnapshot | null> {
    const run = this.#findRun(taskId);
    if (run === null) return Promise.resolve(null);
    return Promise.resolve(this.#snapshot(run));
  }

  public listRecoverable(limit: number): Promise<readonly FactoryExecutionSnapshot[]> {
    assertFactoryExecutionListLimit(limit);
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
    const result = withImmediateFactoryTransaction(this.#database, "Factory execution", () => {
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
      insertFactoryExecutionEvent({
        database: this.#database,
        table: "factory_execution_events",
        event
      });
      return factoryExecutionSnapshotFrom(run, event);
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
    const run = this.#documents.executionRun(
      parseStoredFactoryJson(row.run_json, "factory execution run")
    );
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
    return factoryExecutionSnapshotFrom(run, last);
  }

  #readEventDocuments(
    run: CanonicalFactoryDocument<FactoryExecutionRun>
  ): readonly CanonicalFactoryDocument<FactoryExecutionEvent>[] {
    return readFactoryExecutionEvents({
      database: this.#database,
      documents: this.#documents,
      table: "factory_execution_events",
      run,
      label: "Factory execution"
    });
  }

  #verifiedRun(
    claimed: CanonicalFactoryDocument<FactoryExecutionRun>
  ): CanonicalFactoryDocument<FactoryExecutionRun> {
    const actual = this.#documents.executionRun(claimed.value);
    assertCanonicalFactoryDocumentClaim(claimed, actual, "execution run");
    return actual;
  }

  #verifiedEvent(
    claimed: CanonicalFactoryDocument<FactoryExecutionEvent>
  ): CanonicalFactoryDocument<FactoryExecutionEvent> {
    return verifyFactoryExecutionEventClaim(this.#documents, claimed);
  }
}
