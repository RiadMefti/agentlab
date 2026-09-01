import { DatabaseSync } from "node:sqlite";

import type {
  FactoryExternalPullRequestRepairQualificationBundle,
  FactoryExternalPullRequestRepairQualificationEvent,
  FactoryExternalPullRequestRepairQualificationPolicy,
  FactoryExternalPullRequestRepairQualificationRun,
  FactoryExternalPullRequestRepairerRecord,
  Sha256Digest
} from "@agentlab/contracts";

import {
  assertExternalPullRequestRepairQualificationBundle,
  assertExternalPullRequestRepairQualificationEvent,
  assertExternalPullRequestRepairQualificationRegistration,
  assertExternalPullRequestRepairQualificationRun
} from "../../domain/factory-external-pull-request-repair-qualification-integrity.js";
import type {
  FactoryExternalPullRequestRepairQualificationCandidate,
  FactoryExternalPullRequestRepairQualificationJournalSnapshot,
  FactoryExternalPullRequestRepairQualificationRepository
} from "../../domain/factory-external-pull-request-repair-qualification-repository.js";
import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../../domain/factory-documents.js";
import { NodeFactoryDocumentCodec } from "./canonical-factory-documents.js";
import { openSqliteDatabase, type SqliteDatabaseOptions } from "./sqlite-database.js";

interface CandidateRow {
  readonly repair_run_digest: unknown;
  readonly repair_run_json: unknown;
  readonly repair_bundle_digest: unknown;
  readonly repair_bundle_json: unknown;
  readonly feedback_run_digest: unknown;
  readonly feedback_run_json: unknown;
}

interface RunRow {
  readonly qualification_run_id: unknown;
  readonly run_digest: unknown;
  readonly repository_id: unknown;
  readonly pull_request_number: unknown;
  readonly repair_run_id: unknown;
  readonly repair_run_digest: unknown;
  readonly repair_bundle_digest: unknown;
  readonly repair_execution_policy_digest: unknown;
  readonly qualification_policy_digest: unknown;
  readonly gate_profile_digest: unknown;
  readonly workspace_id: unknown;
  readonly expected_head_revision: unknown;
  readonly repaired_patch_digest: unknown;
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
  qualification_run_id, run_digest, repository_id, pull_request_number, repair_run_id,
  repair_run_digest, repair_bundle_digest, repair_execution_policy_digest,
  qualification_policy_digest, gate_profile_digest, workspace_id, expected_head_revision,
  repaired_patch_digest, created_at, deadline_at, correlation_id, run_json
`;

const CANDIDATE_SELECT = `
  SELECT
    execution.run_digest AS repair_run_digest,
    execution.run_json AS repair_run_json,
    repair.bundle_digest AS repair_bundle_digest,
    repair.bundle_json AS repair_bundle_json,
    feedback.run_digest AS feedback_run_digest,
    feedback.run_json AS feedback_run_json
  FROM factory_external_pr_repair_execution_runs AS execution
  JOIN factory_external_pr_repair_execution_bundles AS repair
    ON repair.run_id = execution.run_id
  JOIN factory_external_pr_feedback_runs AS feedback
    ON feedback.run_digest = execution.feedback_publication_run_digest
`;

export interface SqliteFactoryExternalPullRequestRepairQualificationRepositoryOptions extends SqliteDatabaseOptions {
  readonly documents?: FactoryDocumentCodec;
}

/** Durable completed-repair projection and immutable post-repair qualification journal. */
export class SqliteFactoryExternalPullRequestRepairQualificationRepository implements FactoryExternalPullRequestRepairQualificationRepository {
  readonly #database: DatabaseSync;
  readonly #documents: FactoryDocumentCodec;

  public constructor(
    databasePath: string,
    options: SqliteFactoryExternalPullRequestRepairQualificationRepositoryOptions = {}
  ) {
    this.#database = openSqliteDatabase(databasePath, options);
    this.#documents = options.documents ?? new NodeFactoryDocumentCodec();
  }

  public listCompletedRepairs(input: {
    readonly repositoryId: string;
    readonly repairExecutionPolicyDigest: Sha256Digest;
    readonly qualificationPolicyDigest: Sha256Digest;
    readonly limit: number;
  }): Promise<readonly FactoryExternalPullRequestRepairQualificationCandidate[]> {
    assertLimit(input.limit);
    const rows = this.#database
      .prepare(
        `${CANDIDATE_SELECT}
         WHERE execution.repository_id = ?
           AND execution.repair_execution_policy_digest = ?
           AND json_extract(
             execution.run_json,
             '$.repairExecutionPolicy.qualificationPolicyDigest'
           ) = ?
           AND EXISTS (
             SELECT 1 FROM factory_external_pr_repair_execution_events AS event
             WHERE event.run_id = execution.run_id AND event.kind = 'completed'
           )
           AND NOT EXISTS (
             SELECT 1 FROM factory_external_pr_repair_qualification_runs AS qualification
             WHERE qualification.repair_bundle_digest = repair.bundle_digest
               AND qualification.qualification_policy_digest = ?
           )
         ORDER BY execution.created_at, execution.run_id
         LIMIT ?`
      )
      .all(
        input.repositoryId,
        input.repairExecutionPolicyDigest,
        input.qualificationPolicyDigest,
        input.qualificationPolicyDigest,
        input.limit
      ) as unknown as CandidateRow[];
    return Promise.resolve(rows.map((row) => this.#candidate(row)));
  }

  public listActive(input: {
    readonly repositoryId: string;
    readonly qualificationPolicyDigest: Sha256Digest;
    readonly limit: number;
  }): Promise<readonly FactoryExternalPullRequestRepairQualificationJournalSnapshot[]> {
    assertLimit(input.limit);
    const rows = this.#database
      .prepare(
        `SELECT ${RUN_COLUMNS}
         FROM factory_external_pr_repair_qualification_runs AS run
         WHERE run.repository_id = ? AND run.qualification_policy_digest = ?
           AND (
             SELECT event.to_state
             FROM factory_external_pr_repair_qualification_events AS event
             WHERE event.qualification_run_id = run.qualification_run_id
             ORDER BY event.sequence DESC LIMIT 1
           ) IN (
             'ready', 'workspace-active', 'gating', 'gate-active', 'reviewing',
             'reviewer-active', 'recorded'
           )
         ORDER BY run.created_at, run.qualification_run_id
         LIMIT ?`
      )
      .all(input.repositoryId, input.qualificationPolicyDigest, input.limit) as unknown as RunRow[];
    return Promise.resolve(rows.map((row) => this.#snapshot(this.#runFromRow(row))));
  }

  public findCandidateByRepairBundle(
    repairBundleDigest: Sha256Digest
  ): Promise<FactoryExternalPullRequestRepairQualificationCandidate | null> {
    const row = this.#database
      .prepare(
        `${CANDIDATE_SELECT}
         WHERE repair.bundle_digest = ?
           AND EXISTS (
             SELECT 1 FROM factory_external_pr_repair_execution_events AS event
             WHERE event.run_id = execution.run_id AND event.kind = 'completed'
           )`
      )
      .get(repairBundleDigest) as CandidateRow | undefined;
    return Promise.resolve(row === undefined ? null : this.#candidate(row));
  }

  public register(
    policyClaim: CanonicalFactoryDocument<FactoryExternalPullRequestRepairQualificationPolicy>,
    runClaim: CanonicalFactoryDocument<FactoryExternalPullRequestRepairQualificationRun>,
    eventClaim: CanonicalFactoryDocument<FactoryExternalPullRequestRepairQualificationEvent>,
    candidate: FactoryExternalPullRequestRepairQualificationCandidate,
    repairerRecordClaim: CanonicalFactoryDocument<FactoryExternalPullRequestRepairerRecord>
  ): Promise<FactoryExternalPullRequestRepairQualificationJournalSnapshot> {
    const policy = this.#documents.externalPullRequestRepairQualificationPolicy(policyClaim.value);
    const run = this.#verifiedRun(runClaim);
    const event = this.#verifiedEvent(eventClaim);
    const repairerRecord = this.#documents.externalPullRequestRepairerRecord(
      repairerRecordClaim.value
    );
    if (policy.digest !== policyClaim.digest || policy.json !== policyClaim.json) {
      throw new Error("External repair qualification policy claim is not canonical.");
    }
    if (
      repairerRecord.digest !== repairerRecordClaim.digest ||
      repairerRecord.json !== repairerRecordClaim.json
    ) {
      throw new Error("External repair qualification repairer record claim is not canonical.");
    }
    assertExternalPullRequestRepairQualificationRun(
      policy,
      candidate,
      run,
      repairerRecord,
      this.#documents
    );
    assertExternalPullRequestRepairQualificationRegistration(run, event);
    return Promise.resolve(
      this.#transaction(() => {
        this.#assertCandidatePresent(candidate);
        this.#database
          .prepare(
            `INSERT INTO factory_external_pr_repair_qualification_runs (
              qualification_run_id, run_digest, repository_id, pull_request_number,
              repair_run_id, repair_run_digest, repair_bundle_digest,
              repair_execution_policy_digest, qualification_policy_digest, gate_profile_digest,
              workspace_id, expected_head_revision, repaired_patch_digest, created_at, deadline_at,
              correlation_id, run_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            run.value.qualificationRunId,
            run.digest,
            run.value.repositoryId,
            run.value.pullRequestNumber,
            run.value.repairRunId,
            run.value.repairRunDigest,
            run.value.repairBundleDigest,
            run.value.repairExecutionPolicyDigest,
            run.value.qualificationPolicyDigest,
            run.value.gateProfileDigest,
            run.value.workspaceId,
            run.value.expectedHeadRevision,
            run.value.repairedPatchDigest,
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

  public findByRepairBundle(
    repairBundleDigest: Sha256Digest,
    qualificationPolicyDigest: Sha256Digest
  ): Promise<FactoryExternalPullRequestRepairQualificationJournalSnapshot | null> {
    const row = this.#database
      .prepare(
        `SELECT ${RUN_COLUMNS}
         FROM factory_external_pr_repair_qualification_runs
         WHERE repair_bundle_digest = ? AND qualification_policy_digest = ?`
      )
      .get(repairBundleDigest, qualificationPolicyDigest) as RunRow | undefined;
    return Promise.resolve(row === undefined ? null : this.#snapshot(this.#runFromRow(row)));
  }

  public append(
    eventClaim: CanonicalFactoryDocument<FactoryExternalPullRequestRepairQualificationEvent>
  ): Promise<FactoryExternalPullRequestRepairQualificationJournalSnapshot | null> {
    const event = this.#verifiedEvent(eventClaim);
    if (event.value.kind === "bundle-recorded") {
      throw new Error("Qualification bundles must be recorded atomically with their event.");
    }
    return Promise.resolve(
      this.#transaction(() => {
        const run = this.#findRun(event.value.qualificationRunId);
        if (run?.digest !== event.value.runDigest) return null;
        const history = this.#readEvents(run);
        assertExternalPullRequestRepairQualificationEvent(run, event, history);
        const bundle = this.#readBundle(run, history);
        if (
          event.value.kind === "completed" &&
          (bundle?.decision !== event.value.decision ||
            qualificationBundleDigest(history) !== event.value.bundleDigest)
        ) {
          throw new Error("Qualification completion disagrees with its recorded bundle.");
        }
        this.#insertEvent(event);
        return snapshotFrom(run, [...history, event], bundle);
      })
    );
  }

  public recordBundle(
    eventClaim: CanonicalFactoryDocument<FactoryExternalPullRequestRepairQualificationEvent>,
    bundleClaim: CanonicalFactoryDocument<FactoryExternalPullRequestRepairQualificationBundle>
  ): Promise<FactoryExternalPullRequestRepairQualificationJournalSnapshot | null> {
    const event = this.#verifiedEvent(eventClaim);
    const bundle = this.#verifiedBundle(bundleClaim);
    if (event.value.kind !== "bundle-recorded") {
      throw new Error("Qualification bundle recording requires a bundle event.");
    }
    return Promise.resolve(
      this.#transaction(() => {
        const run = this.#findRun(event.value.qualificationRunId);
        if (run?.digest !== event.value.runDigest) return null;
        const history = this.#readEvents(run);
        assertExternalPullRequestRepairQualificationEvent(run, event, history);
        assertExternalPullRequestRepairQualificationBundle(
          run,
          bundle,
          event,
          history,
          this.#documents
        );
        this.#database
          .prepare(
            `INSERT INTO factory_external_pr_repair_qualification_bundles (
              qualification_run_id, run_digest, bundle_digest, repair_bundle_digest,
              repaired_patch_digest, decision, bundle_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            run.value.qualificationRunId,
            run.digest,
            bundle.digest,
            run.value.repairBundleDigest,
            bundle.value.repairedPatchArtifact.digest,
            bundle.value.decision,
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

  #candidate(row: CandidateRow): FactoryExternalPullRequestRepairQualificationCandidate {
    const repairRun = this.#documents.externalPullRequestRepairExecutionRun(
      parseJson(row.repair_run_json, "repair run")
    );
    const repairBundle = this.#documents.externalPullRequestRepairBundle(
      parseJson(row.repair_bundle_json, "repair bundle")
    );
    const feedbackRun = this.#documents.externalPullRequestFeedbackRun(
      parseJson(row.feedback_run_json, "feedback run")
    );
    if (
      repairRun.digest !== row.repair_run_digest ||
      repairBundle.digest !== row.repair_bundle_digest ||
      feedbackRun.digest !== row.feedback_run_digest ||
      repairBundle.value.repairRunId !== repairRun.value.runId ||
      repairBundle.value.runDigest !== repairRun.digest ||
      feedbackRun.digest !== repairRun.value.feedbackPublicationRunDigest ||
      feedbackRun.value.bundleDigest !== repairRun.value.reviewBundleDigest
    ) {
      throw new Error("Stored repair qualification candidate failed transitive validation.");
    }
    return { repairRun, repairBundle, feedbackRun };
  }

  #assertCandidatePresent(candidate: FactoryExternalPullRequestRepairQualificationCandidate): void {
    const row = this.#database
      .prepare(
        `${CANDIDATE_SELECT}
         WHERE execution.run_id = ?
           AND execution.run_digest = ?
           AND repair.bundle_digest = ?
           AND EXISTS (
             SELECT 1 FROM factory_external_pr_repair_execution_events AS event
             WHERE event.run_id = execution.run_id AND event.kind = 'completed'
           )`
      )
      .get(
        candidate.repairRun.value.runId,
        candidate.repairRun.digest,
        candidate.repairBundle.digest
      ) as CandidateRow | undefined;
    if (row === undefined) {
      throw new Error("Qualification run is not rooted in one completed external repair.");
    }
    const stored = this.#candidate(row);
    if (
      stored.repairRun.json !== candidate.repairRun.json ||
      stored.repairBundle.json !== candidate.repairBundle.json ||
      stored.feedbackRun.json !== candidate.feedbackRun.json
    ) {
      throw new Error("Qualification candidate changed after queue projection.");
    }
  }

  #snapshot(
    run: CanonicalFactoryDocument<FactoryExternalPullRequestRepairQualificationRun>
  ): FactoryExternalPullRequestRepairQualificationJournalSnapshot {
    const history = this.#readEvents(run);
    return snapshotFrom(run, history, this.#readBundle(run, history));
  }

  #findRun(
    qualificationRunId: string
  ): CanonicalFactoryDocument<FactoryExternalPullRequestRepairQualificationRun> | null {
    const row = this.#database
      .prepare(
        `SELECT ${RUN_COLUMNS}
         FROM factory_external_pr_repair_qualification_runs
         WHERE qualification_run_id = ?`
      )
      .get(qualificationRunId) as RunRow | undefined;
    return row === undefined ? null : this.#runFromRow(row);
  }

  #runFromRow(
    row: RunRow
  ): CanonicalFactoryDocument<FactoryExternalPullRequestRepairQualificationRun> {
    const run = this.#documents.externalPullRequestRepairQualificationRun(
      parseJson(row.run_json, "qualification run")
    );
    const expected = [
      row.qualification_run_id,
      row.run_digest,
      row.repository_id,
      row.pull_request_number,
      row.repair_run_id,
      row.repair_run_digest,
      row.repair_bundle_digest,
      row.repair_execution_policy_digest,
      row.qualification_policy_digest,
      row.gate_profile_digest,
      row.workspace_id,
      row.expected_head_revision,
      row.repaired_patch_digest,
      row.created_at,
      row.deadline_at,
      row.correlation_id,
      row.run_json
    ];
    const actual = [
      run.value.qualificationRunId,
      run.digest,
      run.value.repositoryId,
      run.value.pullRequestNumber,
      run.value.repairRunId,
      run.value.repairRunDigest,
      run.value.repairBundleDigest,
      run.value.repairExecutionPolicyDigest,
      run.value.qualificationPolicyDigest,
      run.value.gateProfileDigest,
      run.value.workspaceId,
      run.value.expectedHeadRevision,
      run.value.repairedPatchDigest,
      run.value.createdAt,
      run.value.deadlineAt,
      run.value.correlationId,
      run.json
    ];
    if (expected.some((value, index) => value !== actual[index])) {
      throw new Error("Stored external repair qualification run failed column validation.");
    }
    return run;
  }

  #readEvents(
    run: CanonicalFactoryDocument<FactoryExternalPullRequestRepairQualificationRun>
  ): readonly CanonicalFactoryDocument<FactoryExternalPullRequestRepairQualificationEvent>[] {
    const rows = this.#database
      .prepare(
        `SELECT event_digest, event_json
         FROM factory_external_pr_repair_qualification_events
         WHERE qualification_run_id = ? ORDER BY sequence LIMIT 129`
      )
      .all(run.value.qualificationRunId) as unknown as EventRow[];
    if (rows.length < 1 || rows.length > 128) {
      throw new Error("Stored repair qualification event count is invalid.");
    }
    const history: CanonicalFactoryDocument<FactoryExternalPullRequestRepairQualificationEvent>[] =
      [];
    for (const row of rows) {
      const event = this.#documents.externalPullRequestRepairQualificationEvent(
        parseJson(row.event_json, "qualification event")
      );
      if (event.digest !== row.event_digest) {
        throw new Error("Stored repair qualification event failed digest validation.");
      }
      if (history.length === 0) {
        assertExternalPullRequestRepairQualificationRegistration(run, event);
      } else {
        assertExternalPullRequestRepairQualificationEvent(run, event, history);
      }
      history.push(event);
    }
    return history;
  }

  #readBundle(
    run: CanonicalFactoryDocument<FactoryExternalPullRequestRepairQualificationRun>,
    history: readonly CanonicalFactoryDocument<FactoryExternalPullRequestRepairQualificationEvent>[]
  ): FactoryExternalPullRequestRepairQualificationBundle | null {
    const row = this.#database
      .prepare(
        `SELECT bundle_digest, bundle_json
         FROM factory_external_pr_repair_qualification_bundles
         WHERE qualification_run_id = ?`
      )
      .get(run.value.qualificationRunId) as BundleRow | undefined;
    if (row === undefined) return null;
    const bundle = this.#documents.externalPullRequestRepairQualificationBundle(
      parseJson(row.bundle_json, "qualification bundle")
    );
    const event = history.find(({ value }) => value.kind === "bundle-recorded");
    if (bundle.digest !== row.bundle_digest || event === undefined) {
      throw new Error("Stored repair qualification bundle failed digest validation.");
    }
    assertExternalPullRequestRepairQualificationBundle(
      run,
      bundle,
      event,
      history,
      this.#documents
    );
    return bundle.value;
  }

  #insertEvent(
    event: CanonicalFactoryDocument<FactoryExternalPullRequestRepairQualificationEvent>
  ): void {
    const fields = eventFields(event.value);
    this.#database
      .prepare(
        `INSERT INTO factory_external_pr_repair_qualification_events (
          event_id, qualification_run_id, run_digest, sequence, event_digest,
          previous_event_digest, kind, from_state, to_state, patch_digest,
          patch_artifact_json, gate_id, isolation_id, gate_observation_digest,
          isolation_record_digest, reviewer_id, execution_id, request_digest,
          reviewer_record_digest, review_result_digest, bundle_digest, bundle_artifact_json,
          decision, evidence_digest, occurred_at, reason_code, correlation_id, event_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.value.eventId,
        event.value.qualificationRunId,
        event.value.runDigest,
        event.value.sequence,
        event.digest,
        event.value.previousEventDigest,
        event.value.kind,
        event.value.from,
        event.value.to,
        fields.patchDigest,
        fields.patchArtifact,
        fields.gateId,
        fields.isolationId,
        fields.gateObservationDigest,
        fields.isolationRecordDigest,
        fields.reviewerId,
        fields.executionId,
        fields.requestDigest,
        fields.reviewerRecordDigest,
        fields.reviewResultDigest,
        fields.bundleDigest,
        fields.bundleArtifact,
        fields.decision,
        fields.evidenceDigest,
        event.value.occurredAt,
        event.value.reasonCode,
        event.value.correlationId,
        event.json
      );
  }

  #verifiedRun(claim: CanonicalFactoryDocument<FactoryExternalPullRequestRepairQualificationRun>) {
    const actual = this.#documents.externalPullRequestRepairQualificationRun(claim.value);
    assertClaim(claim, actual, "run");
    return actual;
  }

  #verifiedEvent(
    claim: CanonicalFactoryDocument<FactoryExternalPullRequestRepairQualificationEvent>
  ) {
    const actual = this.#documents.externalPullRequestRepairQualificationEvent(claim.value);
    assertClaim(claim, actual, "event");
    return actual;
  }

  #verifiedBundle(
    claim: CanonicalFactoryDocument<FactoryExternalPullRequestRepairQualificationBundle>
  ) {
    const actual = this.#documents.externalPullRequestRepairQualificationBundle(claim.value);
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
          "External repair qualification transaction rollback failed.",
          { cause: error }
        );
      }
      throw error;
    }
  }
}

function snapshotFrom(
  run: CanonicalFactoryDocument<FactoryExternalPullRequestRepairQualificationRun>,
  history: readonly CanonicalFactoryDocument<FactoryExternalPullRequestRepairQualificationEvent>[],
  bundle: FactoryExternalPullRequestRepairQualificationBundle | null
): FactoryExternalPullRequestRepairQualificationJournalSnapshot {
  const last = history.at(-1);
  if (last === undefined) throw new Error("External repair qualification journal has no event.");
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

function eventFields(event: FactoryExternalPullRequestRepairQualificationEvent) {
  return {
    patchDigest: event.kind === "workspace-prepared" ? event.patchDigest : null,
    patchArtifact: event.kind === "workspace-prepared" ? JSON.stringify(event.patchArtifact) : null,
    gateId: event.kind === "gate-started" || event.kind === "gate-finished" ? event.gateId : null,
    isolationId:
      event.kind === "gate-started" || event.kind === "gate-finished" ? event.isolationId : null,
    gateObservationDigest: event.kind === "gate-finished" ? event.gateObservationDigest : null,
    isolationRecordDigest: event.kind === "gate-finished" ? event.isolationRecordDigest : null,
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
    reviewerRecordDigest: event.kind === "reviewer-finished" ? event.reviewerRecordDigest : null,
    reviewResultDigest: event.kind === "reviewer-finished" ? event.reviewResultDigest : null,
    bundleDigest:
      event.kind === "bundle-recorded" || event.kind === "completed" ? event.bundleDigest : null,
    bundleArtifact: event.kind === "bundle-recorded" ? JSON.stringify(event.bundleArtifact) : null,
    decision:
      event.kind === "bundle-recorded" || event.kind === "completed" ? event.decision : null,
    evidenceDigest:
      event.kind === "failed" || event.kind === "quarantined" ? event.evidenceDigest : null
  };
}

function qualificationBundleDigest(
  history: readonly CanonicalFactoryDocument<FactoryExternalPullRequestRepairQualificationEvent>[]
): Sha256Digest | null {
  const event = [...history].reverse().find(({ value }) => value.kind === "bundle-recorded");
  return event?.value.kind === "bundle-recorded" ? event.value.bundleDigest : null;
}

function assertClaim<Value>(
  claim: CanonicalFactoryDocument<Value>,
  actual: CanonicalFactoryDocument<Value>,
  label: string
): void {
  if (claim.digest !== actual.digest || claim.json !== actual.json) {
    throw new Error(`External repair qualification ${label} claim is not canonical.`);
  }
}

function parseJson(value: unknown, label: string): unknown {
  if (typeof value !== "string") {
    throw new Error(`Stored external repair qualification ${label} is not text.`);
  }
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error(`Stored external repair qualification ${label} is invalid JSON.`, {
      cause: error
    });
  }
}

function assertLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) {
    throw new Error("External repair qualification queue limit must be between one and ten.");
  }
}
