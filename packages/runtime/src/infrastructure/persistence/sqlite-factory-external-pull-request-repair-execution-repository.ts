import { DatabaseSync } from "node:sqlite";

import type {
  FactoryExternalPullRequestRepairAdmissionPolicy,
  FactoryExternalPullRequestRepairBundle,
  FactoryExternalPullRequestRepairExecutionEvent,
  FactoryExternalPullRequestRepairExecutionPolicy,
  FactoryExternalPullRequestRepairExecutionRun,
  Sha256Digest
} from "@agentlab/contracts";

import {
  assertExternalPullRequestRepairBundle,
  assertExternalPullRequestRepairExecutionEvent,
  assertExternalPullRequestRepairExecutionRegistration,
  assertExternalPullRequestRepairExecutionRun
} from "../../domain/factory-external-pull-request-repair-execution-integrity.js";
import type {
  FactoryExternalPullRequestRepairExecutionCandidate,
  FactoryExternalPullRequestRepairExecutionJournalSnapshot,
  FactoryExternalPullRequestRepairExecutionRepository
} from "../../domain/factory-external-pull-request-repair-execution-repository.js";
import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../../domain/factory-documents.js";
import { NodeFactoryDocumentCodec } from "./canonical-factory-documents.js";
import { openSqliteDatabase, type SqliteDatabaseOptions } from "./sqlite-database.js";

interface CandidateRow {
  readonly decision_digest: unknown;
  readonly decision_json: unknown;
  readonly authorization_digest: unknown;
  readonly authorization_json: unknown;
  readonly feedback_run_digest: unknown;
  readonly feedback_run_json: unknown;
  readonly feedback_record_digest: unknown;
  readonly feedback_record_json: unknown;
}

interface RunRow {
  readonly run_id: unknown;
  readonly run_digest: unknown;
  readonly repository_id: unknown;
  readonly pull_request_number: unknown;
  readonly authorization_id: unknown;
  readonly authorization_digest: unknown;
  readonly admission_decision_digest: unknown;
  readonly feedback_publication_run_digest: unknown;
  readonly feedback_record_digest: unknown;
  readonly admission_policy_digest: unknown;
  readonly repair_execution_policy_digest: unknown;
  readonly workspace_id: unknown;
  readonly expected_head_revision: unknown;
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

const RUN_COLUMNS = `
  run_id, run_digest, repository_id, pull_request_number, authorization_id,
  authorization_digest, admission_decision_digest, feedback_publication_run_digest,
  feedback_record_digest, admission_policy_digest, repair_execution_policy_digest,
  workspace_id, expected_head_revision, created_at, deadline_at, correlation_id, run_json
`;

const CANDIDATE_SELECT = `
  SELECT
    decision.decision_digest,
    decision.decision_json,
    authorization.authorization_digest,
    authorization.authorization_json,
    feedback.run_digest AS feedback_run_digest,
    feedback.run_json AS feedback_run_json,
    record.record_digest AS feedback_record_digest,
    record.record_json AS feedback_record_json
  FROM factory_external_pr_repair_authorizations AS authorization
  JOIN factory_external_pr_repair_decisions AS decision
    ON decision.decision_id = authorization.decision_id
  JOIN factory_external_pr_feedback_runs AS feedback
    ON feedback.run_digest = decision.feedback_publication_run_digest
  JOIN factory_external_pr_feedback_records AS record
    ON record.record_digest = decision.feedback_record_digest
`;

export interface SqliteFactoryExternalPullRequestRepairExecutionRepositoryOptions extends SqliteDatabaseOptions {
  readonly documents?: FactoryDocumentCodec;
  readonly now?: () => string;
}

/** Immutable admission projection and append-only credentialless external repair journal. */
export class SqliteFactoryExternalPullRequestRepairExecutionRepository implements FactoryExternalPullRequestRepairExecutionRepository {
  readonly #database: DatabaseSync;
  readonly #documents: FactoryDocumentCodec;
  readonly #now: () => string;

  public constructor(
    databasePath: string,
    options: SqliteFactoryExternalPullRequestRepairExecutionRepositoryOptions = {}
  ) {
    this.#database = openSqliteDatabase(databasePath, options);
    this.#documents = options.documents ?? new NodeFactoryDocumentCodec();
    this.#now = options.now ?? (() => new Date().toISOString());
  }

  public listAdmitted(input: {
    readonly repositoryId: string;
    readonly admissionPolicyDigest: Sha256Digest;
    readonly repairExecutionPolicyDigest: Sha256Digest;
    readonly limit: number;
  }): Promise<readonly FactoryExternalPullRequestRepairExecutionCandidate[]> {
    assertLimit(input.limit);
    const rows = this.#database
      .prepare(
        `${CANDIDATE_SELECT}
         WHERE decision.repository_id = ?
           AND decision.admission_policy_digest = ?
           AND decision.decision_status = 'authorized'
           AND json_extract(authorization.authorization_json, '$.repairExecutionPolicyDigest') = ?
           AND EXISTS (
             SELECT 1 FROM factory_external_pr_feedback_events AS event
             WHERE event.publication_run_id = feedback.publication_run_id
               AND event.kind = 'completed'
           )
           AND NOT EXISTS (
             SELECT 1 FROM factory_external_pr_repair_execution_runs AS execution
             WHERE execution.authorization_digest = authorization.authorization_digest
               AND execution.repair_execution_policy_digest = ?
           )
         ORDER BY decision.created_at, decision.decision_id
         LIMIT ?`
      )
      .all(
        input.repositoryId,
        input.admissionPolicyDigest,
        input.repairExecutionPolicyDigest,
        input.repairExecutionPolicyDigest,
        input.limit
      ) as unknown as CandidateRow[];
    return Promise.resolve(rows.map((row) => this.#candidate(row)));
  }

  public listActive(input: {
    readonly repositoryId: string;
    readonly repairExecutionPolicyDigest: Sha256Digest;
    readonly limit: number;
  }): Promise<readonly FactoryExternalPullRequestRepairExecutionJournalSnapshot[]> {
    assertLimit(input.limit);
    const rows = this.#database
      .prepare(
        `SELECT ${RUN_COLUMNS}
         FROM factory_external_pr_repair_execution_runs AS run
         WHERE run.repository_id = ? AND run.repair_execution_policy_digest = ?
           AND (
             SELECT event.to_state
             FROM factory_external_pr_repair_execution_events AS event
             WHERE event.run_id = run.run_id ORDER BY event.sequence DESC LIMIT 1
           ) IN ('ready', 'workspace-active', 'prepared', 'repairer-active', 'recorded')
         ORDER BY run.created_at, run.run_id
         LIMIT ?`
      )
      .all(
        input.repositoryId,
        input.repairExecutionPolicyDigest,
        input.limit
      ) as unknown as RunRow[];
    return Promise.resolve(rows.map((row) => this.#snapshot(this.#runFromRow(row))));
  }

  public findCandidateByAuthorization(
    authorizationDigest: Sha256Digest
  ): Promise<FactoryExternalPullRequestRepairExecutionCandidate | null> {
    const row = this.#database
      .prepare(
        `${CANDIDATE_SELECT}
         WHERE authorization.authorization_digest = ?
           AND decision.decision_status = 'authorized'
           AND EXISTS (
             SELECT 1 FROM factory_external_pr_feedback_events AS event
             WHERE event.publication_run_id = feedback.publication_run_id
               AND event.kind = 'completed'
           )`
      )
      .get(authorizationDigest) as CandidateRow | undefined;
    return Promise.resolve(row === undefined ? null : this.#candidate(row));
  }

  public register(
    admissionPolicyClaim: CanonicalFactoryDocument<FactoryExternalPullRequestRepairAdmissionPolicy>,
    executionPolicyClaim: CanonicalFactoryDocument<FactoryExternalPullRequestRepairExecutionPolicy>,
    runClaim: CanonicalFactoryDocument<FactoryExternalPullRequestRepairExecutionRun>,
    eventClaim: CanonicalFactoryDocument<FactoryExternalPullRequestRepairExecutionEvent>,
    candidate: FactoryExternalPullRequestRepairExecutionCandidate
  ): Promise<FactoryExternalPullRequestRepairExecutionJournalSnapshot> {
    const admissionPolicy = this.#documents.externalPullRequestRepairAdmissionPolicy(
      admissionPolicyClaim.value
    );
    const executionPolicy = this.#documents.externalPullRequestRepairExecutionPolicy(
      executionPolicyClaim.value
    );
    const run = this.#verifiedRun(runClaim);
    const event = this.#verifiedEvent(eventClaim);
    if (
      admissionPolicy.digest !== admissionPolicyClaim.digest ||
      executionPolicy.digest !== executionPolicyClaim.digest
    ) {
      throw new Error("External repair execution received a non-canonical policy claim.");
    }
    assertExternalPullRequestRepairExecutionRun(
      admissionPolicy,
      executionPolicy,
      candidate,
      run,
      this.#documents,
      this.#now()
    );
    assertExternalPullRequestRepairExecutionRegistration(run, event);
    return Promise.resolve(
      this.#transaction(() => {
        this.#assertCandidatePresent(candidate);
        this.#database
          .prepare(
            `INSERT INTO factory_external_pr_repair_execution_runs (
              run_id, run_digest, repository_id, pull_request_number, authorization_id,
              authorization_digest, admission_decision_digest, feedback_publication_run_digest,
              feedback_record_digest, admission_policy_digest, repair_execution_policy_digest,
              workspace_id, expected_head_revision, created_at, deadline_at, correlation_id,
              run_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            run.value.runId,
            run.digest,
            run.value.repositoryId,
            run.value.pullRequestNumber,
            run.value.authorizationId,
            run.value.authorizationDigest,
            run.value.admissionDecisionDigest,
            run.value.feedbackPublicationRunDigest,
            run.value.feedbackRecordDigest,
            run.value.admissionPolicyDigest,
            run.value.repairExecutionPolicyDigest,
            run.value.workspaceId,
            run.value.expectedHeadRevision,
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

  public findByAuthorization(
    authorizationDigest: Sha256Digest,
    repairExecutionPolicyDigest: Sha256Digest
  ): Promise<FactoryExternalPullRequestRepairExecutionJournalSnapshot | null> {
    const row = this.#database
      .prepare(
        `SELECT ${RUN_COLUMNS}
         FROM factory_external_pr_repair_execution_runs
         WHERE authorization_digest = ? AND repair_execution_policy_digest = ?`
      )
      .get(authorizationDigest, repairExecutionPolicyDigest) as RunRow | undefined;
    return Promise.resolve(row === undefined ? null : this.#snapshot(this.#runFromRow(row)));
  }

  public append(
    eventClaim: CanonicalFactoryDocument<FactoryExternalPullRequestRepairExecutionEvent>
  ): Promise<FactoryExternalPullRequestRepairExecutionJournalSnapshot | null> {
    const event = this.#verifiedEvent(eventClaim);
    if (event.value.kind === "bundle-recorded") {
      throw new Error("External repair bundles must be recorded atomically with their event.");
    }
    return Promise.resolve(
      this.#transaction(() => {
        const run = this.#findRun(event.value.repairRunId);
        if (run?.digest !== event.value.runDigest) return null;
        const history = this.#readEvents(run);
        assertExternalPullRequestRepairExecutionEvent(run, event, history);
        const bundle = this.#readBundle(run, history);
        const actualBundleDigest =
          bundle === null ? null : this.#documents.externalPullRequestRepairBundle(bundle).digest;
        if (event.value.kind === "completed" && actualBundleDigest !== event.value.bundleDigest) {
          throw new Error("External repair completion disagrees with its bundle.");
        }
        this.#insertEvent(event);
        return snapshotFrom(run, [...history, event], bundle);
      })
    );
  }

  public recordBundle(
    eventClaim: CanonicalFactoryDocument<FactoryExternalPullRequestRepairExecutionEvent>,
    bundleClaim: CanonicalFactoryDocument<FactoryExternalPullRequestRepairBundle>
  ): Promise<FactoryExternalPullRequestRepairExecutionJournalSnapshot | null> {
    const event = this.#verifiedEvent(eventClaim);
    const bundle = this.#verifiedBundle(bundleClaim);
    if (event.value.kind !== "bundle-recorded") {
      throw new Error("External repair bundle recording requires a bundle event.");
    }
    return Promise.resolve(
      this.#transaction(() => {
        const run = this.#findRun(event.value.repairRunId);
        if (run?.digest !== event.value.runDigest) return null;
        const history = this.#readEvents(run);
        assertExternalPullRequestRepairExecutionEvent(run, event, history);
        assertExternalPullRequestRepairBundle(run, bundle, event);
        this.#database
          .prepare(
            `INSERT INTO factory_external_pr_repair_execution_bundles (
              run_id, run_digest, bundle_digest, patch_digest, bundle_json
            ) VALUES (?, ?, ?, ?, ?)`
          )
          .run(
            run.value.runId,
            run.digest,
            bundle.digest,
            bundle.value.patchArtifact.digest,
            bundle.json
          );
        this.#insertEvent(event);
        return snapshotFrom(run, [...history, event], bundle.value);
      })
    );
  }

  public close(): void {
    this.#database.close();
  }

  #candidate(row: CandidateRow): FactoryExternalPullRequestRepairExecutionCandidate {
    const decision = this.#documents.externalPullRequestRepairDecision(
      parseJson(row.decision_json, "decision")
    );
    const authorization = this.#documents.externalPullRequestRepairAuthorization(
      parseJson(row.authorization_json, "authorization")
    );
    const feedbackRun = this.#documents.externalPullRequestFeedbackRun(
      parseJson(row.feedback_run_json, "feedback run")
    );
    const feedbackRecord = this.#documents.externalPullRequestFeedbackRecord(
      parseJson(row.feedback_record_json, "feedback record")
    );
    if (
      decision.digest !== row.decision_digest ||
      authorization.digest !== row.authorization_digest ||
      feedbackRun.digest !== row.feedback_run_digest ||
      feedbackRecord.digest !== row.feedback_record_digest
    ) {
      throw new Error("Stored external repair execution candidate failed digest validation.");
    }
    return { decision, authorization, feedbackRun, feedbackRecord };
  }

  #assertCandidatePresent(candidate: FactoryExternalPullRequestRepairExecutionCandidate): void {
    const row = this.#database
      .prepare(
        `SELECT 1
         FROM factory_external_pr_repair_authorizations AS authorization
         JOIN factory_external_pr_repair_decisions AS decision
           ON decision.decision_id = authorization.decision_id
         JOIN factory_external_pr_feedback_runs AS feedback
           ON feedback.run_digest = decision.feedback_publication_run_digest
         JOIN factory_external_pr_feedback_records AS record
           ON record.record_digest = decision.feedback_record_digest
         WHERE authorization.authorization_id = ?
           AND authorization.authorization_digest = ?
           AND decision.decision_digest = ?
           AND feedback.run_digest = ?
           AND record.record_digest = ?
           AND decision.decision_status = 'authorized'
           AND EXISTS (
             SELECT 1 FROM factory_external_pr_feedback_events AS event
             WHERE event.publication_run_id = feedback.publication_run_id
               AND event.kind = 'completed'
           )`
      )
      .get(
        candidate.authorization.value.authorizationId,
        candidate.authorization.digest,
        candidate.decision.digest,
        candidate.feedbackRun.digest,
        candidate.feedbackRecord.digest
      );
    if (row === undefined) {
      throw new Error("External repair execution is not rooted in completed admitted evidence.");
    }
  }

  #snapshot(
    run: CanonicalFactoryDocument<FactoryExternalPullRequestRepairExecutionRun>
  ): FactoryExternalPullRequestRepairExecutionJournalSnapshot {
    const history = this.#readEvents(run);
    return snapshotFrom(run, history, this.#readBundle(run, history));
  }

  #findRun(
    runId: string
  ): CanonicalFactoryDocument<FactoryExternalPullRequestRepairExecutionRun> | null {
    const row = this.#database
      .prepare(
        `SELECT ${RUN_COLUMNS} FROM factory_external_pr_repair_execution_runs WHERE run_id = ?`
      )
      .get(runId) as RunRow | undefined;
    return row === undefined ? null : this.#runFromRow(row);
  }

  #runFromRow(row: RunRow): CanonicalFactoryDocument<FactoryExternalPullRequestRepairExecutionRun> {
    const run = this.#documents.externalPullRequestRepairExecutionRun(
      parseJson(row.run_json, "run")
    );
    const expected = [
      row.run_id,
      row.run_digest,
      row.repository_id,
      row.pull_request_number,
      row.authorization_id,
      row.authorization_digest,
      row.admission_decision_digest,
      row.feedback_publication_run_digest,
      row.feedback_record_digest,
      row.admission_policy_digest,
      row.repair_execution_policy_digest,
      row.workspace_id,
      row.expected_head_revision,
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
      run.value.authorizationId,
      run.value.authorizationDigest,
      run.value.admissionDecisionDigest,
      run.value.feedbackPublicationRunDigest,
      run.value.feedbackRecordDigest,
      run.value.admissionPolicyDigest,
      run.value.repairExecutionPolicyDigest,
      run.value.workspaceId,
      run.value.expectedHeadRevision,
      run.value.createdAt,
      run.value.deadlineAt,
      run.value.correlationId,
      run.json
    ];
    if (expected.some((value, index) => value !== actual[index])) {
      throw new Error(`Stored external repair run ${run.value.runId} failed integrity validation.`);
    }
    return run;
  }

  #readEvents(
    run: CanonicalFactoryDocument<FactoryExternalPullRequestRepairExecutionRun>
  ): readonly CanonicalFactoryDocument<FactoryExternalPullRequestRepairExecutionEvent>[] {
    const rows = this.#database
      .prepare(
        `SELECT event_digest, event_json FROM factory_external_pr_repair_execution_events
         WHERE run_id = ? ORDER BY sequence LIMIT 33`
      )
      .all(run.value.runId) as unknown as EventRow[];
    if (rows.length < 1 || rows.length > 32) {
      throw new Error("Stored external repair event count is invalid.");
    }
    const history: CanonicalFactoryDocument<FactoryExternalPullRequestRepairExecutionEvent>[] = [];
    for (const row of rows) {
      const event = this.#documents.externalPullRequestRepairExecutionEvent(
        parseJson(row.event_json, "event")
      );
      if (event.digest !== row.event_digest) {
        throw new Error("Stored external repair event failed digest validation.");
      }
      if (history.length === 0) assertExternalPullRequestRepairExecutionRegistration(run, event);
      else assertExternalPullRequestRepairExecutionEvent(run, event, history);
      history.push(event);
    }
    return history;
  }

  #readBundle(
    run: CanonicalFactoryDocument<FactoryExternalPullRequestRepairExecutionRun>,
    history: readonly CanonicalFactoryDocument<FactoryExternalPullRequestRepairExecutionEvent>[]
  ) {
    const row = this.#database
      .prepare(
        `SELECT bundle_digest, bundle_json
         FROM factory_external_pr_repair_execution_bundles WHERE run_id = ?`
      )
      .get(run.value.runId) as BundleRow | undefined;
    if (row === undefined) return null;
    const bundle = this.#documents.externalPullRequestRepairBundle(
      parseJson(row.bundle_json, "bundle")
    );
    const event = history.find(({ value }) => value.kind === "bundle-recorded");
    if (bundle.digest !== row.bundle_digest || event === undefined) {
      throw new Error("Stored external repair bundle failed digest validation.");
    }
    assertExternalPullRequestRepairBundle(run, bundle, event);
    return bundle.value;
  }

  #insertEvent(
    event: CanonicalFactoryDocument<FactoryExternalPullRequestRepairExecutionEvent>
  ): void {
    const fields = eventFields(event.value);
    this.#database
      .prepare(
        `INSERT INTO factory_external_pr_repair_execution_events (
          event_id, run_id, run_digest, sequence, event_digest, previous_event_digest,
          kind, from_state, to_state, source_patch_digest, source_patch_artifact_json,
          repairer_id, execution_id, request_digest, repairer_record_digest,
          bundle_digest, bundle_artifact_json, occurred_at, reason_code, correlation_id,
          event_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.value.eventId,
        event.value.repairRunId,
        event.value.runDigest,
        event.value.sequence,
        event.digest,
        event.value.previousEventDigest,
        event.value.kind,
        event.value.from,
        event.value.to,
        fields.sourcePatchDigest,
        fields.sourcePatchArtifact,
        fields.repairerId,
        fields.executionId,
        fields.requestDigest,
        fields.repairerRecordDigest,
        fields.bundleDigest,
        fields.bundleArtifact,
        event.value.occurredAt,
        event.value.reasonCode,
        event.value.correlationId,
        event.json
      );
  }

  #verifiedRun(claim: CanonicalFactoryDocument<FactoryExternalPullRequestRepairExecutionRun>) {
    const actual = this.#documents.externalPullRequestRepairExecutionRun(claim.value);
    assertClaim(claim, actual, "run");
    return actual;
  }

  #verifiedEvent(claim: CanonicalFactoryDocument<FactoryExternalPullRequestRepairExecutionEvent>) {
    const actual = this.#documents.externalPullRequestRepairExecutionEvent(claim.value);
    assertClaim(claim, actual, "event");
    return actual;
  }

  #verifiedBundle(claim: CanonicalFactoryDocument<FactoryExternalPullRequestRepairBundle>) {
    const actual = this.#documents.externalPullRequestRepairBundle(claim.value);
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
          "External repair execution transaction rollback failed.",
          { cause: error }
        );
      }
      throw error;
    }
  }
}

function snapshotFrom(
  run: CanonicalFactoryDocument<FactoryExternalPullRequestRepairExecutionRun>,
  history: readonly CanonicalFactoryDocument<FactoryExternalPullRequestRepairExecutionEvent>[],
  bundle: FactoryExternalPullRequestRepairBundle | null
): FactoryExternalPullRequestRepairExecutionJournalSnapshot {
  const last = history.at(-1);
  if (last === undefined) throw new Error("External repair execution journal has no event.");
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

function eventFields(event: FactoryExternalPullRequestRepairExecutionEvent) {
  const repairerEvent = event.kind === "repairer-started" || event.kind === "bundle-recorded";
  return {
    sourcePatchDigest: event.kind === "workspace-prepared" ? event.sourcePatchDigest : null,
    sourcePatchArtifact:
      event.kind === "workspace-prepared" ? JSON.stringify(event.sourcePatchArtifact) : null,
    repairerId: repairerEvent ? event.repairerId : null,
    executionId: repairerEvent ? event.executionId : null,
    requestDigest: repairerEvent ? event.requestDigest : null,
    repairerRecordDigest:
      event.kind === "bundle-recorded" || event.kind === "failed" || event.kind === "quarantined"
        ? event.repairerRecordDigest
        : null,
    bundleDigest:
      event.kind === "bundle-recorded" || event.kind === "completed" ? event.bundleDigest : null,
    bundleArtifact: event.kind === "bundle-recorded" ? JSON.stringify(event.bundleArtifact) : null
  };
}

function assertClaim<Value>(
  claim: CanonicalFactoryDocument<Value>,
  actual: CanonicalFactoryDocument<Value>,
  label: string
): void {
  if (claim.digest !== actual.digest || claim.json !== actual.json) {
    throw new Error(`External repair execution ${label} claim is not canonical.`);
  }
}

function parseJson(value: unknown, label: string): unknown {
  if (typeof value !== "string") throw new Error(`Stored external repair ${label} is not text.`);
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error(`Stored external repair ${label} is invalid JSON.`, { cause: error });
  }
}

function assertLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) {
    throw new Error("External repair execution queue limit must be between one and ten.");
  }
}
