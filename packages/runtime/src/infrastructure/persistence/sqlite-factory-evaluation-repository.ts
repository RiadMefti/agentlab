import { DatabaseSync } from "node:sqlite";

import type { FactoryEvalAssessment, FactoryEvalRun, Sha256Digest } from "@agentlab/contracts";

import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../../domain/factory-documents.js";
import {
  assertFactoryEvalAssessment,
  assertFactoryEvalRun
} from "../../domain/factory-evaluation-integrity.js";
import type {
  FactoryEvaluationRepository,
  FactoryEvalSnapshot
} from "../../domain/factory-evaluation-repository.js";
import { NodeFactoryDocumentCodec } from "./canonical-factory-documents.js";
import { openSqliteDatabase, type SqliteDatabaseOptions } from "./sqlite-database.js";

interface EvalRunRow {
  readonly run_id: unknown;
  readonly run_digest: unknown;
  readonly suite_digest: unknown;
  readonly baseline_candidate_digest: unknown;
  readonly challenger_candidate_digest: unknown;
  readonly started_at: unknown;
  readonly completed_at: unknown;
  readonly correlation_id: unknown;
  readonly run_json: unknown;
}

interface EvalAssessmentRow {
  readonly assessment_id: unknown;
  readonly assessment_digest: unknown;
  readonly run_id: unknown;
  readonly run_digest: unknown;
  readonly decision: unknown;
  readonly assessed_at: unknown;
  readonly assessment_json: unknown;
}

const RUN_COLUMNS = `
  run_id, run_digest, suite_digest, baseline_candidate_digest, challenger_candidate_digest,
  started_at, completed_at, correlation_id, run_json
`;

const ASSESSMENT_COLUMNS = `
  assessment_id, assessment_digest, run_id, run_digest, decision, assessed_at, assessment_json
`;

export interface SqliteFactoryEvaluationRepositoryOptions extends SqliteDatabaseOptions {
  readonly documents?: FactoryDocumentCodec;
}

/** SQLite-backed immutable matched eval run and deterministic assessment store. */
export class SqliteFactoryEvaluationRepository implements FactoryEvaluationRepository {
  readonly #database: DatabaseSync;
  readonly #documents: FactoryDocumentCodec;

  public constructor(databasePath: string, options: SqliteFactoryEvaluationRepositoryOptions = {}) {
    this.#database = openSqliteDatabase(databasePath, options);
    this.#documents = options.documents ?? new NodeFactoryDocumentCodec();
  }

  public record(
    runClaim: CanonicalFactoryDocument<FactoryEvalRun>,
    assessmentClaim: CanonicalFactoryDocument<FactoryEvalAssessment>
  ): Promise<FactoryEvalSnapshot> {
    const run = this.#verifiedRun(runClaim);
    const assessment = this.#verifiedAssessment(assessmentClaim);
    assertFactoryEvalAssessment(run, assessment, this.#documents);
    const snapshot = this.#inTransaction(() => {
      this.#database
        .prepare(
          `INSERT INTO factory_eval_runs (
            run_id, run_digest, suite_digest, baseline_candidate_digest,
            challenger_candidate_digest, started_at, completed_at, correlation_id, run_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          run.value.runId,
          run.digest,
          run.value.suiteDigest,
          run.value.baselineCandidateDigest,
          run.value.challengerCandidateDigest,
          run.value.startedAt,
          run.value.completedAt,
          run.value.correlationId,
          run.json
        );
      this.#database
        .prepare(
          `INSERT INTO factory_eval_assessments (
            assessment_id, assessment_digest, run_id, run_digest, decision,
            assessed_at, assessment_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          assessment.value.assessmentId,
          assessment.digest,
          assessment.value.runId,
          assessment.value.runDigest,
          assessment.value.decision,
          assessment.value.assessedAt,
          assessment.json
        );
      return snapshotFrom(run, assessment);
    });
    return Promise.resolve(snapshot);
  }

  public findByRunId(runId: string): Promise<FactoryEvalSnapshot | null> {
    const runRow = this.#database
      .prepare(`SELECT ${RUN_COLUMNS} FROM factory_eval_runs WHERE run_id = ?`)
      .get(runId) as EvalRunRow | undefined;
    return Promise.resolve(runRow === undefined ? null : this.#snapshot(this.#runFromRow(runRow)));
  }

  public findByAssessmentDigest(
    assessmentDigest: Sha256Digest
  ): Promise<FactoryEvalSnapshot | null> {
    const assessmentRow = this.#database
      .prepare(
        `SELECT ${ASSESSMENT_COLUMNS}
         FROM factory_eval_assessments
         WHERE assessment_digest = ?`
      )
      .get(assessmentDigest) as EvalAssessmentRow | undefined;
    if (assessmentRow === undefined) return Promise.resolve(null);
    const assessment = this.#assessmentFromRow(assessmentRow);
    const runRow = this.#database
      .prepare(`SELECT ${RUN_COLUMNS} FROM factory_eval_runs WHERE run_id = ?`)
      .get(assessment.value.runId) as EvalRunRow | undefined;
    if (runRow === undefined) {
      throw new Error("Stored factory eval assessment is missing its immutable run.");
    }
    const run = this.#runFromRow(runRow);
    assertFactoryEvalAssessment(run, assessment, this.#documents);
    return Promise.resolve(snapshotFrom(run, assessment));
  }

  public close(): void {
    this.#database.close();
  }

  #snapshot(run: CanonicalFactoryDocument<FactoryEvalRun>): FactoryEvalSnapshot {
    const row = this.#database
      .prepare(
        `SELECT ${ASSESSMENT_COLUMNS}
         FROM factory_eval_assessments
         WHERE run_id = ?`
      )
      .get(run.value.runId) as EvalAssessmentRow | undefined;
    if (row === undefined) throw new Error("Stored factory eval run has no assessment.");
    const assessment = this.#assessmentFromRow(row);
    assertFactoryEvalAssessment(run, assessment, this.#documents);
    return snapshotFrom(run, assessment);
  }

  #runFromRow(row: EvalRunRow): CanonicalFactoryDocument<FactoryEvalRun> {
    const run = this.#documents.evalRun(parseJson(row.run_json, "factory eval run"));
    if (
      row.run_id !== run.value.runId ||
      row.run_digest !== run.digest ||
      row.suite_digest !== run.value.suiteDigest ||
      row.baseline_candidate_digest !== run.value.baselineCandidateDigest ||
      row.challenger_candidate_digest !== run.value.challengerCandidateDigest ||
      row.started_at !== run.value.startedAt ||
      row.completed_at !== run.value.completedAt ||
      row.correlation_id !== run.value.correlationId ||
      row.run_json !== run.json
    ) {
      throw new Error(`Stored factory eval run ${run.value.runId} failed integrity validation.`);
    }
    assertFactoryEvalRun(run, this.#documents);
    return run;
  }

  #assessmentFromRow(row: EvalAssessmentRow): CanonicalFactoryDocument<FactoryEvalAssessment> {
    const assessment = this.#documents.evalAssessment(
      parseJson(row.assessment_json, "factory eval assessment")
    );
    if (
      row.assessment_id !== assessment.value.assessmentId ||
      row.assessment_digest !== assessment.digest ||
      row.run_id !== assessment.value.runId ||
      row.run_digest !== assessment.value.runDigest ||
      row.decision !== assessment.value.decision ||
      row.assessed_at !== assessment.value.assessedAt ||
      row.assessment_json !== assessment.json
    ) {
      throw new Error(
        `Stored factory eval assessment ${assessment.value.assessmentId} failed integrity validation.`
      );
    }
    return assessment;
  }

  #verifiedRun(
    claimed: CanonicalFactoryDocument<FactoryEvalRun>
  ): CanonicalFactoryDocument<FactoryEvalRun> {
    const actual = this.#documents.evalRun(claimed.value);
    if (actual.digest !== claimed.digest || actual.json !== claimed.json) {
      throw new Error("Claimed factory eval run is not canonical.");
    }
    return actual;
  }

  #verifiedAssessment(
    claimed: CanonicalFactoryDocument<FactoryEvalAssessment>
  ): CanonicalFactoryDocument<FactoryEvalAssessment> {
    const actual = this.#documents.evalAssessment(claimed.value);
    if (actual.digest !== claimed.digest || actual.json !== claimed.json) {
      throw new Error("Claimed factory eval assessment is not canonical.");
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
  run: CanonicalFactoryDocument<FactoryEvalRun>,
  assessment: CanonicalFactoryDocument<FactoryEvalAssessment>
): FactoryEvalSnapshot {
  return {
    run: run.value,
    runDigest: run.digest,
    assessment: assessment.value,
    assessmentDigest: assessment.digest
  };
}

function parseJson(value: unknown, label: string): unknown {
  if (typeof value !== "string") throw new Error(`Stored ${label} is not text.`);
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error(`Stored ${label} is not valid JSON.`, { cause: error });
  }
}
