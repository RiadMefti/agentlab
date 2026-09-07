import { DatabaseSync } from "node:sqlite";

import type {
  FactoryExternalPullRequestDiscoveryEvent,
  FactoryExternalPullRequestDiscoveryRun,
  FactoryExternalPullRequestDiscoverySnapshot
} from "@agentlab/contracts";

import type {
  FactoryExternalPullRequestDiscoveryJournalSnapshot,
  FactoryExternalPullRequestDiscoveryRepository
} from "../../domain/factory-external-pull-request-discovery-repository.js";
import {
  assertExternalPullRequestDiscoveryEvent,
  assertExternalPullRequestDiscoveryRegistration,
  assertExternalPullRequestDiscoveryRun,
  assertExternalPullRequestDiscoverySnapshot
} from "../../domain/factory-external-pull-request-discovery-integrity.js";
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
  readonly observer_id: unknown;
  readonly discovery_policy_digest: unknown;
  readonly schedule_policy_digest: unknown;
  readonly scheduled_for: unknown;
  readonly deadline_at: unknown;
  readonly created_at: unknown;
  readonly correlation_id: unknown;
  readonly run_json: unknown;
}

interface EventRow {
  readonly event_id: unknown;
  readonly run_id: unknown;
  readonly run_digest: unknown;
  readonly sequence: unknown;
  readonly event_digest: unknown;
  readonly previous_event_digest: unknown;
  readonly kind: unknown;
  readonly from_state: unknown;
  readonly to_state: unknown;
  readonly snapshot_digest: unknown;
  readonly snapshot_artifact_digest: unknown;
  readonly snapshot_artifact_size: unknown;
  readonly agent_review_candidates: unknown;
  readonly human_review_required: unknown;
  readonly deferred: unknown;
  readonly factory_owned: unknown;
  readonly has_more: unknown;
  readonly occurred_at: unknown;
  readonly reason_code: unknown;
  readonly correlation_id: unknown;
  readonly event_json: unknown;
}

interface SnapshotRow {
  readonly snapshot_digest: unknown;
  readonly snapshot_json: unknown;
}

interface CandidateRow {
  readonly pull_request_number: unknown;
  readonly candidate_digest: unknown;
  readonly candidate_json: unknown;
}

const RUN_COLUMNS = `
  run_id, run_digest, repository_id, observer_id, discovery_policy_digest,
  schedule_policy_digest, scheduled_for, deadline_at, created_at, correlation_id, run_json
`;
const EVENT_COLUMNS = `
  event_id, run_id, run_digest, sequence, event_digest, previous_event_digest, kind,
  from_state, to_state, snapshot_digest, snapshot_artifact_digest,
  snapshot_artifact_size, agent_review_candidates, human_review_required, deferred,
  factory_owned, has_more, occurred_at, reason_code, correlation_id, event_json
`;

export interface SqliteFactoryExternalPullRequestDiscoveryRepositoryOptions extends SqliteDatabaseOptions {
  readonly documents?: FactoryDocumentCodec;
}

/** Append-only journal plus immutable candidate projection for external PR inventory. */
export class SqliteFactoryExternalPullRequestDiscoveryRepository implements FactoryExternalPullRequestDiscoveryRepository {
  readonly #database: DatabaseSync;
  readonly #documents: FactoryDocumentCodec;

  public constructor(
    databasePath: string,
    options: SqliteFactoryExternalPullRequestDiscoveryRepositoryOptions = {}
  ) {
    this.#database = openSqliteDatabase(databasePath, options);
    this.#documents = options.documents ?? new NodeFactoryDocumentCodec();
  }

  public register(
    runClaim: CanonicalFactoryDocument<FactoryExternalPullRequestDiscoveryRun>,
    eventClaim: CanonicalFactoryDocument<FactoryExternalPullRequestDiscoveryEvent>
  ): Promise<FactoryExternalPullRequestDiscoveryJournalSnapshot> {
    const run = this.#verifiedRun(runClaim);
    const event = this.#verifiedEvent(eventClaim);
    assertExternalPullRequestDiscoveryRun(run, this.#documents);
    assertExternalPullRequestDiscoveryRegistration(run, event);
    const result = this.#inTransaction(() => {
      this.#database
        .prepare(
          `INSERT INTO factory_external_pr_discovery_runs (
            run_id, run_digest, repository_id, observer_id, discovery_policy_digest,
            schedule_policy_digest, scheduled_for, deadline_at, created_at,
            correlation_id, run_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          run.value.runId,
          run.digest,
          run.value.repositoryId,
          run.value.observerId,
          run.value.discoveryPolicyDigest,
          run.value.schedulePolicyDigest,
          run.value.scheduledFor,
          run.value.deadlineAt,
          run.value.createdAt,
          run.value.correlationId,
          run.json
        );
      this.#insertEvent(event);
      return snapshotFrom(run, [event], null);
    });
    return Promise.resolve(result);
  }

  public findBySlot(input: {
    readonly repositoryId: string;
    readonly schedulePolicyDigest: string;
    readonly scheduledFor: string;
  }): Promise<FactoryExternalPullRequestDiscoveryJournalSnapshot | null> {
    const row = this.#database
      .prepare(
        `SELECT ${RUN_COLUMNS}
         FROM factory_external_pr_discovery_runs
         WHERE repository_id = ? AND schedule_policy_digest = ? AND scheduled_for = ?`
      )
      .get(input.repositoryId, input.schedulePolicyDigest, input.scheduledFor) as
      RunRow | undefined;
    return Promise.resolve(row === undefined ? null : this.#snapshot(this.#runFromRow(row)));
  }

  public append(
    eventClaim: CanonicalFactoryDocument<FactoryExternalPullRequestDiscoveryEvent>
  ): Promise<FactoryExternalPullRequestDiscoveryJournalSnapshot | null> {
    const event = this.#verifiedEvent(eventClaim);
    if (event.value.kind === "snapshot-recorded") {
      throw new Error("External PR snapshots must be recorded atomically with their event.");
    }
    const result = this.#inTransaction(() => {
      const run = this.#findRun(event.value.runId);
      if (run?.digest !== event.value.runDigest) return null;
      const history = this.#readEvents(run);
      assertExternalPullRequestDiscoveryEvent(run, event, history);
      const discoverySnapshot = this.#readSnapshot(run);
      if (event.value.kind === "completed") {
        this.#assertCompletion(event.value, discoverySnapshot);
      }
      this.#insertEvent(event);
      return snapshotFrom(run, [...history, event], discoverySnapshot);
    });
    return Promise.resolve(result);
  }

  public recordSnapshot(
    eventClaim: CanonicalFactoryDocument<FactoryExternalPullRequestDiscoveryEvent>,
    snapshotClaim: CanonicalFactoryDocument<FactoryExternalPullRequestDiscoverySnapshot>
  ): Promise<FactoryExternalPullRequestDiscoveryJournalSnapshot | null> {
    const event = this.#verifiedEvent(eventClaim);
    const discoverySnapshot = this.#verifiedSnapshot(snapshotClaim);
    if (event.value.kind !== "snapshot-recorded") {
      throw new Error("External PR snapshot recording requires a snapshot event.");
    }
    const result = this.#inTransaction(() => {
      const run = this.#findRun(event.value.runId);
      if (run?.digest !== event.value.runDigest) return null;
      const history = this.#readEvents(run);
      assertExternalPullRequestDiscoveryEvent(run, event, history);
      assertExternalPullRequestDiscoverySnapshot(run, discoverySnapshot, event, this.#documents);
      this.#database
        .prepare(
          `INSERT INTO factory_external_pr_discovery_snapshots (
            run_id, run_digest, snapshot_digest, repository_id, observer_id,
            scheduled_for, observed_at, has_more, snapshot_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          run.value.runId,
          run.digest,
          discoverySnapshot.digest,
          discoverySnapshot.value.repositoryId,
          discoverySnapshot.value.observerId,
          discoverySnapshot.value.scheduledFor,
          discoverySnapshot.value.observedAt,
          discoverySnapshot.value.hasMore ? 1 : 0,
          discoverySnapshot.json
        );
      const insertCandidate = this.#database.prepare(
        `INSERT INTO factory_external_pr_discovery_candidates (
          run_id, repository_id, pull_request_number, head_revision, disposition,
          candidate_digest, candidate_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      for (const candidateValue of discoverySnapshot.value.pullRequests) {
        const candidate = this.#documents.externalPullRequestCandidate(candidateValue);
        insertCandidate.run(
          run.value.runId,
          candidate.value.repositoryId,
          candidate.value.pullRequestNumber,
          candidate.value.head.revision,
          candidate.value.disposition,
          candidate.digest,
          candidate.json
        );
      }
      this.#insertEvent(event);
      return snapshotFrom(run, [...history, event], discoverySnapshot.value);
    });
    return Promise.resolve(result);
  }

  public close(): void {
    this.#database.close();
  }

  #findRun(runId: string): CanonicalFactoryDocument<FactoryExternalPullRequestDiscoveryRun> | null {
    const row = this.#database
      .prepare(`SELECT ${RUN_COLUMNS} FROM factory_external_pr_discovery_runs WHERE run_id = ?`)
      .get(runId) as RunRow | undefined;
    return row === undefined ? null : this.#runFromRow(row);
  }

  #snapshot(
    run: CanonicalFactoryDocument<FactoryExternalPullRequestDiscoveryRun>
  ): FactoryExternalPullRequestDiscoveryJournalSnapshot {
    return snapshotFrom(run, this.#readEvents(run), this.#readSnapshot(run));
  }

  #runFromRow(row: RunRow): CanonicalFactoryDocument<FactoryExternalPullRequestDiscoveryRun> {
    const run = this.#documents.externalPullRequestDiscoveryRun(parseJson(row.run_json, "run"));
    assertExternalPullRequestDiscoveryRun(run, this.#documents);
    if (
      row.run_id !== run.value.runId ||
      row.run_digest !== run.digest ||
      row.repository_id !== run.value.repositoryId ||
      row.observer_id !== run.value.observerId ||
      row.discovery_policy_digest !== run.value.discoveryPolicyDigest ||
      row.schedule_policy_digest !== run.value.schedulePolicyDigest ||
      row.scheduled_for !== run.value.scheduledFor ||
      row.deadline_at !== run.value.deadlineAt ||
      row.created_at !== run.value.createdAt ||
      row.correlation_id !== run.value.correlationId ||
      row.run_json !== run.json
    ) {
      throw new Error(
        `Stored external PR discovery run ${run.value.runId} failed integrity validation.`
      );
    }
    return run;
  }

  #readEvents(
    run: CanonicalFactoryDocument<FactoryExternalPullRequestDiscoveryRun>
  ): readonly CanonicalFactoryDocument<FactoryExternalPullRequestDiscoveryEvent>[] {
    const rows = this.#database
      .prepare(
        `SELECT ${EVENT_COLUMNS} FROM factory_external_pr_discovery_events
         WHERE run_id = ? ORDER BY sequence LIMIT 9`
      )
      .all(run.value.runId) as unknown as EventRow[];
    if (rows.length === 0 || rows.length > 8) {
      throw new Error(`External PR discovery run ${run.value.runId} has an invalid event count.`);
    }
    const events: CanonicalFactoryDocument<FactoryExternalPullRequestDiscoveryEvent>[] = [];
    for (const row of rows) {
      const event = this.#eventFromRow(row);
      if (events.length === 0) assertExternalPullRequestDiscoveryRegistration(run, event);
      else assertExternalPullRequestDiscoveryEvent(run, event, events);
      events.push(event);
    }
    return events;
  }

  #eventFromRow(row: EventRow) {
    const event = this.#documents.externalPullRequestDiscoveryEvent(
      parseJson(row.event_json, "event")
    );
    const fields = eventFields(event.value);
    if (
      row.event_id !== event.value.eventId ||
      row.run_id !== event.value.runId ||
      row.run_digest !== event.value.runDigest ||
      row.sequence !== event.value.sequence ||
      row.event_digest !== event.digest ||
      row.previous_event_digest !== event.value.previousEventDigest ||
      row.kind !== event.value.kind ||
      row.from_state !== event.value.from ||
      row.to_state !== event.value.to ||
      row.snapshot_digest !== fields.snapshotDigest ||
      row.snapshot_artifact_digest !== fields.snapshotArtifactDigest ||
      row.snapshot_artifact_size !== fields.snapshotArtifactSize ||
      row.agent_review_candidates !== fields.agentReviewCandidates ||
      row.human_review_required !== fields.humanReviewRequired ||
      row.deferred !== fields.deferred ||
      row.factory_owned !== fields.factoryOwned ||
      row.has_more !== fields.hasMore ||
      row.occurred_at !== event.value.occurredAt ||
      row.reason_code !== event.value.reasonCode ||
      row.correlation_id !== event.value.correlationId ||
      row.event_json !== event.json
    ) {
      throw new Error(
        `Stored external PR discovery event ${event.value.eventId} failed integrity validation.`
      );
    }
    return event;
  }

  #readSnapshot(
    run: CanonicalFactoryDocument<FactoryExternalPullRequestDiscoveryRun>
  ): FactoryExternalPullRequestDiscoverySnapshot | null {
    const row = this.#database
      .prepare(
        `SELECT snapshot_digest, snapshot_json
         FROM factory_external_pr_discovery_snapshots WHERE run_id = ?`
      )
      .get(run.value.runId) as SnapshotRow | undefined;
    if (row === undefined) return null;
    const snapshot = this.#documents.externalPullRequestDiscoverySnapshot(
      parseJson(row.snapshot_json, "snapshot")
    );
    if (row.snapshot_digest !== snapshot.digest || row.snapshot_json !== snapshot.json) {
      throw new Error(
        `Stored external PR discovery snapshot ${run.value.runId} failed integrity validation.`
      );
    }
    const rows = this.#database
      .prepare(
        `SELECT pull_request_number, candidate_digest, candidate_json
         FROM factory_external_pr_discovery_candidates
         WHERE run_id = ? ORDER BY pull_request_number`
      )
      .all(run.value.runId) as unknown as CandidateRow[];
    const expected = [...snapshot.value.pullRequests].sort(
      (left, right) => left.pullRequestNumber - right.pullRequestNumber
    );
    if (rows.length !== expected.length) {
      throw new Error("Stored external PR candidate projection is incomplete.");
    }
    for (const [index, rowValue] of rows.entries()) {
      const candidate = this.#documents.externalPullRequestCandidate(
        parseJson(rowValue.candidate_json, "candidate")
      );
      const expectedCandidate = this.#documents.externalPullRequestCandidate(expected[index]);
      if (
        rowValue.pull_request_number !== candidate.value.pullRequestNumber ||
        rowValue.candidate_digest !== candidate.digest ||
        rowValue.candidate_json !== candidate.json ||
        candidate.digest !== expectedCandidate.digest
      ) {
        throw new Error("Stored external PR candidate projection failed integrity validation.");
      }
    }
    return snapshot.value;
  }

  #insertEvent(event: CanonicalFactoryDocument<FactoryExternalPullRequestDiscoveryEvent>): void {
    const fields = eventFields(event.value);
    this.#database
      .prepare(
        `INSERT INTO factory_external_pr_discovery_events (
          event_id, run_id, run_digest, sequence, event_digest, previous_event_digest,
          kind, from_state, to_state, snapshot_digest, snapshot_artifact_digest,
          snapshot_artifact_size, agent_review_candidates, human_review_required,
          deferred, factory_owned, has_more, occurred_at, reason_code, correlation_id, event_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.value.eventId,
        event.value.runId,
        event.value.runDigest,
        event.value.sequence,
        event.digest,
        event.value.previousEventDigest,
        event.value.kind,
        event.value.from,
        event.value.to,
        fields.snapshotDigest,
        fields.snapshotArtifactDigest,
        fields.snapshotArtifactSize,
        fields.agentReviewCandidates,
        fields.humanReviewRequired,
        fields.deferred,
        fields.factoryOwned,
        fields.hasMore,
        event.value.occurredAt,
        event.value.reasonCode,
        event.value.correlationId,
        event.json
      );
  }

  #assertCompletion(
    event: Extract<FactoryExternalPullRequestDiscoveryEvent, { readonly kind: "completed" }>,
    snapshot: FactoryExternalPullRequestDiscoverySnapshot | null
  ): void {
    if (
      event.agentReviewCandidates !== snapshot?.counts.agentReviewCandidates ||
      event.humanReviewRequired !== snapshot.counts.humanReviewRequired ||
      event.deferred !== snapshot.counts.deferred ||
      event.factoryOwned !== snapshot.counts.factoryOwned ||
      event.hasMore !== snapshot.hasMore
    ) {
      throw new Error("External PR discovery completion disagrees with its recorded snapshot.");
    }
  }

  #verifiedRun(claim: CanonicalFactoryDocument<FactoryExternalPullRequestDiscoveryRun>) {
    const actual = this.#documents.externalPullRequestDiscoveryRun(claim.value);
    assertClaim(claim, actual, "run");
    return actual;
  }

  #verifiedEvent(claim: CanonicalFactoryDocument<FactoryExternalPullRequestDiscoveryEvent>) {
    const actual = this.#documents.externalPullRequestDiscoveryEvent(claim.value);
    assertClaim(claim, actual, "event");
    return actual;
  }

  #verifiedSnapshot(claim: CanonicalFactoryDocument<FactoryExternalPullRequestDiscoverySnapshot>) {
    const actual = this.#documents.externalPullRequestDiscoverySnapshot(claim.value);
    assertClaim(claim, actual, "snapshot");
    return actual;
  }

  #inTransaction<Value>(operation: () => Value): Value {
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
          "External PR discovery transaction rollback failed.",
          { cause: error }
        );
      }
      throw error;
    }
  }
}

function snapshotFrom(
  run: CanonicalFactoryDocument<FactoryExternalPullRequestDiscoveryRun>,
  events: readonly CanonicalFactoryDocument<FactoryExternalPullRequestDiscoveryEvent>[],
  discoverySnapshot: FactoryExternalPullRequestDiscoverySnapshot | null
): FactoryExternalPullRequestDiscoveryJournalSnapshot {
  const last = events.at(-1);
  if (last === undefined) throw new Error("External PR discovery journal has no event.");
  return {
    run: run.value,
    runDigest: run.digest,
    state: last.value.to,
    sequence: last.value.sequence,
    lastEvent: last.value,
    lastEventDigest: last.digest,
    discoverySnapshot
  };
}

function eventFields(event: FactoryExternalPullRequestDiscoveryEvent) {
  if (event.kind === "snapshot-recorded") {
    return {
      snapshotDigest: event.snapshotDigest,
      snapshotArtifactDigest: event.snapshotArtifact.digest,
      snapshotArtifactSize: event.snapshotArtifact.sizeBytes,
      agentReviewCandidates: null,
      humanReviewRequired: null,
      deferred: null,
      factoryOwned: null,
      hasMore: null
    };
  }
  if (event.kind === "completed") {
    return {
      snapshotDigest: null,
      snapshotArtifactDigest: null,
      snapshotArtifactSize: null,
      agentReviewCandidates: event.agentReviewCandidates,
      humanReviewRequired: event.humanReviewRequired,
      deferred: event.deferred,
      factoryOwned: event.factoryOwned,
      hasMore: event.hasMore ? 1 : 0
    };
  }
  return {
    snapshotDigest: null,
    snapshotArtifactDigest: null,
    snapshotArtifactSize: null,
    agentReviewCandidates: null,
    humanReviewRequired: null,
    deferred: null,
    factoryOwned: null,
    hasMore: null
  };
}

function assertClaim<Value>(
  claim: CanonicalFactoryDocument<Value>,
  actual: CanonicalFactoryDocument<Value>,
  label: string
): void {
  if (claim.digest !== actual.digest || claim.json !== actual.json) {
    throw new Error(`External PR discovery ${label} claim is not canonical.`);
  }
}

function parseJson(value: unknown, label: string): unknown {
  if (typeof value !== "string")
    throw new Error(`Stored external PR discovery ${label} is not text.`);
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error(`Stored external PR discovery ${label} is invalid JSON.`, { cause: error });
  }
}
