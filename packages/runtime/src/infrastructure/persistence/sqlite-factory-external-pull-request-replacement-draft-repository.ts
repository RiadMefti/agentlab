import { DatabaseSync } from "node:sqlite";

import type {
  FactoryExternalPullRequestReplacementDraftEvent,
  FactoryExternalPullRequestReplacementDraftPolicy,
  FactoryExternalPullRequestReplacementDraftRecord,
  FactoryExternalPullRequestReplacementDraftRun,
  Sha256Digest
} from "@agentlab/contracts";

import {
  assertExternalPullRequestReplacementDraftEvent,
  assertExternalPullRequestReplacementDraftRecord,
  assertExternalPullRequestReplacementDraftRegistration,
  assertExternalPullRequestReplacementDraftRun
} from "../../domain/factory-external-pull-request-replacement-draft-integrity.js";
import type {
  FactoryExternalPullRequestReplacementDraftCandidate,
  FactoryExternalPullRequestReplacementDraftJournalSnapshot,
  FactoryExternalPullRequestReplacementDraftRepository
} from "../../domain/factory-external-pull-request-replacement-draft-repository.js";
import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../../domain/factory-documents.js";
import { NodeFactoryDocumentCodec } from "./canonical-factory-documents.js";
import { openSqliteDatabase, type SqliteDatabaseOptions } from "./sqlite-database.js";

interface CandidateRow {
  readonly qualification_run_digest: unknown;
  readonly qualification_run_json: unknown;
  readonly qualification_bundle_digest: unknown;
  readonly qualification_bundle_json: unknown;
  readonly repair_bundle_digest: unknown;
  readonly repair_bundle_json: unknown;
}
interface RunRow {
  readonly run_digest: unknown;
  readonly run_json: unknown;
}
interface EventRow {
  readonly event_digest: unknown;
  readonly event_json: unknown;
}
interface RecordRow {
  readonly record_digest: unknown;
  readonly record_json: unknown;
}

const CANDIDATE_SELECT = `
  SELECT qualification.run_digest AS qualification_run_digest,
    qualification.run_json AS qualification_run_json,
    bundle.bundle_digest AS qualification_bundle_digest,
    bundle.bundle_json AS qualification_bundle_json,
    repair.bundle_digest AS repair_bundle_digest,
    repair.bundle_json AS repair_bundle_json
  FROM factory_external_pr_repair_qualification_runs AS qualification
  JOIN factory_external_pr_repair_qualification_bundles AS bundle
    ON bundle.qualification_run_id = qualification.qualification_run_id
  JOIN factory_external_pr_repair_execution_bundles AS repair
    ON repair.bundle_digest = qualification.repair_bundle_digest
`;

export interface SqliteFactoryExternalPullRequestReplacementDraftRepositoryOptions extends SqliteDatabaseOptions {
  readonly documents?: FactoryDocumentCodec;
}

/** Durable qualified-repair projection and immutable remote-intent journal. */
export class SqliteFactoryExternalPullRequestReplacementDraftRepository implements FactoryExternalPullRequestReplacementDraftRepository {
  readonly #database: DatabaseSync;
  readonly #documents: FactoryDocumentCodec;

  public constructor(
    databasePath: string,
    options: SqliteFactoryExternalPullRequestReplacementDraftRepositoryOptions = {}
  ) {
    this.#database = openSqliteDatabase(databasePath, options);
    this.#documents = options.documents ?? new NodeFactoryDocumentCodec();
  }

  public listQualified(input: {
    readonly repositoryId: string;
    readonly qualificationPolicyDigest: Sha256Digest;
    readonly publicationPolicyDigest: Sha256Digest;
    readonly limit: number;
  }): Promise<readonly FactoryExternalPullRequestReplacementDraftCandidate[]> {
    assertLimit(input.limit);
    const rows = this.#database
      .prepare(
        `${CANDIDATE_SELECT}
      WHERE qualification.repository_id = ?
        AND qualification.qualification_policy_digest = ?
        AND bundle.decision = 'qualified'
        AND EXISTS (
          SELECT 1 FROM factory_external_pr_repair_qualification_events AS event
          WHERE event.qualification_run_id = qualification.qualification_run_id
            AND event.kind = 'completed' AND event.decision = 'qualified'
        )
        AND NOT EXISTS (
          SELECT 1 FROM factory_external_pr_replacement_draft_runs AS publication
          WHERE publication.qualification_bundle_digest = bundle.bundle_digest
            AND publication.publication_policy_digest = ?
        )
      ORDER BY qualification.created_at, qualification.qualification_run_id LIMIT ?`
      )
      .all(
        input.repositoryId,
        input.qualificationPolicyDigest,
        input.publicationPolicyDigest,
        input.limit
      ) as unknown as CandidateRow[];
    return Promise.resolve(rows.map((row) => this.#candidate(row)));
  }

  public listActive(input: {
    readonly repositoryId: string;
    readonly publicationPolicyDigest: Sha256Digest;
    readonly limit: number;
  }): Promise<readonly FactoryExternalPullRequestReplacementDraftJournalSnapshot[]> {
    assertLimit(input.limit);
    const rows = this.#database
      .prepare(
        `SELECT run_digest, run_json
      FROM factory_external_pr_replacement_draft_runs AS run
      WHERE repository_id = ? AND publication_policy_digest = ?
        AND (SELECT event.to_state FROM factory_external_pr_replacement_draft_events AS event
          WHERE event.publication_run_id = run.publication_run_id
          ORDER BY event.sequence DESC LIMIT 1)
          IN ('ready', 'branch-publish-intent-recorded', 'branch-published',
            'pull-request-open-intent-recorded', 'pull-request-opened')
      ORDER BY created_at, publication_run_id LIMIT ?`
      )
      .all(input.repositoryId, input.publicationPolicyDigest, input.limit) as unknown as RunRow[];
    return Promise.resolve(rows.map((row) => this.#snapshot(this.#run(row))));
  }

  public findCandidate(
    qualificationBundleDigest: Sha256Digest
  ): Promise<FactoryExternalPullRequestReplacementDraftCandidate | null> {
    const row = this.#database
      .prepare(
        `${CANDIDATE_SELECT}
      WHERE bundle.bundle_digest = ? AND bundle.decision = 'qualified'
        AND EXISTS (SELECT 1 FROM factory_external_pr_repair_qualification_events AS event
          WHERE event.qualification_run_id = qualification.qualification_run_id
            AND event.kind = 'completed' AND event.decision = 'qualified')`
      )
      .get(qualificationBundleDigest) as CandidateRow | undefined;
    return Promise.resolve(row === undefined ? null : this.#candidate(row));
  }

  public register(
    policyClaim: CanonicalFactoryDocument<FactoryExternalPullRequestReplacementDraftPolicy>,
    runClaim: CanonicalFactoryDocument<FactoryExternalPullRequestReplacementDraftRun>,
    eventClaim: CanonicalFactoryDocument<FactoryExternalPullRequestReplacementDraftEvent>,
    candidate: FactoryExternalPullRequestReplacementDraftCandidate
  ): Promise<FactoryExternalPullRequestReplacementDraftJournalSnapshot> {
    const policy = this.#documents.externalPullRequestReplacementDraftPolicy(policyClaim.value);
    const run = this.#verifiedRun(runClaim);
    const event = this.#verifiedEvent(eventClaim);
    if (policy.digest !== policyClaim.digest || policy.json !== policyClaim.json) {
      throw new Error("Replacement-draft policy claim is not canonical.");
    }
    assertExternalPullRequestReplacementDraftRun(policy, candidate, run, this.#documents);
    assertExternalPullRequestReplacementDraftRegistration(run, event);
    return Promise.resolve(
      this.#transaction(() => {
        this.#assertCandidatePresent(candidate);
        this.#database
          .prepare(
            `INSERT INTO factory_external_pr_replacement_draft_runs (
        publication_run_id, run_digest, repository_id, original_pull_request_number,
        qualification_bundle_digest, publication_policy_digest, created_at, deadline_at,
        correlation_id, run_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            run.value.publicationRunId,
            run.digest,
            run.value.repositoryId,
            run.value.originalPullRequestNumber,
            run.value.qualificationBundleDigest,
            run.value.publicationPolicyDigest,
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
    eventClaim: CanonicalFactoryDocument<FactoryExternalPullRequestReplacementDraftEvent>
  ): Promise<FactoryExternalPullRequestReplacementDraftJournalSnapshot | null> {
    const event = this.#verifiedEvent(eventClaim);
    if (event.value.kind === "pull-request-opened") {
      throw new Error("Replacement-draft record must be persisted atomically with its event.");
    }
    return Promise.resolve(
      this.#transaction(() => {
        const run = this.#findRun(event.value.publicationRunId);
        if (run?.digest !== event.value.runDigest) return null;
        const history = this.#readEvents(run);
        assertExternalPullRequestReplacementDraftEvent(run, event, history);
        const record = this.#readRecord(run, history);
        if (event.value.kind === "completed" && record === null) {
          throw new Error("Replacement-draft completion has no durable remote record.");
        }
        if (
          event.value.kind === "completed" &&
          event.value.recordDigest !== recordDigest(history)
        ) {
          throw new Error("Replacement-draft completion changed its remote record.");
        }
        this.#insertEvent(event);
        return snapshotFrom(run, [...history, event], record);
      })
    );
  }

  public record(
    eventClaim: CanonicalFactoryDocument<FactoryExternalPullRequestReplacementDraftEvent>,
    recordClaim: CanonicalFactoryDocument<FactoryExternalPullRequestReplacementDraftRecord>
  ): Promise<FactoryExternalPullRequestReplacementDraftJournalSnapshot | null> {
    const event = this.#verifiedEvent(eventClaim);
    const record = this.#documents.externalPullRequestReplacementDraftRecord(recordClaim.value);
    if (record.digest !== recordClaim.digest || record.json !== recordClaim.json) {
      throw new Error("Replacement-draft record claim is not canonical.");
    }
    return Promise.resolve(
      this.#transaction(() => {
        const run = this.#findRun(event.value.publicationRunId);
        if (run?.digest !== event.value.runDigest) return null;
        const history = this.#readEvents(run);
        assertExternalPullRequestReplacementDraftEvent(run, event, history);
        assertExternalPullRequestReplacementDraftRecord(run, event, record, history);
        this.#database
          .prepare(
            `INSERT INTO factory_external_pr_replacement_draft_records (
        publication_run_id, run_digest, record_digest, replacement_pull_request_number,
        head_revision, publisher_id, record_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            run.value.publicationRunId,
            run.digest,
            record.digest,
            record.value.replacementPullRequestNumber,
            record.value.headRevision,
            record.value.publisherId,
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

  #candidate(row: CandidateRow): FactoryExternalPullRequestReplacementDraftCandidate {
    const qualificationRun = this.#documents.externalPullRequestRepairQualificationRun(
      parseJson(row.qualification_run_json, "qualification run")
    );
    const qualificationBundle = this.#documents.externalPullRequestRepairQualificationBundle(
      parseJson(row.qualification_bundle_json, "qualification bundle")
    );
    const repairBundle = this.#documents.externalPullRequestRepairBundle(
      parseJson(row.repair_bundle_json, "repair bundle")
    );
    if (
      qualificationRun.digest !== row.qualification_run_digest ||
      qualificationBundle.digest !== row.qualification_bundle_digest ||
      repairBundle.digest !== row.repair_bundle_digest ||
      qualificationBundle.value.runDigest !== qualificationRun.digest ||
      qualificationBundle.value.repairBundleDigest !== repairBundle.digest ||
      qualificationBundle.value.decision !== "qualified"
    )
      throw new Error("Stored replacement-draft candidate failed transitive validation.");
    return { qualificationRun, qualificationBundle, repairBundle };
  }

  #assertCandidatePresent(candidate: FactoryExternalPullRequestReplacementDraftCandidate): void {
    const row = this.#database
      .prepare(
        `${CANDIDATE_SELECT}
      WHERE qualification.qualification_run_id = ? AND qualification.run_digest = ?
        AND bundle.bundle_digest = ? AND repair.bundle_digest = ?
        AND bundle.decision = 'qualified'
        AND EXISTS (SELECT 1 FROM factory_external_pr_repair_qualification_events AS event
          WHERE event.qualification_run_id = qualification.qualification_run_id
            AND event.kind = 'completed' AND event.decision = 'qualified')`
      )
      .get(
        candidate.qualificationRun.value.qualificationRunId,
        candidate.qualificationRun.digest,
        candidate.qualificationBundle.digest,
        candidate.repairBundle.digest
      ) as CandidateRow | undefined;
    if (row === undefined)
      throw new Error("Replacement-draft run is not rooted in a completed qualification.");
    const stored = this.#candidate(row);
    if (
      stored.qualificationRun.json !== candidate.qualificationRun.json ||
      stored.qualificationBundle.json !== candidate.qualificationBundle.json ||
      stored.repairBundle.json !== candidate.repairBundle.json
    ) {
      throw new Error("Replacement-draft candidate changed after queue projection.");
    }
  }

  #findRun(
    publicationRunId: string
  ): CanonicalFactoryDocument<FactoryExternalPullRequestReplacementDraftRun> | null {
    const row = this.#database
      .prepare(
        `SELECT run_digest, run_json FROM factory_external_pr_replacement_draft_runs WHERE publication_run_id = ?`
      )
      .get(publicationRunId) as RunRow | undefined;
    return row === undefined ? null : this.#run(row);
  }

  #run(row: RunRow): CanonicalFactoryDocument<FactoryExternalPullRequestReplacementDraftRun> {
    const run = this.#documents.externalPullRequestReplacementDraftRun(
      parseJson(row.run_json, "replacement-draft run")
    );
    if (run.digest !== row.run_digest)
      throw new Error("Stored replacement-draft run failed digest validation.");
    return run;
  }

  #snapshot(
    run: CanonicalFactoryDocument<FactoryExternalPullRequestReplacementDraftRun>
  ): FactoryExternalPullRequestReplacementDraftJournalSnapshot {
    const history = this.#readEvents(run);
    return snapshotFrom(run, history, this.#readRecord(run, history));
  }

  #readEvents(
    run: CanonicalFactoryDocument<FactoryExternalPullRequestReplacementDraftRun>
  ): readonly CanonicalFactoryDocument<FactoryExternalPullRequestReplacementDraftEvent>[] {
    const rows = this.#database
      .prepare(
        `SELECT event_digest, event_json FROM factory_external_pr_replacement_draft_events WHERE publication_run_id = ? ORDER BY sequence LIMIT 17`
      )
      .all(run.value.publicationRunId) as unknown as EventRow[];
    if (rows.length < 1 || rows.length > 16)
      throw new Error("Stored replacement-draft event count is invalid.");
    const history: CanonicalFactoryDocument<FactoryExternalPullRequestReplacementDraftEvent>[] = [];
    for (const row of rows) {
      const event = this.#documents.externalPullRequestReplacementDraftEvent(
        parseJson(row.event_json, "replacement-draft event")
      );
      if (event.digest !== row.event_digest)
        throw new Error("Stored replacement-draft event failed digest validation.");
      if (history.length === 0) assertExternalPullRequestReplacementDraftRegistration(run, event);
      else assertExternalPullRequestReplacementDraftEvent(run, event, history);
      history.push(event);
    }
    return history;
  }

  #readRecord(
    run: CanonicalFactoryDocument<FactoryExternalPullRequestReplacementDraftRun>,
    history: readonly CanonicalFactoryDocument<FactoryExternalPullRequestReplacementDraftEvent>[]
  ): FactoryExternalPullRequestReplacementDraftRecord | null {
    const row = this.#database
      .prepare(
        `SELECT record_digest, record_json FROM factory_external_pr_replacement_draft_records WHERE publication_run_id = ?`
      )
      .get(run.value.publicationRunId) as RecordRow | undefined;
    if (row === undefined) return null;
    const record = this.#documents.externalPullRequestReplacementDraftRecord(
      parseJson(row.record_json, "replacement-draft record")
    );
    const event = history.find(({ value }) => value.kind === "pull-request-opened");
    if (record.digest !== row.record_digest || event === undefined)
      throw new Error("Stored replacement-draft record failed digest validation.");
    assertExternalPullRequestReplacementDraftRecord(
      run,
      event,
      record,
      history.slice(0, history.indexOf(event))
    );
    return record.value;
  }

  #insertEvent(
    event: CanonicalFactoryDocument<FactoryExternalPullRequestReplacementDraftEvent>
  ): void {
    const value = event.value;
    this.#database
      .prepare(
        `INSERT INTO factory_external_pr_replacement_draft_events (
      event_id, publication_run_id, run_digest, sequence, event_digest, previous_event_digest,
      kind, from_state, to_state, proposal_digest, proposal_artifact_json, head_revision,
      record_digest, record_artifact_json, evidence_digest, occurred_at, reason_code,
      correlation_id, event_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        value.eventId,
        value.publicationRunId,
        value.runDigest,
        value.sequence,
        event.digest,
        value.previousEventDigest,
        value.kind,
        value.from,
        value.to,
        "proposalDigest" in value ? value.proposalDigest : null,
        "proposalArtifact" in value ? JSON.stringify(value.proposalArtifact) : null,
        "headRevision" in value ? value.headRevision : null,
        "recordDigest" in value ? value.recordDigest : null,
        "recordArtifact" in value ? JSON.stringify(value.recordArtifact) : null,
        "evidenceDigest" in value ? value.evidenceDigest : null,
        value.occurredAt,
        value.reasonCode,
        value.correlationId,
        event.json
      );
  }

  #verifiedRun(claim: CanonicalFactoryDocument<FactoryExternalPullRequestReplacementDraftRun>) {
    const document = this.#documents.externalPullRequestReplacementDraftRun(claim.value);
    if (document.digest !== claim.digest || document.json !== claim.json)
      throw new Error("Replacement-draft run claim is not canonical.");
    return document;
  }
  #verifiedEvent(claim: CanonicalFactoryDocument<FactoryExternalPullRequestReplacementDraftEvent>) {
    const document = this.#documents.externalPullRequestReplacementDraftEvent(claim.value);
    if (document.digest !== claim.digest || document.json !== claim.json)
      throw new Error("Replacement-draft event claim is not canonical.");
    return document;
  }
  #transaction<T>(operation: () => T): T {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const value = operation();
      this.#database.exec("COMMIT");
      return value;
    } catch (error: unknown) {
      try {
        this.#database.exec("ROLLBACK");
      } catch (rollback: unknown) {
        throw new AggregateError(
          [error, rollback],
          "Replacement-draft transaction rollback failed."
        );
      }
      throw error;
    }
  }
}

function snapshotFrom(
  run: CanonicalFactoryDocument<FactoryExternalPullRequestReplacementDraftRun>,
  history: readonly CanonicalFactoryDocument<FactoryExternalPullRequestReplacementDraftEvent>[],
  record: FactoryExternalPullRequestReplacementDraftRecord | null
): FactoryExternalPullRequestReplacementDraftJournalSnapshot {
  const last = history.at(-1);
  if (last === undefined) throw new Error("Replacement-draft journal has no events.");
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
function recordDigest(
  history: readonly CanonicalFactoryDocument<FactoryExternalPullRequestReplacementDraftEvent>[]
): Sha256Digest | null {
  const event = history.find(({ value }) => value.kind === "pull-request-opened");
  return event?.value.kind === "pull-request-opened" ? event.value.recordDigest : null;
}
function assertLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10)
    throw new Error("Replacement-draft query limit is invalid.");
}
function parseJson(value: unknown, label: string): unknown {
  if (typeof value !== "string") throw new Error(`Stored ${label} is not text.`);
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error(`Stored ${label} is not valid JSON.`, { cause: error });
  }
}
