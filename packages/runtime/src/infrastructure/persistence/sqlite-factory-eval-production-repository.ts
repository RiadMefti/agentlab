import { DatabaseSync } from "node:sqlite";

import type { FactoryEvalProductionEvent, FactoryEvalProductionJob } from "@agentlab/contracts";

import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../../domain/factory-documents.js";
import {
  assertFactoryEvalProductionJob,
  assertFactoryEvalProductionSnapshot
} from "../../domain/factory-eval-production-integrity.js";
import type {
  FactoryEvalProductionRepository,
  FactoryEvalProductionSnapshot
} from "../../domain/factory-eval-production-repository.js";
import { canonicalJson, NodeFactoryDocumentCodec } from "./canonical-factory-documents.js";
import { openSqliteDatabase, type SqliteDatabaseOptions } from "./sqlite-database.js";

interface JobRow {
  readonly job_id: unknown;
  readonly job_digest: unknown;
  readonly runner_id: unknown;
  readonly suite_digest: unknown;
  readonly case_bank_digest: unknown;
  readonly baseline_candidate_digest: unknown;
  readonly baseline_harness_digest: unknown;
  readonly challenger_candidate_digest: unknown;
  readonly challenger_harness_digest: unknown;
  readonly grader_digest: unknown;
  readonly created_at: unknown;
  readonly deadline_at: unknown;
  readonly correlation_id: unknown;
  readonly job_json: unknown;
}

interface EventRow {
  readonly event_id: unknown;
  readonly job_id: unknown;
  readonly job_digest: unknown;
  readonly sequence: unknown;
  readonly event_digest: unknown;
  readonly previous_event_digest: unknown;
  readonly kind: unknown;
  readonly from_state: unknown;
  readonly to_state: unknown;
  readonly case_id: unknown;
  readonly trial: unknown;
  readonly candidate_role: unknown;
  readonly execution_id: unknown;
  readonly evidence_digest: unknown;
  readonly sample_digest: unknown;
  readonly eval_run_digest: unknown;
  readonly eval_run_artifact_json: unknown;
  readonly usage_json: unknown;
  readonly occurred_at: unknown;
  readonly reason_code: unknown;
  readonly correlation_id: unknown;
  readonly event_json: unknown;
}

const JOB_COLUMNS = `
  job_id, job_digest, runner_id, suite_digest, case_bank_digest,
  baseline_candidate_digest, baseline_harness_digest, challenger_candidate_digest,
  challenger_harness_digest, grader_digest, created_at, deadline_at, correlation_id, job_json
`;

const EVENT_COLUMNS = `
  event_id, job_id, job_digest, sequence, event_digest, previous_event_digest, kind,
  from_state, to_state, case_id, trial, candidate_role, execution_id, evidence_digest,
  sample_digest, eval_run_digest, eval_run_artifact_json, usage_json, occurred_at,
  reason_code, correlation_id, event_json
`;

const maximumEvents = 100_000;

export interface SqliteFactoryEvalProductionRepositoryOptions extends SqliteDatabaseOptions {
  readonly documents?: FactoryDocumentCodec;
}

/** SQLite-backed immutable job and append-only journal for offline eval production. */
export class SqliteFactoryEvalProductionRepository implements FactoryEvalProductionRepository {
  readonly #database: DatabaseSync;
  readonly #documents: FactoryDocumentCodec;

  public constructor(
    databasePath: string,
    options: SqliteFactoryEvalProductionRepositoryOptions = {}
  ) {
    this.#database = openSqliteDatabase(databasePath, options);
    this.#documents = options.documents ?? new NodeFactoryDocumentCodec();
  }

  public register(
    jobClaim: CanonicalFactoryDocument<FactoryEvalProductionJob>,
    eventClaim: CanonicalFactoryDocument<FactoryEvalProductionEvent>
  ): Promise<FactoryEvalProductionSnapshot> {
    const job = this.#verifiedJob(jobClaim);
    const event = this.#verifiedEvent(eventClaim);
    assertFactoryEvalProductionJob(job, this.#documents);
    const initial = snapshotFrom(job, [event]);
    assertFactoryEvalProductionSnapshot(initial, this.#documents);
    return Promise.resolve(
      this.#transaction(() => {
        this.#database
          .prepare(
            `INSERT INTO factory_eval_production_jobs (
              job_id, job_digest, runner_id, suite_digest, case_bank_digest,
              baseline_candidate_digest, baseline_harness_digest, challenger_candidate_digest,
              challenger_harness_digest, grader_digest, created_at, deadline_at,
              correlation_id, job_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            job.value.jobId,
            job.digest,
            job.value.runnerId,
            job.value.suiteDigest,
            job.value.caseBankDigest,
            job.value.baselineCandidateDigest,
            job.value.baselineHarnessDigest,
            job.value.challengerCandidateDigest,
            job.value.challengerHarnessDigest,
            job.value.graderDigest,
            job.value.createdAt,
            job.value.deadlineAt,
            job.value.correlationId,
            job.json
          );
        this.#insertEvent(event);
        return initial;
      })
    );
  }

  public append(
    eventClaim: CanonicalFactoryDocument<FactoryEvalProductionEvent>
  ): Promise<FactoryEvalProductionSnapshot> {
    const event = this.#verifiedEvent(eventClaim);
    return Promise.resolve(
      this.#transaction(() => {
        const job = this.#findJob(event.value.jobId);
        if (job?.digest !== event.value.jobDigest) {
          throw new Error("Factory eval production job does not exist for this event.");
        }
        const current = this.#snapshot(job);
        const next = snapshotFrom(job, [
          ...current.events.map(({ event: value }) => this.#documents.evalProductionEvent(value)),
          event
        ]);
        assertFactoryEvalProductionSnapshot(next, this.#documents);
        this.#insertEvent(event);
        return next;
      })
    );
  }

  public findByJobId(jobId: string): Promise<FactoryEvalProductionSnapshot | null> {
    const row = this.#database
      .prepare(`SELECT ${JOB_COLUMNS} FROM factory_eval_production_jobs WHERE job_id = ?`)
      .get(jobId) as JobRow | undefined;
    return Promise.resolve(row === undefined ? null : this.#snapshot(this.#jobFromRow(row)));
  }

  public close(): void {
    this.#database.close();
  }

  #snapshot(
    job: CanonicalFactoryDocument<FactoryEvalProductionJob>
  ): FactoryEvalProductionSnapshot {
    const rows = this.#database
      .prepare(
        `SELECT ${EVENT_COLUMNS} FROM factory_eval_production_events
         WHERE job_id = ? ORDER BY sequence LIMIT ?`
      )
      .all(job.value.jobId, maximumEvents + 1) as unknown as EventRow[];
    if (rows.length === 0 || rows.length > maximumEvents) {
      throw new Error("Factory eval production event history is missing or exceeds its ceiling.");
    }
    const snapshot = snapshotFrom(
      job,
      rows.map((row) => this.#eventFromRow(row))
    );
    assertFactoryEvalProductionSnapshot(snapshot, this.#documents);
    return snapshot;
  }

  #findJob(jobId: string): CanonicalFactoryDocument<FactoryEvalProductionJob> | null {
    const row = this.#database
      .prepare(`SELECT ${JOB_COLUMNS} FROM factory_eval_production_jobs WHERE job_id = ?`)
      .get(jobId) as JobRow | undefined;
    return row === undefined ? null : this.#jobFromRow(row);
  }

  #jobFromRow(row: JobRow): CanonicalFactoryDocument<FactoryEvalProductionJob> {
    const job = this.#documents.evalProductionJob(parseJson(row.job_json, "job"));
    if (
      row.job_id !== job.value.jobId ||
      row.job_digest !== job.digest ||
      row.runner_id !== job.value.runnerId ||
      row.suite_digest !== job.value.suiteDigest ||
      row.case_bank_digest !== job.value.caseBankDigest ||
      row.baseline_candidate_digest !== job.value.baselineCandidateDigest ||
      row.baseline_harness_digest !== job.value.baselineHarnessDigest ||
      row.challenger_candidate_digest !== job.value.challengerCandidateDigest ||
      row.challenger_harness_digest !== job.value.challengerHarnessDigest ||
      row.grader_digest !== job.value.graderDigest ||
      row.created_at !== job.value.createdAt ||
      row.deadline_at !== job.value.deadlineAt ||
      row.correlation_id !== job.value.correlationId ||
      row.job_json !== job.json
    ) {
      throw new Error(
        `Stored factory eval production job ${job.value.jobId} failed integrity validation.`
      );
    }
    assertFactoryEvalProductionJob(job, this.#documents);
    return job;
  }

  #eventFromRow(row: EventRow): CanonicalFactoryDocument<FactoryEvalProductionEvent> {
    const event = this.#documents.evalProductionEvent(parseJson(row.event_json, "event"));
    if (
      row.event_id !== event.value.eventId ||
      row.job_id !== event.value.jobId ||
      row.job_digest !== event.value.jobDigest ||
      row.sequence !== event.value.sequence ||
      row.event_digest !== event.digest ||
      row.previous_event_digest !== event.value.previousEventDigest ||
      row.kind !== event.value.kind ||
      row.from_state !== event.value.from ||
      row.to_state !== event.value.to ||
      row.case_id !== event.value.caseId ||
      row.trial !== event.value.trial ||
      row.candidate_role !== event.value.candidateRole ||
      row.execution_id !== event.value.executionId ||
      row.evidence_digest !== event.value.evidenceDigest ||
      row.sample_digest !== event.value.sampleDigest ||
      row.eval_run_digest !== event.value.evalRunDigest ||
      !sameJson(row.eval_run_artifact_json, event.value.evalRunArtifact) ||
      !sameJson(row.usage_json, event.value.usage) ||
      row.occurred_at !== event.value.occurredAt ||
      row.reason_code !== event.value.reasonCode ||
      row.correlation_id !== event.value.correlationId ||
      row.event_json !== event.json
    ) {
      throw new Error(
        `Stored factory eval production event ${event.value.eventId} failed integrity validation.`
      );
    }
    return event;
  }

  #insertEvent(event: CanonicalFactoryDocument<FactoryEvalProductionEvent>): void {
    this.#database
      .prepare(
        `INSERT INTO factory_eval_production_events (
          event_id, job_id, job_digest, sequence, event_digest, previous_event_digest, kind,
          from_state, to_state, case_id, trial, candidate_role, execution_id, evidence_digest,
          sample_digest, eval_run_digest, eval_run_artifact_json, usage_json, occurred_at,
          reason_code, correlation_id, event_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.value.eventId,
        event.value.jobId,
        event.value.jobDigest,
        event.value.sequence,
        event.digest,
        event.value.previousEventDigest,
        event.value.kind,
        event.value.from,
        event.value.to,
        event.value.caseId,
        event.value.trial,
        event.value.candidateRole,
        event.value.executionId,
        event.value.evidenceDigest,
        event.value.sampleDigest,
        event.value.evalRunDigest,
        event.value.evalRunArtifact === null ? null : canonicalJson(event.value.evalRunArtifact),
        event.value.usage === null ? null : canonicalJson(event.value.usage),
        event.value.occurredAt,
        event.value.reasonCode,
        event.value.correlationId,
        event.json
      );
  }

  #verifiedJob(
    claim: CanonicalFactoryDocument<FactoryEvalProductionJob>
  ): CanonicalFactoryDocument<FactoryEvalProductionJob> {
    const actual = this.#documents.evalProductionJob(claim.value);
    if (actual.digest !== claim.digest || actual.json !== claim.json) {
      throw new Error("Claimed factory eval production job is not canonical.");
    }
    return actual;
  }

  #verifiedEvent(
    claim: CanonicalFactoryDocument<FactoryEvalProductionEvent>
  ): CanonicalFactoryDocument<FactoryEvalProductionEvent> {
    const actual = this.#documents.evalProductionEvent(claim.value);
    if (actual.digest !== claim.digest || actual.json !== claim.json) {
      throw new Error("Claimed factory eval production event is not canonical.");
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
  job: CanonicalFactoryDocument<FactoryEvalProductionJob>,
  events: readonly CanonicalFactoryDocument<FactoryEvalProductionEvent>[]
): FactoryEvalProductionSnapshot {
  return {
    job: job.value,
    jobDigest: job.digest,
    events: events.map(({ value, digest }) => ({ event: value, eventDigest: digest }))
  };
}

function parseJson(value: unknown, label: string): unknown {
  if (typeof value !== "string") throw new Error(`Stored eval production ${label} is not text.`);
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error(`Stored eval production ${label} is not valid JSON.`, { cause: error });
  }
}

function sameJson(value: unknown, expected: unknown): boolean {
  if (value === null || expected === null) return value === null && expected === null;
  if (typeof value !== "string") return false;
  try {
    return canonicalJson(JSON.parse(value) as unknown) === canonicalJson(expected);
  } catch {
    return false;
  }
}
