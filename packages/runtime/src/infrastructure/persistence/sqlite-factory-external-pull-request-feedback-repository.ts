import { DatabaseSync } from "node:sqlite";

import type {
  FactoryExternalPullRequestFeedbackEvent,
  FactoryExternalPullRequestFeedbackRecord,
  FactoryExternalPullRequestFeedbackRun,
  Sha256Digest
} from "@agentlab/contracts";

import {
  assertExternalPullRequestFeedbackEvent,
  assertExternalPullRequestFeedbackRecord,
  assertExternalPullRequestFeedbackRegistration,
  assertExternalPullRequestFeedbackRun
} from "../../domain/factory-external-pull-request-feedback-integrity.js";
import type {
  FactoryExternalPullRequestFeedbackCandidate,
  FactoryExternalPullRequestFeedbackJournalSnapshot,
  FactoryExternalPullRequestFeedbackRepository
} from "../../domain/factory-external-pull-request-feedback-repository.js";
import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../../domain/factory-documents.js";
import { NodeFactoryDocumentCodec } from "./canonical-factory-documents.js";
import { openSqliteDatabase, type SqliteDatabaseOptions } from "./sqlite-database.js";

interface RunRow {
  readonly publication_run_id: unknown;
  readonly run_digest: unknown;
  readonly repository_id: unknown;
  readonly pull_request_number: unknown;
  readonly review_run_id: unknown;
  readonly review_run_digest: unknown;
  readonly bundle_digest: unknown;
  readonly review_policy_digest: unknown;
  readonly feedback_policy_digest: unknown;
  readonly expected_base_revision: unknown;
  readonly expected_head_revision: unknown;
  readonly body_digest: unknown;
  readonly created_at: unknown;
  readonly deadline_at: unknown;
  readonly correlation_id: unknown;
  readonly run_json: unknown;
}

interface CandidateRow {
  readonly run_digest: unknown;
  readonly run_json: unknown;
  readonly bundle_digest: unknown;
  readonly bundle_json: unknown;
}

interface EventRow {
  readonly event_digest: unknown;
  readonly event_json: unknown;
}

interface RecordRow {
  readonly record_digest: unknown;
  readonly record_json: unknown;
}

const RUN_COLUMNS = `
  publication_run_id, run_digest, repository_id, pull_request_number, review_run_id,
  review_run_digest, bundle_digest, review_policy_digest, feedback_policy_digest,
  expected_base_revision, expected_head_revision, body_digest, created_at, deadline_at,
  correlation_id, run_json
`;

export interface SqliteFactoryExternalPullRequestFeedbackRepositoryOptions extends SqliteDatabaseOptions {
  readonly documents?: FactoryDocumentCodec;
}

/** Completed-review projection plus an immutable, append-only feedback publication journal. */
export class SqliteFactoryExternalPullRequestFeedbackRepository implements FactoryExternalPullRequestFeedbackRepository {
  readonly #database: DatabaseSync;
  readonly #documents: FactoryDocumentCodec;

  public constructor(
    databasePath: string,
    options: SqliteFactoryExternalPullRequestFeedbackRepositoryOptions = {}
  ) {
    this.#database = openSqliteDatabase(databasePath, options);
    this.#documents = options.documents ?? new NodeFactoryDocumentCodec();
  }

  public listCompletedReviews(input: {
    readonly repositoryId: string;
    readonly reviewPolicyDigest: Sha256Digest;
    readonly limit: number;
  }): Promise<readonly FactoryExternalPullRequestFeedbackCandidate[]> {
    assertLimit(input.limit);
    const rows = this.#database
      .prepare(
        `SELECT review.run_digest, review.run_json, bundle.bundle_digest, bundle.bundle_json
         FROM factory_external_pr_review_runs AS review
         JOIN factory_external_pr_review_bundles AS bundle ON bundle.run_id = review.run_id
         WHERE review.repository_id = ? AND review.review_policy_digest = ?
           AND EXISTS (
             SELECT 1 FROM factory_external_pr_review_events AS event
             WHERE event.run_id = review.run_id AND event.kind = 'completed'
           )
           AND NOT EXISTS (
             SELECT 1 FROM factory_external_pr_feedback_runs AS feedback
             WHERE feedback.bundle_digest = bundle.bundle_digest
           )
         ORDER BY review.created_at, review.run_id
         LIMIT ?`
      )
      .all(input.repositoryId, input.reviewPolicyDigest, input.limit) as unknown as CandidateRow[];
    return Promise.resolve(rows.map((row) => this.#candidate(row)));
  }

  public listActive(input: {
    readonly repositoryId: string;
    readonly feedbackPolicyDigest: Sha256Digest;
    readonly limit: number;
  }): Promise<readonly FactoryExternalPullRequestFeedbackJournalSnapshot[]> {
    assertLimit(input.limit);
    const rows = this.#database
      .prepare(
        `SELECT ${RUN_COLUMNS}
         FROM factory_external_pr_feedback_runs AS run
         WHERE run.repository_id = ? AND run.feedback_policy_digest = ?
           AND (
             SELECT event.to_state FROM factory_external_pr_feedback_events AS event
             WHERE event.publication_run_id = run.publication_run_id
             ORDER BY event.sequence DESC LIMIT 1
           ) IN ('ready', 'remote-verified', 'publication-active', 'recorded')
         ORDER BY run.created_at, run.publication_run_id
         LIMIT ?`
      )
      .all(input.repositoryId, input.feedbackPolicyDigest, input.limit) as unknown as RunRow[];
    return Promise.resolve(rows.map((row) => this.#snapshot(this.#runFromRow(row))));
  }

  public findByBundle(
    bundleDigest: Sha256Digest
  ): Promise<FactoryExternalPullRequestFeedbackJournalSnapshot | null> {
    const row = this.#database
      .prepare(
        `SELECT ${RUN_COLUMNS} FROM factory_external_pr_feedback_runs WHERE bundle_digest = ?`
      )
      .get(bundleDigest) as RunRow | undefined;
    return Promise.resolve(row === undefined ? null : this.#snapshot(this.#runFromRow(row)));
  }

  public register(
    runClaim: CanonicalFactoryDocument<FactoryExternalPullRequestFeedbackRun>,
    eventClaim: CanonicalFactoryDocument<FactoryExternalPullRequestFeedbackEvent>
  ): Promise<FactoryExternalPullRequestFeedbackJournalSnapshot> {
    const run = this.#verifiedRun(runClaim);
    const event = this.#verifiedEvent(eventClaim);
    assertExternalPullRequestFeedbackRun(run, this.#documents);
    assertExternalPullRequestFeedbackRegistration(run, event);
    return Promise.resolve(
      this.#transaction(() => {
        this.#assertCompletedReview(run);
        this.#database
          .prepare(
            `INSERT INTO factory_external_pr_feedback_runs (
              publication_run_id, run_digest, repository_id, pull_request_number, review_run_id,
              review_run_digest, bundle_digest, review_policy_digest, feedback_policy_digest,
              expected_base_revision, expected_head_revision, body_digest, created_at, deadline_at,
              correlation_id, run_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            run.value.publicationRunId,
            run.digest,
            run.value.repositoryId,
            run.value.pullRequestNumber,
            run.value.reviewRunId,
            run.value.reviewRunDigest,
            run.value.bundleDigest,
            run.value.reviewPolicyDigest,
            run.value.feedbackPolicyDigest,
            run.value.expectedBaseRevision,
            run.value.expectedHeadRevision,
            run.value.bodyArtifact.digest,
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
    eventClaim: CanonicalFactoryDocument<FactoryExternalPullRequestFeedbackEvent>
  ): Promise<FactoryExternalPullRequestFeedbackJournalSnapshot | null> {
    const event = this.#verifiedEvent(eventClaim);
    if (event.value.kind === "publication-recorded") {
      throw new Error(
        "External PR feedback records must be persisted atomically with their event."
      );
    }
    return Promise.resolve(
      this.#transaction(() => {
        const run = this.#findRun(event.value.publicationRunId);
        if (run?.digest !== event.value.runDigest) return null;
        const history = this.#readEvents(run);
        assertExternalPullRequestFeedbackEvent(run, event, history);
        const record = this.#readRecord(run, history);
        if (
          event.value.kind === "completed" &&
          record?.remoteReviewId !== event.value.remoteReviewId
        ) {
          throw new Error("External PR feedback completion disagrees with its remote record.");
        }
        this.#insertEvent(event);
        return snapshotFrom(run, [...history, event], record);
      })
    );
  }

  public record(
    eventClaim: CanonicalFactoryDocument<FactoryExternalPullRequestFeedbackEvent>,
    recordClaim: CanonicalFactoryDocument<FactoryExternalPullRequestFeedbackRecord>
  ): Promise<FactoryExternalPullRequestFeedbackJournalSnapshot | null> {
    const event = this.#verifiedEvent(eventClaim);
    const record = this.#verifiedRecord(recordClaim);
    if (event.value.kind !== "publication-recorded") {
      throw new Error("External PR feedback recording requires a publication event.");
    }
    return Promise.resolve(
      this.#transaction(() => {
        const run = this.#findRun(event.value.publicationRunId);
        if (run?.digest !== event.value.runDigest) return null;
        const history = this.#readEvents(run);
        assertExternalPullRequestFeedbackEvent(run, event, history);
        assertExternalPullRequestFeedbackRecord(run, event, record);
        this.#database
          .prepare(
            `INSERT INTO factory_external_pr_feedback_records (
              publication_run_id, run_digest, record_digest, repository_id,
              pull_request_number, remote_review_id, record_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            run.value.publicationRunId,
            run.digest,
            record.digest,
            record.value.repositoryId,
            record.value.pullRequestNumber,
            record.value.remoteReviewId,
            record.json
          );
        this.#insertEvent(event);
        return snapshotFrom(run, [...history, event], record.value);
      })
    );
  }

  public close(): void {
    this.#database.close();
  }

  #candidate(row: CandidateRow): FactoryExternalPullRequestFeedbackCandidate {
    const reviewRun = this.#documents.externalPullRequestReviewRun(
      parseJson(row.run_json, "review run")
    );
    const bundle = this.#documents.externalPullRequestReviewBundle(
      parseJson(row.bundle_json, "review bundle")
    );
    if (row.run_digest !== reviewRun.digest || row.bundle_digest !== bundle.digest) {
      throw new Error("Stored external PR feedback candidate failed digest validation.");
    }
    return {
      reviewRun: reviewRun.value,
      reviewRunDigest: reviewRun.digest,
      bundle: bundle.value,
      bundleDigest: bundle.digest
    };
  }

  #assertCompletedReview(
    run: CanonicalFactoryDocument<FactoryExternalPullRequestFeedbackRun>
  ): void {
    const row = this.#database
      .prepare(
        `SELECT review.run_digest, review.run_json, bundle.bundle_digest, bundle.bundle_json
         FROM factory_external_pr_review_runs AS review
         JOIN factory_external_pr_review_bundles AS bundle ON bundle.run_id = review.run_id
         WHERE review.run_id = ? AND review.repository_id = ? AND review.pull_request_number = ?
           AND review.review_policy_digest = ? AND bundle.bundle_digest = ?
           AND EXISTS (
             SELECT 1 FROM factory_external_pr_review_events AS event
             WHERE event.run_id = review.run_id AND event.kind = 'completed'
           )`
      )
      .get(
        run.value.reviewRunId,
        run.value.repositoryId,
        run.value.pullRequestNumber,
        run.value.reviewPolicyDigest,
        run.value.bundleDigest
      ) as CandidateRow | undefined;
    if (
      row?.run_digest !== run.value.reviewRunDigest ||
      row.run_json !== this.#documents.externalPullRequestReviewRun(run.value.reviewRun).json ||
      row.bundle_digest !== run.value.bundleDigest ||
      row.bundle_json !== this.#documents.externalPullRequestReviewBundle(run.value.bundle).json
    ) {
      throw new Error("External PR feedback run is not rooted in one completed review bundle.");
    }
  }

  #snapshot(
    run: CanonicalFactoryDocument<FactoryExternalPullRequestFeedbackRun>
  ): FactoryExternalPullRequestFeedbackJournalSnapshot {
    const history = this.#readEvents(run);
    return snapshotFrom(run, history, this.#readRecord(run, history));
  }

  #findRun(runId: string): CanonicalFactoryDocument<FactoryExternalPullRequestFeedbackRun> | null {
    const row = this.#database
      .prepare(
        `SELECT ${RUN_COLUMNS} FROM factory_external_pr_feedback_runs WHERE publication_run_id = ?`
      )
      .get(runId) as RunRow | undefined;
    return row === undefined ? null : this.#runFromRow(row);
  }

  #runFromRow(row: RunRow): CanonicalFactoryDocument<FactoryExternalPullRequestFeedbackRun> {
    const run = this.#documents.externalPullRequestFeedbackRun(parseJson(row.run_json, "run"));
    assertExternalPullRequestFeedbackRun(run, this.#documents);
    const expected = [
      row.publication_run_id,
      row.run_digest,
      row.repository_id,
      row.pull_request_number,
      row.review_run_id,
      row.review_run_digest,
      row.bundle_digest,
      row.review_policy_digest,
      row.feedback_policy_digest,
      row.expected_base_revision,
      row.expected_head_revision,
      row.body_digest,
      row.created_at,
      row.deadline_at,
      row.correlation_id,
      row.run_json
    ];
    const actual = [
      run.value.publicationRunId,
      run.digest,
      run.value.repositoryId,
      run.value.pullRequestNumber,
      run.value.reviewRunId,
      run.value.reviewRunDigest,
      run.value.bundleDigest,
      run.value.reviewPolicyDigest,
      run.value.feedbackPolicyDigest,
      run.value.expectedBaseRevision,
      run.value.expectedHeadRevision,
      run.value.bodyArtifact.digest,
      run.value.createdAt,
      run.value.deadlineAt,
      run.value.correlationId,
      run.json
    ];
    if (expected.some((value, index) => value !== actual[index])) {
      throw new Error(
        `Stored external PR feedback run ${run.value.publicationRunId} failed integrity validation.`
      );
    }
    return run;
  }

  #readEvents(
    run: CanonicalFactoryDocument<FactoryExternalPullRequestFeedbackRun>
  ): readonly CanonicalFactoryDocument<FactoryExternalPullRequestFeedbackEvent>[] {
    const rows = this.#database
      .prepare(
        `SELECT event_digest, event_json FROM factory_external_pr_feedback_events
         WHERE publication_run_id = ? ORDER BY sequence LIMIT 17`
      )
      .all(run.value.publicationRunId) as unknown as EventRow[];
    if (rows.length < 1 || rows.length > 16) {
      throw new Error("Stored external PR feedback event count is invalid.");
    }
    const history: CanonicalFactoryDocument<FactoryExternalPullRequestFeedbackEvent>[] = [];
    for (const row of rows) {
      const event = this.#documents.externalPullRequestFeedbackEvent(
        parseJson(row.event_json, "event")
      );
      if (row.event_digest !== event.digest) {
        throw new Error("Stored external PR feedback event failed digest validation.");
      }
      if (history.length === 0) assertExternalPullRequestFeedbackRegistration(run, event);
      else assertExternalPullRequestFeedbackEvent(run, event, history);
      history.push(event);
    }
    return history;
  }

  #readRecord(
    run: CanonicalFactoryDocument<FactoryExternalPullRequestFeedbackRun>,
    history: readonly CanonicalFactoryDocument<FactoryExternalPullRequestFeedbackEvent>[]
  ): FactoryExternalPullRequestFeedbackRecord | null {
    const row = this.#database
      .prepare(
        `SELECT record_digest, record_json FROM factory_external_pr_feedback_records
         WHERE publication_run_id = ?`
      )
      .get(run.value.publicationRunId) as RecordRow | undefined;
    if (row === undefined) return null;
    const record = this.#documents.externalPullRequestFeedbackRecord(
      parseJson(row.record_json, "record")
    );
    const event = history.find(({ value }) => value.kind === "publication-recorded");
    if (row.record_digest !== record.digest || event === undefined) {
      throw new Error("Stored external PR feedback record failed digest validation.");
    }
    assertExternalPullRequestFeedbackRecord(run, event, record);
    return record.value;
  }

  #insertEvent(event: CanonicalFactoryDocument<FactoryExternalPullRequestFeedbackEvent>): void {
    const recordDigest =
      event.value.kind === "publication-recorded" ? event.value.recordDigest : null;
    const recordArtifact =
      event.value.kind === "publication-recorded"
        ? JSON.stringify(event.value.recordArtifact)
        : null;
    const remoteReviewId = event.value.kind === "completed" ? event.value.remoteReviewId : null;
    this.#database
      .prepare(
        `INSERT INTO factory_external_pr_feedback_events (
          event_id, publication_run_id, run_digest, sequence, event_digest,
          previous_event_digest, kind, from_state, to_state, record_digest,
          record_artifact_json, remote_review_id, occurred_at, reason_code,
          correlation_id, event_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.value.eventId,
        event.value.publicationRunId,
        event.value.runDigest,
        event.value.sequence,
        event.digest,
        event.value.previousEventDigest,
        event.value.kind,
        event.value.from,
        event.value.to,
        recordDigest,
        recordArtifact,
        remoteReviewId,
        event.value.occurredAt,
        event.value.reasonCode,
        event.value.correlationId,
        event.json
      );
  }

  #verifiedRun(claim: CanonicalFactoryDocument<FactoryExternalPullRequestFeedbackRun>) {
    const actual = this.#documents.externalPullRequestFeedbackRun(claim.value);
    assertClaim(claim, actual, "run");
    return actual;
  }

  #verifiedEvent(claim: CanonicalFactoryDocument<FactoryExternalPullRequestFeedbackEvent>) {
    const actual = this.#documents.externalPullRequestFeedbackEvent(claim.value);
    assertClaim(claim, actual, "event");
    return actual;
  }

  #verifiedRecord(claim: CanonicalFactoryDocument<FactoryExternalPullRequestFeedbackRecord>) {
    const actual = this.#documents.externalPullRequestFeedbackRecord(claim.value);
    assertClaim(claim, actual, "record");
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
      } catch (rollbackError: unknown) {
        throw new AggregateError(
          [error, rollbackError],
          "External PR feedback transaction rollback failed.",
          { cause: error }
        );
      }
      throw error;
    }
  }
}

function snapshotFrom(
  run: CanonicalFactoryDocument<FactoryExternalPullRequestFeedbackRun>,
  history: readonly CanonicalFactoryDocument<FactoryExternalPullRequestFeedbackEvent>[],
  record: FactoryExternalPullRequestFeedbackRecord | null
): FactoryExternalPullRequestFeedbackJournalSnapshot {
  const last = history.at(-1);
  if (last === undefined) throw new Error("External PR feedback journal has no event.");
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

function assertClaim<Value>(
  claim: CanonicalFactoryDocument<Value>,
  actual: CanonicalFactoryDocument<Value>,
  label: string
): void {
  if (claim.digest !== actual.digest || claim.json !== actual.json) {
    throw new Error(`External PR feedback ${label} claim is not canonical.`);
  }
}

function parseJson(value: unknown, label: string): unknown {
  if (typeof value !== "string")
    throw new Error(`Stored external PR feedback ${label} is not text.`);
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error(`Stored external PR feedback ${label} is invalid JSON.`, { cause: error });
  }
}

function assertLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) {
    throw new Error("External PR feedback queue limit must be between one and ten.");
  }
}
