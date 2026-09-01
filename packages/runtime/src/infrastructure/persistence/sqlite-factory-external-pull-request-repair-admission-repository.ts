import { DatabaseSync } from "node:sqlite";

import type {
  FactoryExternalPullRequestRepairAdmissionPolicy,
  FactoryExternalPullRequestRepairAuthorization,
  FactoryExternalPullRequestRepairDecision,
  Sha256Digest
} from "@agentlab/contracts";

import {
  assertExternalPullRequestRepairAdmissionCandidate,
  assertExternalPullRequestRepairDecision
} from "../../domain/factory-external-pull-request-repair-admission-integrity.js";
import type {
  FactoryExternalPullRequestRepairAdmissionCandidate,
  FactoryExternalPullRequestRepairAdmissionRepository,
  FactoryExternalPullRequestRepairAdmissionSnapshot,
  FactoryExternalPullRequestRepairAdmissionWriteResult
} from "../../domain/factory-external-pull-request-repair-admission-repository.js";
import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../../domain/factory-documents.js";
import { NodeFactoryDocumentCodec } from "./canonical-factory-documents.js";
import { openSqliteDatabase, type SqliteDatabaseOptions } from "./sqlite-database.js";

interface CandidateRow {
  readonly feedback_run_digest: unknown;
  readonly feedback_run_json: unknown;
  readonly feedback_record_digest: unknown;
  readonly feedback_record_json: unknown;
}

interface DecisionRow {
  readonly decision_digest: unknown;
  readonly decision_json: unknown;
  readonly authorization_digest: unknown;
  readonly authorization_json: unknown;
}

export interface SqliteFactoryExternalPullRequestRepairAdmissionRepositoryOptions extends SqliteDatabaseOptions {
  readonly documents?: FactoryDocumentCodec;
  readonly now?: () => string;
}

/** Completed-feedback projection plus immutable, atomic repair admission decisions. */
export class SqliteFactoryExternalPullRequestRepairAdmissionRepository implements FactoryExternalPullRequestRepairAdmissionRepository {
  readonly #database: DatabaseSync;
  readonly #documents: FactoryDocumentCodec;
  readonly #now: () => string;

  public constructor(
    databasePath: string,
    options: SqliteFactoryExternalPullRequestRepairAdmissionRepositoryOptions = {}
  ) {
    this.#database = openSqliteDatabase(databasePath, options);
    this.#documents = options.documents ?? new NodeFactoryDocumentCodec();
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  public listCandidates(input: {
    readonly repositoryId: string;
    readonly reviewPolicyDigest: Sha256Digest;
    readonly feedbackPolicyDigest: Sha256Digest;
    readonly admissionPolicyDigest: Sha256Digest;
    readonly limit: number;
  }): Promise<readonly FactoryExternalPullRequestRepairAdmissionCandidate[]> {
    assertLimit(input.limit);
    const rows = this.#database
      .prepare(
        `SELECT
           feedback.run_digest AS feedback_run_digest,
           feedback.run_json AS feedback_run_json,
           record.record_digest AS feedback_record_digest,
           record.record_json AS feedback_record_json
         FROM factory_external_pr_feedback_runs AS feedback
         JOIN factory_external_pr_feedback_records AS record
           ON record.publication_run_id = feedback.publication_run_id
         WHERE feedback.repository_id = ?
           AND feedback.review_policy_digest = ?
           AND feedback.feedback_policy_digest = ?
           AND EXISTS (
             SELECT 1 FROM factory_external_pr_feedback_events AS event
             WHERE event.publication_run_id = feedback.publication_run_id
               AND event.kind = 'completed'
           )
           AND NOT EXISTS (
             SELECT 1 FROM factory_external_pr_repair_decisions AS decision
             WHERE decision.bundle_digest = feedback.bundle_digest
               AND decision.admission_policy_digest = ?
           )
         ORDER BY feedback.created_at, feedback.publication_run_id
         LIMIT ?`
      )
      .all(
        input.repositoryId,
        input.reviewPolicyDigest,
        input.feedbackPolicyDigest,
        input.admissionPolicyDigest,
        input.limit
      ) as unknown as CandidateRow[];
    return Promise.resolve(rows.map((row) => this.#candidate(row)));
  }

  public findByBundle(
    bundleDigest: Sha256Digest,
    admissionPolicyDigest: Sha256Digest
  ): Promise<FactoryExternalPullRequestRepairAdmissionSnapshot | null> {
    const row = this.#database
      .prepare(
        `SELECT
           decision.decision_digest,
           decision.decision_json,
           authorization.authorization_digest,
           authorization.authorization_json
         FROM factory_external_pr_repair_decisions AS decision
         LEFT JOIN factory_external_pr_repair_authorizations AS authorization
           ON authorization.decision_id = decision.decision_id
         WHERE decision.bundle_digest = ? AND decision.admission_policy_digest = ?`
      )
      .get(bundleDigest, admissionPolicyDigest) as DecisionRow | undefined;
    return Promise.resolve(row === undefined ? null : this.#snapshot(row));
  }

  public decide(
    policyClaim: CanonicalFactoryDocument<FactoryExternalPullRequestRepairAdmissionPolicy>,
    decisionClaim: CanonicalFactoryDocument<FactoryExternalPullRequestRepairDecision>,
    authorizationClaim: CanonicalFactoryDocument<FactoryExternalPullRequestRepairAuthorization> | null,
    candidate: FactoryExternalPullRequestRepairAdmissionCandidate
  ): Promise<FactoryExternalPullRequestRepairAdmissionWriteResult> {
    const policy = this.#documents.externalPullRequestRepairAdmissionPolicy(policyClaim.value);
    const decision = this.#documents.externalPullRequestRepairDecision(decisionClaim.value);
    const authorization =
      authorizationClaim === null
        ? null
        : this.#documents.externalPullRequestRepairAuthorization(authorizationClaim.value);
    if (
      policy.digest !== policyClaim.digest ||
      decision.digest !== decisionClaim.digest ||
      authorization?.digest !== authorizationClaim?.digest
    ) {
      throw new Error("External repair admission write contains a non-canonical document.");
    }
    assertExternalPullRequestRepairDecision(
      policy,
      candidate,
      decision,
      authorization,
      this.#documents,
      this.#now()
    );
    return Promise.resolve(
      this.#transaction(() => {
        const existing = this.#findByBundle(decision.value.bundleDigest, policy.digest);
        if (existing !== null) return { status: "existing" as const, ...existing };
        this.#assertCandidatePresent(candidate);
        this.#database
          .prepare(
            `INSERT INTO factory_external_pr_repair_decisions (
               decision_id, decision_digest, repository_id, pull_request_number,
               review_run_id, review_run_digest, bundle_digest, feedback_publication_run_id,
               feedback_publication_run_digest, feedback_record_digest, admission_policy_digest,
               decision_status, authorization_digest, created_at, correlation_id, decision_json
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            decision.value.decisionId,
            decision.digest,
            decision.value.repositoryId,
            decision.value.pullRequestNumber,
            decision.value.reviewRunId,
            decision.value.reviewRunDigest,
            decision.value.bundleDigest,
            decision.value.feedbackPublicationRunId,
            decision.value.feedbackPublicationRunDigest,
            decision.value.feedbackRecordDigest,
            decision.value.admissionPolicyDigest,
            decision.value.status,
            decision.value.authorizationDigest,
            decision.value.createdAt,
            decision.value.correlationId,
            decision.json
          );
        if (authorization !== null) {
          this.#database
            .prepare(
              `INSERT INTO factory_external_pr_repair_authorizations (
                 authorization_id, authorization_digest, decision_id, repository_id,
                 pull_request_number, review_run_id, bundle_digest, feedback_record_digest,
                 admission_policy_digest, expected_head_revision, expires_at, authorization_json
               ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .run(
              authorization.value.authorizationId,
              authorization.digest,
              decision.value.decisionId,
              authorization.value.repositoryId,
              authorization.value.pullRequestNumber,
              authorization.value.reviewRunId,
              authorization.value.bundleDigest,
              authorization.value.feedbackRecordDigest,
              authorization.value.admissionPolicyDigest,
              authorization.value.expectedHeadRevision,
              authorization.value.expiresAt,
              authorization.json
            );
        }
        return {
          status: "created" as const,
          decision: decision.value,
          decisionDigest: decision.digest,
          authorization: authorization?.value ?? null,
          authorizationDigest: authorization?.digest ?? null
        };
      })
    );
  }

  public close(): void {
    this.#database.close();
  }

  #candidate(row: CandidateRow): FactoryExternalPullRequestRepairAdmissionCandidate {
    const run = this.#documents.externalPullRequestFeedbackRun(parseJson(row.feedback_run_json));
    const record = this.#documents.externalPullRequestFeedbackRecord(
      parseJson(row.feedback_record_json)
    );
    if (run.digest !== row.feedback_run_digest || record.digest !== row.feedback_record_digest) {
      throw new Error("Stored external repair candidate failed canonical verification.");
    }
    const candidate = { feedbackRun: run, feedbackRecord: record };
    assertExternalPullRequestRepairAdmissionCandidate(candidate, this.#documents);
    return candidate;
  }

  #snapshot(row: DecisionRow): FactoryExternalPullRequestRepairAdmissionSnapshot {
    const decision = this.#documents.externalPullRequestRepairDecision(
      parseJson(row.decision_json)
    );
    const authorization =
      row.authorization_json === null
        ? null
        : this.#documents.externalPullRequestRepairAuthorization(parseJson(row.authorization_json));
    const authorizationValue = authorization === null ? null : authorization.value;
    const authorizationDigest = authorization === null ? null : authorization.digest;
    if (
      decision.digest !== row.decision_digest ||
      authorizationDigest !== row.authorization_digest ||
      decision.value.authorizationDigest !== authorizationDigest
    ) {
      throw new Error("Stored external repair decision failed canonical verification.");
    }
    return {
      decision: decision.value,
      decisionDigest: decision.digest,
      authorization: authorizationValue,
      authorizationDigest
    };
  }

  #findByBundle(
    bundleDigest: Sha256Digest,
    admissionPolicyDigest: Sha256Digest
  ): FactoryExternalPullRequestRepairAdmissionSnapshot | null {
    const row = this.#database
      .prepare(
        `SELECT
           decision.decision_digest,
           decision.decision_json,
           authorization.authorization_digest,
           authorization.authorization_json
         FROM factory_external_pr_repair_decisions AS decision
         LEFT JOIN factory_external_pr_repair_authorizations AS authorization
           ON authorization.decision_id = decision.decision_id
         WHERE decision.bundle_digest = ? AND decision.admission_policy_digest = ?`
      )
      .get(bundleDigest, admissionPolicyDigest) as DecisionRow | undefined;
    return row === undefined ? null : this.#snapshot(row);
  }

  #assertCandidatePresent(candidate: FactoryExternalPullRequestRepairAdmissionCandidate): void {
    const row = this.#database
      .prepare(
        `SELECT 1
         FROM factory_external_pr_feedback_runs AS feedback
         JOIN factory_external_pr_feedback_records AS record
           ON record.publication_run_id = feedback.publication_run_id
         WHERE feedback.publication_run_id = ?
           AND feedback.run_digest = ?
           AND record.record_digest = ?
           AND EXISTS (
             SELECT 1 FROM factory_external_pr_feedback_events AS event
             WHERE event.publication_run_id = feedback.publication_run_id
               AND event.kind = 'completed'
           )`
      )
      .get(
        candidate.feedbackRun.value.publicationRunId,
        candidate.feedbackRun.digest,
        candidate.feedbackRecord.digest
      );
    if (row === undefined) {
      throw new Error("External repair candidate is not rooted in completed feedback.");
    }
  }

  #transaction<Value>(operation: () => Value): Value {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      this.#database.exec("COMMIT");
      return value;
    } catch (error: unknown) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") throw new Error("External repair admission row is not JSON text.");
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error("External repair admission row contains invalid JSON.", { cause: error });
  }
}

function assertLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("External repair admission query limit is invalid.");
  }
}
