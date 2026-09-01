import { DatabaseSync } from "node:sqlite";

import {
  sha256DigestSchema,
  type FactoryControlEvent,
  type FactoryControlName,
  type FactoryIncidentContainment,
  type Sha256Digest
} from "@agentlab/contracts";

import type {
  FactoryIncidentContainmentRepository,
  FactoryIncidentContainmentSnapshot,
  FactoryIncidentDisableCommand
} from "../../domain/factory-incident-containment-repository.js";
import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../../domain/factory-documents.js";
import type { FactoryAuthorityState } from "../../domain/factory-task-repository.js";
import { NodeFactoryDocumentCodec } from "./canonical-factory-documents.js";
import { openSqliteDatabase, type SqliteDatabaseOptions } from "./sqlite-database.js";

interface ControlRow {
  readonly event_id: unknown;
  readonly event_digest: unknown;
  readonly control_name: unknown;
  readonly enabled: unknown;
  readonly event_json: unknown;
  readonly occurred_at: unknown;
  readonly reason: unknown;
}

interface ContainmentRow {
  readonly containment_id: unknown;
  readonly containment_digest: unknown;
  readonly health_report_digest: unknown;
  readonly health_policy_digest: unknown;
  readonly daily_quota_policy_digest: unknown;
  readonly observed_at: unknown;
  readonly broker_was_enabled: unknown;
  readonly scheduler_was_enabled: unknown;
  readonly broker_disable_event_digest: unknown;
  readonly scheduler_disable_event_digest: unknown;
  readonly contained_at: unknown;
  readonly containment_json: unknown;
}

const CONTROL_COLUMNS = `
  event_id, event_digest, control_name, enabled, event_json, occurred_at, reason
`;
const CONTAINMENT_COLUMNS = `
  containment_id, containment_digest, health_report_digest, health_policy_digest,
  daily_quota_policy_digest, observed_at, broker_was_enabled, scheduler_was_enabled,
  broker_disable_event_digest, scheduler_disable_event_digest, contained_at, containment_json
`;

export interface SqliteFactoryIncidentContainmentRepositoryOptions extends SqliteDatabaseOptions {
  readonly documents?: FactoryDocumentCodec;
}

/** Persists broker-first and scheduler-second disable evidence in one SQLite transaction. */
export class SqliteFactoryIncidentContainmentRepository implements FactoryIncidentContainmentRepository {
  readonly #database: DatabaseSync;
  readonly #documents: FactoryDocumentCodec;

  public constructor(
    databasePath: string,
    options: SqliteFactoryIncidentContainmentRepositoryOptions = {}
  ) {
    this.#database = openSqliteDatabase(databasePath, options);
    this.#documents = options.documents ?? new NodeFactoryDocumentCodec();
  }

  public disableAtomically(
    command: FactoryIncidentDisableCommand
  ): Promise<FactoryIncidentContainmentSnapshot | null> {
    const verified = this.#verifyCommand(command);
    return Promise.resolve(
      this.#inTransaction(() => {
        const existing = this.#find(verified.containment.value.healthReportDigest);
        if (existing !== null) return existing;
        if (!sameAuthority(this.#authorityState(), verified.expectedAuthority)) return null;
        if (verified.brokerDisableEvent !== null) {
          this.#insertControlEvent(verified.brokerDisableEvent);
        }
        if (verified.schedulerDisableEvent !== null) {
          this.#insertControlEvent(verified.schedulerDisableEvent);
        }
        this.#insertContainment(verified.containment);
        return snapshot(verified.containment);
      })
    );
  }

  public findByHealthReportDigest(
    healthReportDigestInput: Sha256Digest
  ): Promise<FactoryIncidentContainmentSnapshot | null> {
    const healthReportDigest = sha256DigestSchema.parse(healthReportDigestInput);
    return Promise.resolve(this.#find(healthReportDigest));
  }

  public close(): void {
    this.#database.close();
  }

  #verifyCommand(command: FactoryIncidentDisableCommand): FactoryIncidentDisableCommand {
    const containment = this.#documents.incidentContainment(command.containment.value);
    assertDocumentClaim(command.containment, containment, "incident containment");
    const report = this.#documents.operationsHealthReport(containment.value.healthReport);
    if (report.digest !== containment.value.healthReportDigest) {
      throw new Error("Incident containment health report digest does not match its evidence.");
    }
    const expected = command.expectedAuthority;
    const before = containment.value.authorityBefore;
    if (
      expected.prBroker !== before.prBrokerEnabled ||
      expected.scheduler !== before.schedulerEnabled ||
      containment.value.healthReport.authority.prBrokerEnabled !== expected.prBroker ||
      containment.value.healthReport.authority.schedulerEnabled !== expected.scheduler
    ) {
      throw new Error("Incident containment authority does not match its critical observation.");
    }
    const brokerDisableEvent = this.#verifyDisableEvent(
      command.brokerDisableEvent,
      "pr-broker",
      expected.prBroker,
      containment
    );
    const schedulerDisableEvent = this.#verifyDisableEvent(
      command.schedulerDisableEvent,
      "scheduler",
      expected.scheduler,
      containment
    );
    return { expectedAuthority: expected, brokerDisableEvent, schedulerDisableEvent, containment };
  }

  #verifyDisableEvent(
    claim: CanonicalFactoryDocument<FactoryControlEvent> | null,
    control: FactoryControlName,
    required: boolean,
    containment: CanonicalFactoryDocument<FactoryIncidentContainment>
  ): CanonicalFactoryDocument<FactoryControlEvent> | null {
    if ((claim !== null) !== required) {
      throw new Error(`Incident containment ${control} disable evidence is incomplete.`);
    }
    if (claim === null) return null;
    const event = this.#documents.controlEvent(claim.value);
    assertDocumentClaim(claim, event, `${control} disable event`);
    const recordedDigest =
      control === "pr-broker"
        ? containment.value.brokerDisableEventDigest
        : containment.value.schedulerDisableEventDigest;
    if (
      event.value.control !== control ||
      event.value.enabled ||
      event.digest !== recordedDigest ||
      event.value.occurredAt !== containment.value.containedAt ||
      !sameActor(event.value.actor, containment.value.actor) ||
      !event.value.reason.includes(containment.value.healthReportDigest)
    ) {
      throw new Error(`Incident containment ${control} event is not a bound disable event.`);
    }
    return event;
  }

  #insertControlEvent(event: CanonicalFactoryDocument<FactoryControlEvent>): void {
    this.#database
      .prepare(
        `INSERT INTO factory_control_events (
          event_id, event_digest, control_name, enabled, event_json, occurred_at, reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.value.eventId,
        event.digest,
        event.value.control,
        event.value.enabled ? 1 : 0,
        event.json,
        event.value.occurredAt,
        event.value.reason
      );
  }

  #insertContainment(containment: CanonicalFactoryDocument<FactoryIncidentContainment>): void {
    const value = containment.value;
    this.#database
      .prepare(
        `INSERT INTO factory_incident_containments (
          containment_id, containment_digest, health_report_digest, health_policy_digest,
          daily_quota_policy_digest, observed_at, broker_was_enabled, scheduler_was_enabled,
          broker_disable_event_digest, scheduler_disable_event_digest, contained_at,
          containment_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        value.containmentId,
        containment.digest,
        value.healthReportDigest,
        value.healthReport.healthPolicyDigest,
        value.healthReport.dailyQuotaPolicyDigest,
        value.healthReport.observedAt,
        value.authorityBefore.prBrokerEnabled ? 1 : 0,
        value.authorityBefore.schedulerEnabled ? 1 : 0,
        value.brokerDisableEventDigest,
        value.schedulerDisableEventDigest,
        value.containedAt,
        containment.json
      );
  }

  #find(healthReportDigest: Sha256Digest): FactoryIncidentContainmentSnapshot | null {
    const row = this.#database
      .prepare(
        `SELECT ${CONTAINMENT_COLUMNS}
         FROM factory_incident_containments WHERE health_report_digest = ?`
      )
      .get(healthReportDigest) as ContainmentRow | undefined;
    return row === undefined ? null : snapshot(this.#containmentFromRow(row));
  }

  #containmentFromRow(row: ContainmentRow): CanonicalFactoryDocument<FactoryIncidentContainment> {
    const containment = this.#documents.incidentContainment(
      parseJson(row.containment_json, "factory incident containment")
    );
    const report = this.#documents.operationsHealthReport(containment.value.healthReport);
    if (
      row.containment_id !== containment.value.containmentId ||
      row.containment_digest !== containment.digest ||
      row.health_report_digest !== containment.value.healthReportDigest ||
      row.health_report_digest !== report.digest ||
      row.health_policy_digest !== containment.value.healthReport.healthPolicyDigest ||
      row.daily_quota_policy_digest !== containment.value.healthReport.dailyQuotaPolicyDigest ||
      row.observed_at !== containment.value.healthReport.observedAt ||
      row.broker_was_enabled !== (containment.value.authorityBefore.prBrokerEnabled ? 1 : 0) ||
      row.scheduler_was_enabled !== (containment.value.authorityBefore.schedulerEnabled ? 1 : 0) ||
      row.broker_disable_event_digest !== containment.value.brokerDisableEventDigest ||
      row.scheduler_disable_event_digest !== containment.value.schedulerDisableEventDigest ||
      row.contained_at !== containment.value.containedAt ||
      row.containment_json !== containment.json
    ) {
      throw new Error("Stored factory incident containment failed immutable validation.");
    }
    this.#validateStoredDisableEvent(
      containment.value.brokerDisableEventDigest,
      "pr-broker",
      containment
    );
    this.#validateStoredDisableEvent(
      containment.value.schedulerDisableEventDigest,
      "scheduler",
      containment
    );
    return containment;
  }

  #validateStoredDisableEvent(
    digest: Sha256Digest | null,
    control: FactoryControlName,
    containment: CanonicalFactoryDocument<FactoryIncidentContainment>
  ): void {
    if (digest === null) return;
    const row = this.#database
      .prepare(`SELECT ${CONTROL_COLUMNS} FROM factory_control_events WHERE event_digest = ?`)
      .get(digest) as ControlRow | undefined;
    if (row === undefined) throw new Error("Stored incident disable event is missing.");
    const event = this.#controlFromRow(row);
    if (
      event.value.control !== control ||
      event.value.enabled ||
      event.value.occurredAt !== containment.value.containedAt ||
      !sameActor(event.value.actor, containment.value.actor) ||
      !event.value.reason.includes(containment.value.healthReportDigest)
    ) {
      throw new Error("Stored incident disable event failed containment validation.");
    }
  }

  #authorityState(): FactoryAuthorityState {
    return {
      scheduler: this.#latestControlValue("scheduler"),
      prBroker: this.#latestControlValue("pr-broker")
    };
  }

  #latestControlValue(control: FactoryControlName): boolean {
    const row = this.#database
      .prepare(
        `SELECT ${CONTROL_COLUMNS} FROM factory_control_events
         WHERE control_name = ? ORDER BY sequence DESC LIMIT 1`
      )
      .get(control) as ControlRow | undefined;
    return row === undefined ? false : this.#controlFromRow(row).value.enabled;
  }

  #controlFromRow(row: ControlRow): CanonicalFactoryDocument<FactoryControlEvent> {
    const event = this.#documents.controlEvent(parseJson(row.event_json, "factory control event"));
    if (
      row.event_id !== event.value.eventId ||
      row.event_digest !== event.digest ||
      row.control_name !== event.value.control ||
      row.enabled !== (event.value.enabled ? 1 : 0) ||
      row.occurred_at !== event.value.occurredAt ||
      row.reason !== event.value.reason ||
      row.event_json !== event.json
    ) {
      throw new Error("Stored factory control event failed immutable validation.");
    }
    return event;
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
      } catch (rollbackError: unknown) {
        throw new AggregateError(
          [error, rollbackError],
          "Incident containment and rollback both failed.",
          { cause: error }
        );
      }
      throw error;
    }
  }
}

function snapshot(
  containment: CanonicalFactoryDocument<FactoryIncidentContainment>
): FactoryIncidentContainmentSnapshot {
  return { containment: containment.value, containmentDigest: containment.digest };
}

function sameAuthority(left: FactoryAuthorityState, right: FactoryAuthorityState): boolean {
  return left.scheduler === right.scheduler && left.prBroker === right.prBroker;
}

function sameActor(
  left: FactoryControlEvent["actor"],
  right: FactoryIncidentContainment["actor"]
): boolean {
  return (
    left.kind === right.kind &&
    left.role === right.role &&
    left.id === right.id &&
    left.sessionId === right.sessionId
  );
}

function assertDocumentClaim<Value>(
  claimed: CanonicalFactoryDocument<Value>,
  actual: CanonicalFactoryDocument<Value>,
  label: string
): void {
  if (claimed.digest !== actual.digest || claimed.json !== actual.json) {
    throw new Error(`Claimed ${label} does not match its canonical document.`);
  }
}

function parseJson(value: unknown, label: string): unknown {
  if (typeof value !== "string") throw new Error(`Stored ${label} is not text.`);
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error(`Stored ${label} is invalid JSON.`, { cause: error });
  }
}
