import { DatabaseSync } from "node:sqlite";

import {
  sha256DigestSchema,
  type FactoryExecutionEvent,
  type FactoryPullRequestRepairRun,
  type Sha256Digest
} from "@agentlab/contracts";
import { z } from "zod";

import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../../domain/factory-documents.js";
import {
  assertFactoryExecutionEvent,
  assertFactoryExecutionRegistration
} from "../../domain/factory-execution-integrity.js";
import type {
  FactoryPullRequestRepairExecutionRepository,
  FactoryPullRequestRepairExecutionSnapshot
} from "../../domain/factory-pull-request-repair-execution-repository.js";
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

interface RepairRunRow {
  readonly run_id: unknown;
  readonly run_digest: unknown;
  readonly task_id: unknown;
  readonly contract_digest: unknown;
  readonly policy_bundle_digest: unknown;
  readonly authorization_id: unknown;
  readonly authorization_digest: unknown;
  readonly observation_digest: unknown;
  readonly prior_patch_proposal_digest: unknown;
  readonly repository_id: unknown;
  readonly base_revision: unknown;
  readonly contract_repair_attempt: unknown;
  readonly maximum_attempts: unknown;
  readonly created_at: unknown;
  readonly correlation_id: unknown;
  readonly run_json: unknown;
}

const repairRunColumns = `
  run_id, run_digest, task_id, contract_digest, policy_bundle_digest,
  authorization_id, authorization_digest, observation_digest, prior_patch_proposal_digest,
  repository_id, base_revision, contract_repair_attempt, maximum_attempts, created_at,
  correlation_id, run_json
`;

export interface SqliteFactoryPullRequestRepairExecutionRepositoryOptions extends SqliteDatabaseOptions {
  readonly documents?: FactoryDocumentCodec;
}

/** SQLite-backed journal for authorization-bound repair executions. */
export class SqliteFactoryPullRequestRepairExecutionRepository implements FactoryPullRequestRepairExecutionRepository {
  readonly #database: DatabaseSync;
  readonly #documents: FactoryDocumentCodec;

  public constructor(
    databasePath: string,
    options: SqliteFactoryPullRequestRepairExecutionRepositoryOptions = {}
  ) {
    this.#database = openSqliteDatabase(databasePath, options);
    this.#documents = options.documents ?? new NodeFactoryDocumentCodec();
  }

  public register(
    runClaim: CanonicalFactoryDocument<FactoryPullRequestRepairRun>,
    initialEventClaim: CanonicalFactoryDocument<FactoryExecutionEvent>
  ): Promise<FactoryPullRequestRepairExecutionSnapshot> {
    const run = this.#verifiedRun(runClaim);
    const event = verifyFactoryExecutionEventClaim(this.#documents, initialEventClaim);
    assertFactoryExecutionRegistration(run, event);
    const snapshot = withImmediateFactoryTransaction(
      this.#database,
      "Factory PR repair execution",
      () => {
        this.#database
          .prepare(
            `INSERT INTO factory_pull_request_repair_runs (
              run_id, run_digest, task_id, contract_digest, policy_bundle_digest,
              authorization_id, authorization_digest, observation_digest,
              prior_patch_proposal_digest, repository_id, base_revision,
              contract_repair_attempt, maximum_attempts, created_at, correlation_id, run_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            run.value.runId,
            run.digest,
            run.value.taskId,
            run.value.contractDigest,
            run.value.policyBundleDigest,
            run.value.authorizationId,
            run.value.authorizationDigest,
            run.value.observationDigest,
            run.value.priorPatchProposalDigest,
            run.value.repository.id,
            run.value.repository.baseRevision,
            run.value.contractRepairAttempt,
            run.value.maximumAttempts,
            run.value.createdAt,
            run.value.correlationId,
            run.json
          );
        insertFactoryExecutionEvent({
          database: this.#database,
          table: "factory_pull_request_repair_events",
          event
        });
        return factoryExecutionSnapshotFrom(run, event);
      }
    );
    return Promise.resolve(snapshot);
  }

  public findByAuthorizationDigest(
    authorizationDigest: Sha256Digest
  ): Promise<FactoryPullRequestRepairExecutionSnapshot | null> {
    const digest = sha256DigestSchema.parse(authorizationDigest);
    const row = this.#database
      .prepare(
        `SELECT ${repairRunColumns}
         FROM factory_pull_request_repair_runs
         WHERE authorization_digest = ?`
      )
      .get(digest) as RepairRunRow | undefined;
    return Promise.resolve(row === undefined ? null : this.#snapshot(this.#runFromRow(row)));
  }

  public listByTaskId(
    taskId: string
  ): Promise<readonly FactoryPullRequestRepairExecutionSnapshot[]> {
    const parsedTaskId = z.uuid().parse(taskId);
    const rows = this.#database
      .prepare(
        `SELECT ${repairRunColumns}
         FROM factory_pull_request_repair_runs
         WHERE task_id = ?
         ORDER BY contract_repair_attempt, created_at, run_id`
      )
      .all(parsedTaskId) as unknown as RepairRunRow[];
    return Promise.resolve(rows.map((row) => this.#snapshot(this.#runFromRow(row))));
  }

  public listRecoverable(
    limit: number
  ): Promise<readonly FactoryPullRequestRepairExecutionSnapshot[]> {
    assertFactoryExecutionListLimit(limit);
    const rows = this.#database
      .prepare(
        `SELECT ${repairRunColumns}
         FROM factory_pull_request_repair_runs AS run
         WHERE (
           SELECT event.to_state
           FROM factory_pull_request_repair_events AS event
           WHERE event.run_id = run.run_id
           ORDER BY event.sequence DESC
           LIMIT 1
         ) IN ('ready', 'workspace-active', 'operation-active')
         ORDER BY run.created_at, run.task_id, run.contract_repair_attempt
         LIMIT ?`
      )
      .all(limit) as unknown as RepairRunRow[];
    return Promise.resolve(rows.map((row) => this.#snapshot(this.#runFromRow(row))));
  }

  public listEvents(runId: string): Promise<readonly FactoryExecutionEvent[]> {
    const run = this.#findRunById(z.uuid().parse(runId));
    if (run === null) return Promise.resolve([]);
    return Promise.resolve(this.#readEvents(run).map(({ value }) => value));
  }

  public append(
    eventClaim: CanonicalFactoryDocument<FactoryExecutionEvent>
  ): Promise<FactoryPullRequestRepairExecutionSnapshot | null> {
    const event = verifyFactoryExecutionEventClaim(this.#documents, eventClaim);
    const snapshot = withImmediateFactoryTransaction(
      this.#database,
      "Factory PR repair execution",
      () => {
        const run = this.#findRunById(event.value.runId);
        if (
          run?.digest !== event.value.runDigest ||
          run.value.taskId !== event.value.taskId ||
          run.value.contractDigest !== event.value.contractDigest
        ) {
          return null;
        }
        const history = this.#readEvents(run);
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
          table: "factory_pull_request_repair_events",
          event
        });
        return factoryExecutionSnapshotFrom(run, event);
      }
    );
    return Promise.resolve(snapshot);
  }

  public close(): void {
    this.#database.close();
  }

  #findRunById(runId: string): CanonicalFactoryDocument<FactoryPullRequestRepairRun> | null {
    const row = this.#database
      .prepare(
        `SELECT ${repairRunColumns}
         FROM factory_pull_request_repair_runs
         WHERE run_id = ?`
      )
      .get(runId) as RepairRunRow | undefined;
    return row === undefined ? null : this.#runFromRow(row);
  }

  #runFromRow(row: RepairRunRow): CanonicalFactoryDocument<FactoryPullRequestRepairRun> {
    const run = this.#documents.pullRequestRepairRun(
      parseStoredFactoryJson(row.run_json, "factory PR repair run")
    );
    if (
      row.run_id !== run.value.runId ||
      row.run_digest !== run.digest ||
      row.task_id !== run.value.taskId ||
      row.contract_digest !== run.value.contractDigest ||
      row.policy_bundle_digest !== run.value.policyBundleDigest ||
      row.authorization_id !== run.value.authorizationId ||
      row.authorization_digest !== run.value.authorizationDigest ||
      row.observation_digest !== run.value.observationDigest ||
      row.prior_patch_proposal_digest !== run.value.priorPatchProposalDigest ||
      row.repository_id !== run.value.repository.id ||
      row.base_revision !== run.value.repository.baseRevision ||
      row.contract_repair_attempt !== run.value.contractRepairAttempt ||
      row.maximum_attempts !== run.value.maximumAttempts ||
      row.created_at !== run.value.createdAt ||
      row.correlation_id !== run.value.correlationId ||
      row.run_json !== run.json
    ) {
      throw new Error(`Stored factory PR repair ${run.value.runId} failed integrity validation.`);
    }
    return run;
  }

  #verifiedRun(
    claimed: CanonicalFactoryDocument<FactoryPullRequestRepairRun>
  ): CanonicalFactoryDocument<FactoryPullRequestRepairRun> {
    const actual = this.#documents.pullRequestRepairRun(claimed.value);
    assertCanonicalFactoryDocumentClaim(claimed, actual, "PR repair run");
    return actual;
  }

  #snapshot(
    run: CanonicalFactoryDocument<FactoryPullRequestRepairRun>
  ): FactoryPullRequestRepairExecutionSnapshot {
    const last = this.#readEvents(run).at(-1);
    if (last === undefined) throw new Error(`Factory PR repair ${run.value.runId} has no event.`);
    return factoryExecutionSnapshotFrom(run, last);
  }

  #readEvents(
    run: CanonicalFactoryDocument<FactoryPullRequestRepairRun>
  ): readonly CanonicalFactoryDocument<FactoryExecutionEvent>[] {
    return readFactoryExecutionEvents({
      database: this.#database,
      documents: this.#documents,
      table: "factory_pull_request_repair_events",
      run,
      label: "Factory PR repair execution"
    });
  }
}
