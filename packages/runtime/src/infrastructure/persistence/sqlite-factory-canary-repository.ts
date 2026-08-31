import { DatabaseSync } from "node:sqlite";

import type { FactoryCanaryApproval, FactoryCanaryCohort, Sha256Digest } from "@agentlab/contracts";

import type {
  FactoryCanaryRepository,
  FactoryCanarySnapshot
} from "../../domain/factory-canary-repository.js";
import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../../domain/factory-documents.js";
import {
  assertFactoryCanaryAuthorization,
  assertFactoryCanarySnapshot
} from "../../domain/factory-evaluation-integrity.js";
import type { FactoryEvaluationRepository } from "../../domain/factory-evaluation-repository.js";
import { NodeFactoryDocumentCodec } from "./canonical-factory-documents.js";
import { openSqliteDatabase, type SqliteDatabaseOptions } from "./sqlite-database.js";

interface CanaryApprovalRow {
  readonly approval_id: unknown;
  readonly approval_digest: unknown;
  readonly assessment_digest: unknown;
  readonly challenger_candidate_digest: unknown;
  readonly stage: unknown;
  readonly actor_id: unknown;
  readonly occurred_at: unknown;
  readonly expires_at: unknown;
  readonly approval_json: unknown;
}

interface CanaryCohortRow {
  readonly cohort_id: unknown;
  readonly cohort_digest: unknown;
  readonly assessment_digest: unknown;
  readonly run_digest: unknown;
  readonly approval_digest: unknown;
  readonly challenger_candidate_digest: unknown;
  readonly stage: unknown;
  readonly issued_at: unknown;
  readonly expires_at: unknown;
  readonly cohort_json: unknown;
}

const APPROVAL_COLUMNS = `
  approval_id, approval_digest, assessment_digest, challenger_candidate_digest,
  stage, actor_id, occurred_at, expires_at, approval_json
`;

const COHORT_COLUMNS = `
  cohort_id, cohort_digest, assessment_digest, run_digest, approval_digest, challenger_candidate_digest,
  stage, issued_at, expires_at, cohort_json
`;

export interface SqliteFactoryCanaryRepositoryOptions extends SqliteDatabaseOptions {
  readonly documents?: FactoryDocumentCodec;
  readonly evaluations: Pick<FactoryEvaluationRepository, "findByAssessmentDigest">;
}

/** SQLite-backed one-assessment/one-human-approval/one-cohort authority journal. */
export class SqliteFactoryCanaryRepository implements FactoryCanaryRepository {
  readonly #database: DatabaseSync;
  readonly #documents: FactoryDocumentCodec;
  readonly #evaluations: Pick<FactoryEvaluationRepository, "findByAssessmentDigest">;

  public constructor(databasePath: string, options: SqliteFactoryCanaryRepositoryOptions) {
    this.#database = openSqliteDatabase(databasePath, options);
    this.#documents = options.documents ?? new NodeFactoryDocumentCodec();
    this.#evaluations = options.evaluations;
  }

  public async authorize(
    approvalClaim: CanonicalFactoryDocument<FactoryCanaryApproval>,
    cohortClaim: CanonicalFactoryDocument<FactoryCanaryCohort>
  ): Promise<FactoryCanarySnapshot> {
    const approval = this.#verifiedApproval(approvalClaim);
    const cohort = this.#verifiedCohort(cohortClaim);
    const evaluation = await this.#evaluations.findByAssessmentDigest(
      approval.value.assessmentDigest
    );
    if (evaluation === null) {
      throw new Error("Factory canary approval is missing its eval assessment.");
    }
    assertFactoryCanaryAuthorization(evaluation, approval, cohort, this.#documents);
    return this.#inTransaction(() => {
      this.#database
        .prepare(
          `INSERT INTO factory_canary_approvals (
            approval_id, approval_digest, assessment_digest, challenger_candidate_digest,
            stage, actor_id, occurred_at, expires_at, approval_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          approval.value.approvalId,
          approval.digest,
          approval.value.assessmentDigest,
          approval.value.challengerCandidateDigest,
          approval.value.stage,
          approval.value.actor.id,
          approval.value.occurredAt,
          approval.value.expiresAt,
          approval.json
        );
      this.#database
        .prepare(
          `INSERT INTO factory_canary_cohorts (
            cohort_id, cohort_digest, assessment_digest, run_digest, approval_digest,
            challenger_candidate_digest, stage, issued_at, expires_at, cohort_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          cohort.value.cohortId,
          cohort.digest,
          cohort.value.assessmentDigest,
          cohort.value.runDigest,
          cohort.value.approvalDigest,
          cohort.value.challengerCandidateDigest,
          cohort.value.stage,
          cohort.value.issuedAt,
          cohort.value.expiresAt,
          cohort.json
        );
      return snapshotFrom(approval, cohort);
    });
  }

  public findByAssessmentDigest(
    assessmentDigest: Sha256Digest
  ): Promise<FactoryCanarySnapshot | null> {
    const approvalRow = this.#database
      .prepare(
        `SELECT ${APPROVAL_COLUMNS}
         FROM factory_canary_approvals
         WHERE assessment_digest = ?`
      )
      .get(assessmentDigest) as CanaryApprovalRow | undefined;
    return approvalRow === undefined
      ? Promise.resolve(null)
      : this.#snapshot(this.#approvalFromRow(approvalRow));
  }

  public findByCohortDigest(cohortDigest: Sha256Digest): Promise<FactoryCanarySnapshot | null> {
    const cohortRow = this.#database
      .prepare(
        `SELECT ${COHORT_COLUMNS}
         FROM factory_canary_cohorts
         WHERE cohort_digest = ?`
      )
      .get(cohortDigest) as CanaryCohortRow | undefined;
    if (cohortRow === undefined) return Promise.resolve(null);
    const cohort = this.#cohortFromRow(cohortRow);
    const approvalRow = this.#database
      .prepare(
        `SELECT ${APPROVAL_COLUMNS}
         FROM factory_canary_approvals
         WHERE approval_digest = ?`
      )
      .get(cohort.value.approvalDigest) as CanaryApprovalRow | undefined;
    if (approvalRow === undefined) {
      throw new Error("Stored factory canary cohort is missing its human approval.");
    }
    return this.#validatedSnapshot(this.#approvalFromRow(approvalRow), cohort);
  }

  public close(): void {
    this.#database.close();
  }

  async #snapshot(
    approval: CanonicalFactoryDocument<FactoryCanaryApproval>
  ): Promise<FactoryCanarySnapshot> {
    const cohortRow = this.#database
      .prepare(
        `SELECT ${COHORT_COLUMNS}
         FROM factory_canary_cohorts
         WHERE approval_digest = ?`
      )
      .get(approval.digest) as CanaryCohortRow | undefined;
    if (cohortRow === undefined) throw new Error("Stored factory canary approval has no cohort.");
    return this.#validatedSnapshot(approval, this.#cohortFromRow(cohortRow));
  }

  async #validatedSnapshot(
    approval: CanonicalFactoryDocument<FactoryCanaryApproval>,
    cohort: CanonicalFactoryDocument<FactoryCanaryCohort>
  ): Promise<FactoryCanarySnapshot> {
    const evaluation = await this.#evaluations.findByAssessmentDigest(
      approval.value.assessmentDigest
    );
    if (evaluation === null)
      throw new Error("Stored factory canary is missing its eval assessment.");
    const snapshot = snapshotFrom(approval, cohort);
    assertFactoryCanarySnapshot(evaluation, snapshot, this.#documents);
    return snapshot;
  }

  #approvalFromRow(row: CanaryApprovalRow): CanonicalFactoryDocument<FactoryCanaryApproval> {
    const approval = this.#documents.canaryApproval(
      parseJson(row.approval_json, "factory canary approval")
    );
    if (
      row.approval_id !== approval.value.approvalId ||
      row.approval_digest !== approval.digest ||
      row.assessment_digest !== approval.value.assessmentDigest ||
      row.challenger_candidate_digest !== approval.value.challengerCandidateDigest ||
      row.stage !== approval.value.stage ||
      row.actor_id !== approval.value.actor.id ||
      row.occurred_at !== approval.value.occurredAt ||
      row.expires_at !== approval.value.expiresAt ||
      row.approval_json !== approval.json
    ) {
      throw new Error(
        `Stored factory canary approval ${approval.value.approvalId} failed integrity validation.`
      );
    }
    return approval;
  }

  #cohortFromRow(row: CanaryCohortRow): CanonicalFactoryDocument<FactoryCanaryCohort> {
    const cohort = this.#documents.canaryCohort(
      parseJson(row.cohort_json, "factory canary cohort")
    );
    if (
      row.cohort_id !== cohort.value.cohortId ||
      row.cohort_digest !== cohort.digest ||
      row.assessment_digest !== cohort.value.assessmentDigest ||
      row.run_digest !== cohort.value.runDigest ||
      row.approval_digest !== cohort.value.approvalDigest ||
      row.challenger_candidate_digest !== cohort.value.challengerCandidateDigest ||
      row.stage !== cohort.value.stage ||
      row.issued_at !== cohort.value.issuedAt ||
      row.expires_at !== cohort.value.expiresAt ||
      row.cohort_json !== cohort.json
    ) {
      throw new Error(
        `Stored factory canary cohort ${cohort.value.cohortId} failed integrity validation.`
      );
    }
    return cohort;
  }

  #verifiedApproval(
    claimed: CanonicalFactoryDocument<FactoryCanaryApproval>
  ): CanonicalFactoryDocument<FactoryCanaryApproval> {
    const actual = this.#documents.canaryApproval(claimed.value);
    if (actual.digest !== claimed.digest || actual.json !== claimed.json) {
      throw new Error("Claimed factory canary approval is not canonical.");
    }
    return actual;
  }

  #verifiedCohort(
    claimed: CanonicalFactoryDocument<FactoryCanaryCohort>
  ): CanonicalFactoryDocument<FactoryCanaryCohort> {
    const actual = this.#documents.canaryCohort(claimed.value);
    if (actual.digest !== claimed.digest || actual.json !== claimed.json) {
      throw new Error("Claimed factory canary cohort is not canonical.");
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
  approval: CanonicalFactoryDocument<FactoryCanaryApproval>,
  cohort: CanonicalFactoryDocument<FactoryCanaryCohort>
): FactoryCanarySnapshot {
  return {
    approval: approval.value,
    approvalDigest: approval.digest,
    cohort: cohort.value,
    cohortDigest: cohort.digest
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
