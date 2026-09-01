import { DatabaseSync } from "node:sqlite";

import type {
  FactoryExternalPullRequestReviewBundle,
  FactoryExternalPullRequestReviewEvent,
  FactoryExternalPullRequestReviewRun,
  Sha256Digest
} from "@agentlab/contracts";

import {
  assertExternalPullRequestReviewBundle,
  assertExternalPullRequestReviewEvent,
  assertExternalPullRequestReviewRegistration,
  assertExternalPullRequestReviewRun
} from "../../domain/factory-external-pull-request-review-integrity.js";
import type {
  FactoryExternalPullRequestReviewCandidateEnvelope,
  FactoryExternalPullRequestReviewJournalSnapshot,
  FactoryExternalPullRequestReviewRepository
} from "../../domain/factory-external-pull-request-review-repository.js";
import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../../domain/factory-documents.js";
import { NodeFactoryDocumentCodec } from "./canonical-factory-documents.js";
import { openSqliteDatabase, type SqliteDatabaseOptions } from "./sqlite-database.js";

interface RunRow {
  readonly run_id: unknown;
  readonly run_digest: unknown;
  readonly repository_id: unknown;
  readonly pull_request_number: unknown;
  readonly candidate_digest: unknown;
  readonly discovery_run_id: unknown;
  readonly discovery_run_digest: unknown;
  readonly discovery_snapshot_digest: unknown;
  readonly discovery_policy_digest: unknown;
  readonly review_policy_digest: unknown;
  readonly cost_policy_digest: unknown;
  readonly workspace_id: unknown;
  readonly created_at: unknown;
  readonly deadline_at: unknown;
  readonly correlation_id: unknown;
  readonly run_json: unknown;
}

interface EventRow {
  readonly event_digest: unknown;
  readonly event_json: unknown;
}

interface BundleRow {
  readonly bundle_digest: unknown;
  readonly bundle_json: unknown;
}

interface CandidateRow {
  readonly candidate_digest: unknown;
  readonly candidate_json: unknown;
  readonly discovery_run_id: unknown;
  readonly discovery_run_digest: unknown;
  readonly discovery_snapshot_digest: unknown;
  readonly discovery_policy_digest: unknown;
}

interface CandidateAdmissionRow {
  readonly candidate_json: unknown;
  readonly discovery_run_digest: unknown;
  readonly discovery_snapshot_digest: unknown;
  readonly discovery_policy_digest: unknown;
}

const RUN_COLUMNS = `
  run_id, run_digest, repository_id, pull_request_number, candidate_digest,
  discovery_run_id, discovery_run_digest, discovery_snapshot_digest,
  discovery_policy_digest, review_policy_digest, cost_policy_digest, workspace_id,
  created_at, deadline_at, correlation_id, run_json
`;

export interface SqliteFactoryExternalPullRequestReviewRepositoryOptions extends SqliteDatabaseOptions {
  readonly documents?: FactoryDocumentCodec;
}

/** Append-only external review journal and queue projection; reviewer content stays in artifacts. */
export class SqliteFactoryExternalPullRequestReviewRepository implements FactoryExternalPullRequestReviewRepository {
  readonly #database: DatabaseSync;
  readonly #documents: FactoryDocumentCodec;

  public constructor(
    databasePath: string,
    options: SqliteFactoryExternalPullRequestReviewRepositoryOptions = {}
  ) {
    this.#database = openSqliteDatabase(databasePath, options);
    this.#documents = options.documents ?? new NodeFactoryDocumentCodec();
  }

  public listAdmitted(input: {
    readonly repositoryId: string;
    readonly discoveryPolicyDigest: Sha256Digest;
    readonly reviewPolicyDigest: Sha256Digest;
    readonly limit: number;
  }): Promise<readonly FactoryExternalPullRequestReviewCandidateEnvelope[]> {
    assertLimit(input.limit);
    const rows = this.#database
      .prepare(
        `SELECT
           candidate.candidate_digest,
           candidate.candidate_json,
           candidate.run_id AS discovery_run_id,
           discovery.run_digest AS discovery_run_digest,
           snapshot.snapshot_digest AS discovery_snapshot_digest,
           discovery.discovery_policy_digest
         FROM factory_external_pr_discovery_candidates AS candidate
         JOIN factory_external_pr_discovery_runs AS discovery
           ON discovery.run_id = candidate.run_id
         JOIN factory_external_pr_discovery_snapshots AS snapshot
           ON snapshot.run_id = candidate.run_id
         WHERE candidate.repository_id = ?
           AND candidate.disposition = 'agent-review-candidate'
           AND discovery.discovery_policy_digest = ?
           AND EXISTS (
             SELECT 1 FROM factory_external_pr_discovery_events AS event
             WHERE event.run_id = candidate.run_id AND event.kind = 'completed'
           )
           AND NOT EXISTS (
             SELECT 1 FROM factory_external_pr_review_runs AS review
             WHERE review.candidate_digest = candidate.candidate_digest
               AND review.review_policy_digest = ?
           )
         ORDER BY discovery.scheduled_for, candidate.pull_request_number
         LIMIT ?`
      )
      .all(
        input.repositoryId,
        input.discoveryPolicyDigest,
        input.reviewPolicyDigest,
        input.limit
      ) as unknown as CandidateRow[];
    return Promise.resolve(rows.map((row) => this.#candidate(row)));
  }

  public listActive(input: {
    readonly repositoryId: string;
    readonly reviewPolicyDigest: Sha256Digest;
    readonly limit: number;
  }): Promise<readonly FactoryExternalPullRequestReviewJournalSnapshot[]> {
    assertLimit(input.limit);
    const rows = this.#database
      .prepare(
        `SELECT ${RUN_COLUMNS}
         FROM factory_external_pr_review_runs AS run
         WHERE run.repository_id = ? AND run.review_policy_digest = ?
           AND (
             SELECT event.to_state FROM factory_external_pr_review_events AS event
             WHERE event.run_id = run.run_id ORDER BY event.sequence DESC LIMIT 1
           ) IN ('ready', 'workspace-active', 'reviewing', 'reviewer-active', 'recorded')
         ORDER BY run.created_at, run.run_id
         LIMIT ?`
      )
      .all(input.repositoryId, input.reviewPolicyDigest, input.limit) as unknown as RunRow[];
    return Promise.resolve(rows.map((row) => this.#snapshot(this.#runFromRow(row))));
  }

  public register(
    runClaim: CanonicalFactoryDocument<FactoryExternalPullRequestReviewRun>,
    eventClaim: CanonicalFactoryDocument<FactoryExternalPullRequestReviewEvent>
  ): Promise<FactoryExternalPullRequestReviewJournalSnapshot> {
    const run = this.#verifiedRun(runClaim);
    const event = this.#verifiedEvent(eventClaim);
    assertExternalPullRequestReviewRun(run, this.#documents);
    assertExternalPullRequestReviewRegistration(run, event);
    return Promise.resolve(
      this.#transaction(() => {
        this.#assertCandidateAdmission(run);
        this.#database
          .prepare(
            `INSERT INTO factory_external_pr_review_runs (
              run_id, run_digest, repository_id, pull_request_number, candidate_digest,
              discovery_run_id, discovery_run_digest, discovery_snapshot_digest,
              discovery_policy_digest, review_policy_digest, cost_policy_digest, workspace_id,
              created_at, deadline_at, correlation_id, run_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            run.value.runId,
            run.digest,
            run.value.repositoryId,
            run.value.pullRequestNumber,
            run.value.candidateDigest,
            run.value.discoveryRunId,
            run.value.discoveryRunDigest,
            run.value.discoverySnapshotDigest,
            run.value.discoveryPolicyDigest,
            run.value.reviewPolicyDigest,
            run.value.costPolicyDigest,
            run.value.workspaceId,
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

  public findByCandidate(input: {
    readonly candidateDigest: Sha256Digest;
    readonly reviewPolicyDigest: Sha256Digest;
  }): Promise<FactoryExternalPullRequestReviewJournalSnapshot | null> {
    const row = this.#database
      .prepare(
        `SELECT ${RUN_COLUMNS} FROM factory_external_pr_review_runs
         WHERE candidate_digest = ? AND review_policy_digest = ?`
      )
      .get(input.candidateDigest, input.reviewPolicyDigest) as RunRow | undefined;
    return Promise.resolve(row === undefined ? null : this.#snapshot(this.#runFromRow(row)));
  }

  public append(
    eventClaim: CanonicalFactoryDocument<FactoryExternalPullRequestReviewEvent>
  ): Promise<FactoryExternalPullRequestReviewJournalSnapshot | null> {
    const event = this.#verifiedEvent(eventClaim);
    if (event.value.kind === "bundle-recorded") {
      throw new Error("External review bundles must be recorded atomically with their event.");
    }
    return Promise.resolve(
      this.#transaction(() => {
        const run = this.#findRun(event.value.reviewRunId);
        if (run?.digest !== event.value.runDigest) return null;
        const history = this.#readEvents(run);
        assertExternalPullRequestReviewEvent(run, event, history);
        const bundle = this.#readBundle(run, history);
        if (event.value.kind === "completed" && bundle?.decision !== event.value.decision) {
          throw new Error("External review completion disagrees with its bundle.");
        }
        this.#insertEvent(event);
        return snapshotFrom(run, [...history, event], bundle);
      })
    );
  }

  public recordBundle(
    eventClaim: CanonicalFactoryDocument<FactoryExternalPullRequestReviewEvent>,
    bundleClaim: CanonicalFactoryDocument<FactoryExternalPullRequestReviewBundle>
  ): Promise<FactoryExternalPullRequestReviewJournalSnapshot | null> {
    const event = this.#verifiedEvent(eventClaim);
    const bundle = this.#verifiedBundle(bundleClaim);
    if (event.value.kind !== "bundle-recorded") {
      throw new Error("External review bundle recording requires a bundle event.");
    }
    return Promise.resolve(
      this.#transaction(() => {
        const run = this.#findRun(event.value.reviewRunId);
        if (run?.digest !== event.value.runDigest) return null;
        const history = this.#readEvents(run);
        assertExternalPullRequestReviewEvent(run, event, history);
        assertExternalPullRequestReviewBundle(run, bundle, event, this.#documents);
        this.#database
          .prepare(
            `INSERT INTO factory_external_pr_review_bundles (
              run_id, run_digest, bundle_digest, decision, bundle_json
            ) VALUES (?, ?, ?, ?, ?)`
          )
          .run(run.value.runId, run.digest, bundle.digest, bundle.value.decision, bundle.json);
        this.#insertEvent(event);
        return snapshotFrom(run, [...history, event], bundle.value);
      })
    );
  }

  public close(): void {
    this.#database.close();
  }

  #candidate(row: CandidateRow): FactoryExternalPullRequestReviewCandidateEnvelope {
    const candidate = this.#documents.externalPullRequestCandidate(
      parseJson(row.candidate_json, "candidate")
    );
    if (row.candidate_digest !== candidate.digest) {
      throw new Error("Stored external PR review candidate failed digest validation.");
    }
    return {
      candidate: candidate.value,
      candidateDigest: candidate.digest,
      discoveryRunId: text(row.discovery_run_id, "discovery run ID"),
      discoveryRunDigest: digest(row.discovery_run_digest, "discovery run digest"),
      discoverySnapshotDigest: digest(row.discovery_snapshot_digest, "discovery snapshot digest"),
      discoveryPolicyDigest: digest(row.discovery_policy_digest, "discovery policy digest")
    };
  }

  #assertCandidateAdmission(
    run: CanonicalFactoryDocument<FactoryExternalPullRequestReviewRun>
  ): void {
    const row = this.#database
      .prepare(
        `SELECT
           candidate.candidate_json,
           discovery.run_digest AS discovery_run_digest,
           snapshot.snapshot_digest AS discovery_snapshot_digest,
           discovery.discovery_policy_digest
         FROM factory_external_pr_discovery_candidates AS candidate
         JOIN factory_external_pr_discovery_runs AS discovery
           ON discovery.run_id = candidate.run_id
         JOIN factory_external_pr_discovery_snapshots AS snapshot
           ON snapshot.run_id = candidate.run_id
         WHERE candidate.run_id = ?
           AND candidate.candidate_digest = ?
           AND candidate.repository_id = ?
           AND candidate.pull_request_number = ?
           AND candidate.disposition = 'agent-review-candidate'
           AND EXISTS (
             SELECT 1 FROM factory_external_pr_discovery_events AS event
             WHERE event.run_id = candidate.run_id AND event.kind = 'completed'
           )`
      )
      .get(
        run.value.discoveryRunId,
        run.value.candidateDigest,
        run.value.repositoryId,
        run.value.pullRequestNumber
      ) as CandidateAdmissionRow | undefined;
    if (
      row?.candidate_json !==
        this.#documents.externalPullRequestCandidate(run.value.candidate).json ||
      row.discovery_run_digest !== run.value.discoveryRunDigest ||
      row.discovery_snapshot_digest !== run.value.discoverySnapshotDigest ||
      row.discovery_policy_digest !== run.value.discoveryPolicyDigest
    ) {
      throw new Error("External PR review run is not rooted in one completed discovery candidate.");
    }
  }

  #snapshot(
    run: CanonicalFactoryDocument<FactoryExternalPullRequestReviewRun>
  ): FactoryExternalPullRequestReviewJournalSnapshot {
    const history = this.#readEvents(run);
    return snapshotFrom(run, history, this.#readBundle(run, history));
  }

  #findRun(runId: string): CanonicalFactoryDocument<FactoryExternalPullRequestReviewRun> | null {
    const row = this.#database
      .prepare(`SELECT ${RUN_COLUMNS} FROM factory_external_pr_review_runs WHERE run_id = ?`)
      .get(runId) as RunRow | undefined;
    return row === undefined ? null : this.#runFromRow(row);
  }

  #runFromRow(row: RunRow): CanonicalFactoryDocument<FactoryExternalPullRequestReviewRun> {
    const run = this.#documents.externalPullRequestReviewRun(parseJson(row.run_json, "run"));
    assertExternalPullRequestReviewRun(run, this.#documents);
    const expected = [
      row.run_id,
      row.run_digest,
      row.repository_id,
      row.pull_request_number,
      row.candidate_digest,
      row.discovery_run_id,
      row.discovery_run_digest,
      row.discovery_snapshot_digest,
      row.discovery_policy_digest,
      row.review_policy_digest,
      row.cost_policy_digest,
      row.workspace_id,
      row.created_at,
      row.deadline_at,
      row.correlation_id,
      row.run_json
    ];
    const actual = [
      run.value.runId,
      run.digest,
      run.value.repositoryId,
      run.value.pullRequestNumber,
      run.value.candidateDigest,
      run.value.discoveryRunId,
      run.value.discoveryRunDigest,
      run.value.discoverySnapshotDigest,
      run.value.discoveryPolicyDigest,
      run.value.reviewPolicyDigest,
      run.value.costPolicyDigest,
      run.value.workspaceId,
      run.value.createdAt,
      run.value.deadlineAt,
      run.value.correlationId,
      run.json
    ];
    if (expected.some((value, index) => value !== actual[index])) {
      throw new Error(
        `Stored external PR review run ${run.value.runId} failed integrity validation.`
      );
    }
    return run;
  }

  #readEvents(
    run: CanonicalFactoryDocument<FactoryExternalPullRequestReviewRun>
  ): readonly CanonicalFactoryDocument<FactoryExternalPullRequestReviewEvent>[] {
    const rows = this.#database
      .prepare(
        `SELECT event_digest, event_json FROM factory_external_pr_review_events
         WHERE run_id = ? ORDER BY sequence LIMIT 65`
      )
      .all(run.value.runId) as unknown as EventRow[];
    if (rows.length < 1 || rows.length > 64) {
      throw new Error("Stored external PR review event count is invalid.");
    }
    const history: CanonicalFactoryDocument<FactoryExternalPullRequestReviewEvent>[] = [];
    for (const row of rows) {
      const event = this.#documents.externalPullRequestReviewEvent(
        parseJson(row.event_json, "event")
      );
      if (row.event_digest !== event.digest) {
        throw new Error("Stored external PR review event failed digest validation.");
      }
      if (history.length === 0) assertExternalPullRequestReviewRegistration(run, event);
      else assertExternalPullRequestReviewEvent(run, event, history);
      history.push(event);
    }
    return history;
  }

  #readBundle(
    run: CanonicalFactoryDocument<FactoryExternalPullRequestReviewRun>,
    history: readonly CanonicalFactoryDocument<FactoryExternalPullRequestReviewEvent>[]
  ): FactoryExternalPullRequestReviewBundle | null {
    const row = this.#database
      .prepare(
        `SELECT bundle_digest, bundle_json FROM factory_external_pr_review_bundles WHERE run_id = ?`
      )
      .get(run.value.runId) as BundleRow | undefined;
    if (row === undefined) return null;
    const bundle = this.#documents.externalPullRequestReviewBundle(
      parseJson(row.bundle_json, "bundle")
    );
    const event = history.find(({ value }) => value.kind === "bundle-recorded");
    if (row.bundle_digest !== bundle.digest || event === undefined) {
      throw new Error("Stored external PR review bundle failed digest validation.");
    }
    assertExternalPullRequestReviewBundle(run, bundle, event, this.#documents);
    return bundle.value;
  }

  #insertEvent(event: CanonicalFactoryDocument<FactoryExternalPullRequestReviewEvent>): void {
    const fields = eventFields(event.value);
    this.#database
      .prepare(
        `INSERT INTO factory_external_pr_review_events (
          event_id, run_id, run_digest, sequence, event_digest, previous_event_digest,
          kind, from_state, to_state, patch_digest, patch_artifact_json, reviewer_id,
          execution_id, request_digest, reviewer_record_digest, review_result_digest,
          bundle_digest, bundle_artifact_json, decision, occurred_at, reason_code,
          correlation_id, event_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.value.eventId,
        event.value.reviewRunId,
        event.value.runDigest,
        event.value.sequence,
        event.digest,
        event.value.previousEventDigest,
        event.value.kind,
        event.value.from,
        event.value.to,
        fields.patchDigest,
        fields.patchArtifact,
        fields.reviewerId,
        fields.executionId,
        fields.requestDigest,
        fields.reviewerRecordDigest,
        fields.reviewResultDigest,
        fields.bundleDigest,
        fields.bundleArtifact,
        fields.decision,
        event.value.occurredAt,
        event.value.reasonCode,
        event.value.correlationId,
        event.json
      );
  }

  #verifiedRun(claim: CanonicalFactoryDocument<FactoryExternalPullRequestReviewRun>) {
    const actual = this.#documents.externalPullRequestReviewRun(claim.value);
    assertClaim(claim, actual, "run");
    return actual;
  }

  #verifiedEvent(claim: CanonicalFactoryDocument<FactoryExternalPullRequestReviewEvent>) {
    const actual = this.#documents.externalPullRequestReviewEvent(claim.value);
    assertClaim(claim, actual, "event");
    return actual;
  }

  #verifiedBundle(claim: CanonicalFactoryDocument<FactoryExternalPullRequestReviewBundle>) {
    const actual = this.#documents.externalPullRequestReviewBundle(claim.value);
    assertClaim(claim, actual, "bundle");
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
          "External PR review transaction rollback failed.",
          { cause: error }
        );
      }
      throw error;
    }
  }
}

function snapshotFrom(
  run: CanonicalFactoryDocument<FactoryExternalPullRequestReviewRun>,
  history: readonly CanonicalFactoryDocument<FactoryExternalPullRequestReviewEvent>[],
  bundle: FactoryExternalPullRequestReviewBundle | null
): FactoryExternalPullRequestReviewJournalSnapshot {
  const last = history.at(-1);
  if (last === undefined) throw new Error("External PR review journal has no event.");
  return {
    run: run.value,
    runDigest: run.digest,
    state: last.value.to,
    sequence: last.value.sequence,
    lastEvent: last.value,
    lastEventDigest: last.digest,
    history: history.map(({ value }) => value),
    bundle
  };
}

function eventFields(event: FactoryExternalPullRequestReviewEvent) {
  return {
    patchDigest: event.kind === "workspace-prepared" ? event.patchDigest : null,
    patchArtifact: event.kind === "workspace-prepared" ? JSON.stringify(event.patchArtifact) : null,
    reviewerId:
      event.kind === "reviewer-started" || event.kind === "reviewer-finished"
        ? event.reviewerId
        : null,
    executionId:
      event.kind === "reviewer-started" || event.kind === "reviewer-finished"
        ? event.executionId
        : null,
    requestDigest:
      event.kind === "reviewer-started" || event.kind === "reviewer-finished"
        ? event.requestDigest
        : null,
    reviewerRecordDigest:
      event.kind === "reviewer-finished" || event.kind === "failed" || event.kind === "quarantined"
        ? event.reviewerRecordDigest
        : null,
    reviewResultDigest: event.kind === "reviewer-finished" ? event.reviewResultDigest : null,
    bundleDigest: event.kind === "bundle-recorded" ? event.bundleDigest : null,
    bundleArtifact: event.kind === "bundle-recorded" ? JSON.stringify(event.bundleArtifact) : null,
    decision: event.kind === "completed" ? event.decision : null
  };
}

function assertClaim<Value>(
  claim: CanonicalFactoryDocument<Value>,
  actual: CanonicalFactoryDocument<Value>,
  label: string
): void {
  if (claim.digest !== actual.digest || claim.json !== actual.json) {
    throw new Error(`External PR review ${label} claim is not canonical.`);
  }
}

function parseJson(value: unknown, label: string): unknown {
  if (typeof value !== "string") throw new Error(`Stored external PR review ${label} is not text.`);
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error(`Stored external PR review ${label} is invalid JSON.`, { cause: error });
  }
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`Stored ${label} is invalid.`);
  return value;
}

function digest(value: unknown, label: string): Sha256Digest {
  const parsed = text(value, label);
  if (!/^sha256:[0-9a-f]{64}$/u.test(parsed)) throw new Error(`Stored ${label} is invalid.`);
  return parsed;
}

function assertLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) {
    throw new Error("External PR review queue limit must be between one and ten.");
  }
}
