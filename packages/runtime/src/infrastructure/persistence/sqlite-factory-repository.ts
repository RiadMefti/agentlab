import { DatabaseSync } from "node:sqlite";

import {
  type EvidenceBundle,
  factoryControlNameSchema,
  type FactoryControlEvent,
  type FactoryControlName,
  type ImmutableTaskContract,
  type Sha256Digest,
  type TaskEvent
} from "@agentlab/contracts";

import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../../domain/factory-documents.js";
import type {
  FactoryAuthorityState,
  FactoryControlRepository,
  FactoryEvidenceRepository,
  FactoryTaskRepository,
  FactoryTaskSnapshot,
  StoredEvidenceBundle
} from "../../domain/factory-task-repository.js";
import { isFactoryTaskTransitionAllowed } from "../../domain/factory-task-state.js";
import { NodeFactoryDocumentCodec } from "./canonical-factory-documents.js";
import { openSqliteDatabase, type SqliteDatabaseOptions } from "./sqlite-database.js";

interface ContractRow {
  readonly task_id: unknown;
  readonly contract_digest: unknown;
  readonly conversation_id: unknown;
  readonly repository_id: unknown;
  readonly base_revision: unknown;
  readonly risk_tier: unknown;
  readonly created_at: unknown;
  readonly expires_at: unknown;
  readonly contract_json: unknown;
}

interface EventRow {
  readonly event_id: unknown;
  readonly task_id: unknown;
  readonly sequence: unknown;
  readonly event_digest: unknown;
  readonly previous_event_digest: unknown;
  readonly contract_digest: unknown;
  readonly from_state: unknown;
  readonly to_state: unknown;
  readonly occurred_at: unknown;
  readonly correlation_id: unknown;
  readonly event_json: unknown;
}

interface ControlRow {
  readonly sequence: unknown;
  readonly event_id: unknown;
  readonly event_digest: unknown;
  readonly control_name: unknown;
  readonly enabled: unknown;
  readonly occurred_at: unknown;
  readonly reason: unknown;
  readonly event_json: unknown;
}

interface EvidenceBundleRow {
  readonly bundle_id: unknown;
  readonly bundle_digest: unknown;
  readonly task_id: unknown;
  readonly sequence: unknown;
  readonly contract_digest: unknown;
  readonly previous_bundle_digest: unknown;
  readonly policy_bundle_digest: unknown;
  readonly created_at: unknown;
  readonly bundle_json: unknown;
}

const CONTRACT_COLUMNS = `
  task_id,
  contract_digest,
  conversation_id,
  repository_id,
  base_revision,
  risk_tier,
  created_at,
  expires_at,
  contract_json
`;

const EVENT_COLUMNS = `
  event_id,
  task_id,
  sequence,
  event_digest,
  previous_event_digest,
  contract_digest,
  from_state,
  to_state,
  occurred_at,
  correlation_id,
  event_json
`;

const CONTROL_COLUMNS = `
  sequence,
  event_id,
  event_digest,
  control_name,
  enabled,
  occurred_at,
  reason,
  event_json
`;

const EVIDENCE_BUNDLE_COLUMNS = `
  bundle_id,
  bundle_digest,
  task_id,
  sequence,
  contract_digest,
  previous_bundle_digest,
  policy_bundle_digest,
  created_at,
  bundle_json
`;

const maximumTaskEvents = 10_000;
const maximumEvidenceBundles = 10_000;

export interface SqliteFactoryRepositoryOptions extends SqliteDatabaseOptions {
  readonly documents?: FactoryDocumentCodec;
}

/** SQLite-backed immutable task ledger and fail-closed authority switches. */
export class SqliteFactoryRepository
  implements FactoryTaskRepository, FactoryControlRepository, FactoryEvidenceRepository
{
  readonly #database: DatabaseSync;
  readonly #documents: FactoryDocumentCodec;

  public constructor(databasePath: string, options: SqliteFactoryRepositoryOptions = {}) {
    this.#database = openSqliteDatabase(databasePath, options);
    this.#documents = options.documents ?? new NodeFactoryDocumentCodec();
  }

  public create(
    contractDocument: CanonicalFactoryDocument<ImmutableTaskContract>,
    initialEventDocument: CanonicalFactoryDocument<TaskEvent>,
    initialEvidenceDocument: CanonicalFactoryDocument<EvidenceBundle>
  ): Promise<FactoryTaskSnapshot> {
    const contract = this.#verifiedContractDocument(contractDocument);
    const event = this.#verifiedEventDocument(initialEventDocument);
    const evidence = this.#verifiedEvidenceDocument(initialEvidenceDocument);
    assertInitialEvent(contract, event);
    assertInitialEvidence(contract, evidence);

    const snapshot = this.#inTransaction(() => {
      this.#database
        .prepare(
          `INSERT INTO factory_task_contracts (
            task_id,
            contract_digest,
            conversation_id,
            repository_id,
            base_revision,
            risk_tier,
            created_at,
            expires_at,
            contract_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          contract.value.taskId,
          contract.digest,
          contract.value.conversationId,
          contract.value.repository.id,
          contract.value.repository.baseRevision,
          contract.value.riskTier,
          contract.value.createdAt,
          contract.value.expiresAt,
          contract.json
        );
      this.#insertEvent(event);
      this.#insertEvidence(evidence);
      return snapshotFrom(contract.value, contract.digest, event.value, event.digest);
    });
    return Promise.resolve(snapshot);
  }

  public findById(taskId: string): Promise<FactoryTaskSnapshot | null> {
    const contract = this.#findContract(taskId);
    if (contract === null) return Promise.resolve(null);
    const events = this.#readEventDocuments(taskId);
    if (events.length === 0) throw new Error(`Factory task ${taskId} has no initial event.`);
    const last = events.at(-1);
    if (last === undefined) throw new Error(`Factory task ${taskId} has no last event.`);
    return Promise.resolve(snapshotFrom(contract.value, contract.digest, last.value, last.digest));
  }

  public listForConversation(
    conversationId: string,
    limit: number
  ): Promise<readonly FactoryTaskSnapshot[]> {
    assertListLimit(limit);
    const rows = this.#database
      .prepare(
        `SELECT ${CONTRACT_COLUMNS}
         FROM factory_task_contracts
         WHERE conversation_id = ?
         ORDER BY created_at DESC, task_id DESC
         LIMIT ?`
      )
      .all(conversationId, limit) as unknown as ContractRow[];
    const snapshots: FactoryTaskSnapshot[] = [];
    for (const row of rows) {
      const contract = this.#contractFromRow(row);
      const events = this.#readEventDocuments(contract.value.taskId);
      const last = events.at(-1);
      if (last === undefined) {
        throw new Error(`Factory task ${contract.value.taskId} has no initial event.`);
      }
      snapshots.push(snapshotFrom(contract.value, contract.digest, last.value, last.digest));
    }
    return Promise.resolve(snapshots);
  }

  public listEvents(taskId: string): Promise<readonly TaskEvent[]> {
    return Promise.resolve(this.#readEventDocuments(taskId).map(({ value }) => value));
  }

  public append(
    eventDocument: CanonicalFactoryDocument<TaskEvent>
  ): Promise<FactoryTaskSnapshot | null> {
    const event = this.#verifiedEventDocument(eventDocument);
    const result = this.#inTransaction(() => {
      const contract = this.#findContract(event.value.taskId);
      if (contract?.digest !== event.value.contractDigest) return null;
      const rows = this.#eventRows(event.value.taskId);
      const lastRow = rows.at(-1);
      if (lastRow === undefined)
        throw new Error(`Factory task ${event.value.taskId} has no initial event.`);
      const last = this.#eventFromRow(lastRow);
      if (
        event.value.sequence !== last.value.sequence + 1 ||
        event.value.previousEventDigest !== last.digest ||
        event.value.from !== last.value.to
      ) {
        return null;
      }
      if (!isFactoryTaskTransitionAllowed(event.value.from, event.value.to)) {
        throw new Error(
          `Illegal factory task transition ${event.value.from} -> ${event.value.to}.`
        );
      }
      this.#insertEvent(event);
      return snapshotFrom(contract.value, contract.digest, event.value, event.digest);
    });
    return Promise.resolve(result);
  }

  public state(): Promise<FactoryAuthorityState> {
    return Promise.resolve({
      scheduler: this.#latestControlValue("scheduler"),
      prBroker: this.#latestControlValue("pr-broker")
    });
  }

  public appendEvidence(
    bundleDocument: CanonicalFactoryDocument<EvidenceBundle>
  ): Promise<StoredEvidenceBundle | null> {
    const bundle = this.#verifiedEvidenceDocument(bundleDocument);
    const result = this.#inTransaction(() => {
      const contract = this.#findContract(bundle.value.taskId);
      if (contract?.digest !== bundle.value.contractDigest) return null;
      const existing = this.#readEvidenceDocuments(bundle.value.taskId);
      const previous = existing.at(-1) ?? null;
      if (
        bundle.value.sequence !== (previous?.value.sequence ?? 0) + 1 ||
        bundle.value.previousBundleDigest !== (previous?.digest ?? null)
      ) {
        return null;
      }
      this.#insertEvidence(bundle);
      return { bundle: bundle.value, digest: bundle.digest };
    });
    return Promise.resolve(result);
  }

  public latestEvidence(taskId: string): Promise<StoredEvidenceBundle | null> {
    const documents = this.#readEvidenceDocuments(taskId);
    const last = documents.at(-1);
    return Promise.resolve(last === undefined ? null : { bundle: last.value, digest: last.digest });
  }

  public listEvidence(taskId: string): Promise<readonly StoredEvidenceBundle[]> {
    return Promise.resolve(
      this.#readEvidenceDocuments(taskId).map((document) => ({
        bundle: document.value,
        digest: document.digest
      }))
    );
  }

  public record(
    eventDocument: CanonicalFactoryDocument<FactoryControlEvent>
  ): Promise<FactoryAuthorityState> {
    const event = this.#verifiedControlDocument(eventDocument);
    this.#database
      .prepare(
        `INSERT INTO factory_control_events (
          event_id,
          event_digest,
          control_name,
          enabled,
          event_json,
          occurred_at,
          reason
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
    return this.state();
  }

  public history(
    control: FactoryControlName,
    limit: number
  ): Promise<readonly FactoryControlEvent[]> {
    const parsedControl = factoryControlNameSchema.parse(control);
    assertListLimit(limit);
    const rows = this.#database
      .prepare(
        `SELECT ${CONTROL_COLUMNS}
         FROM factory_control_events
         WHERE control_name = ?
         ORDER BY sequence DESC
         LIMIT ?`
      )
      .all(parsedControl, limit) as unknown as ControlRow[];
    return Promise.resolve(rows.map((row) => this.#controlFromRow(row).value));
  }

  public close(): void {
    this.#database.close();
  }

  #findContract(taskId: string): CanonicalFactoryDocument<ImmutableTaskContract> | null {
    const row = this.#database
      .prepare(
        `SELECT ${CONTRACT_COLUMNS}
         FROM factory_task_contracts
         WHERE task_id = ?`
      )
      .get(taskId) as ContractRow | undefined;
    return row === undefined ? null : this.#contractFromRow(row);
  }

  #contractFromRow(row: ContractRow): CanonicalFactoryDocument<ImmutableTaskContract> {
    const document = this.#documents.taskContract(parseJson(row.contract_json, "factory contract"));
    if (
      row.task_id !== document.value.taskId ||
      row.contract_digest !== document.digest ||
      row.conversation_id !== document.value.conversationId ||
      row.repository_id !== document.value.repository.id ||
      row.base_revision !== document.value.repository.baseRevision ||
      row.risk_tier !== document.value.riskTier ||
      row.created_at !== document.value.createdAt ||
      row.expires_at !== document.value.expiresAt ||
      row.contract_json !== document.json
    ) {
      throw new Error(
        `Stored factory contract ${document.value.taskId} failed integrity validation.`
      );
    }
    return document;
  }

  #readEventDocuments(taskId: string): readonly CanonicalFactoryDocument<TaskEvent>[] {
    const rows = this.#eventRows(taskId);
    if (rows.length > maximumTaskEvents) {
      throw new Error(
        `Factory task ${taskId} exceeds the ${String(maximumTaskEvents)} event limit.`
      );
    }
    const events: CanonicalFactoryDocument<TaskEvent>[] = [];
    let previous: CanonicalFactoryDocument<TaskEvent> | null = null;
    for (const row of rows) {
      const event = this.#eventFromRow(row);
      if (
        event.value.sequence !== events.length + 1 ||
        event.value.previousEventDigest !== (previous?.digest ?? null) ||
        event.value.from !== (previous?.value.to ?? null) ||
        !isFactoryTaskTransitionAllowed(event.value.from, event.value.to)
      ) {
        throw new Error(`Factory task ${taskId} has an invalid event chain.`);
      }
      events.push(event);
      previous = event;
    }
    return events;
  }

  #readEvidenceDocuments(taskId: string): readonly CanonicalFactoryDocument<EvidenceBundle>[] {
    const rows = this.#database
      .prepare(
        `SELECT ${EVIDENCE_BUNDLE_COLUMNS}
         FROM factory_evidence_bundles
         WHERE task_id = ?
         ORDER BY sequence
         LIMIT ?`
      )
      .all(taskId, maximumEvidenceBundles + 1) as unknown as EvidenceBundleRow[];
    if (rows.length > maximumEvidenceBundles) {
      throw new Error(
        `Factory task ${taskId} exceeds the ${String(maximumEvidenceBundles)} evidence-bundle limit.`
      );
    }
    const documents: CanonicalFactoryDocument<EvidenceBundle>[] = [];
    let previous: CanonicalFactoryDocument<EvidenceBundle> | null = null;
    for (const row of rows) {
      const document = this.#evidenceFromRow(row);
      if (
        document.value.sequence !== documents.length + 1 ||
        document.value.previousBundleDigest !== (previous?.digest ?? null)
      ) {
        throw new Error(`Factory task ${taskId} has an invalid evidence-bundle chain.`);
      }
      documents.push(document);
      previous = document;
    }
    return documents;
  }

  #evidenceFromRow(row: EvidenceBundleRow): CanonicalFactoryDocument<EvidenceBundle> {
    const document = this.#documents.evidenceBundle(
      parseJson(row.bundle_json, "factory evidence bundle")
    );
    if (
      row.bundle_id !== document.value.bundleId ||
      row.bundle_digest !== document.digest ||
      row.task_id !== document.value.taskId ||
      row.sequence !== document.value.sequence ||
      row.contract_digest !== document.value.contractDigest ||
      row.previous_bundle_digest !== document.value.previousBundleDigest ||
      row.policy_bundle_digest !== document.value.policyBundleDigest ||
      row.created_at !== document.value.createdAt ||
      row.bundle_json !== document.json
    ) {
      throw new Error(
        `Stored factory evidence bundle ${document.value.bundleId} failed integrity validation.`
      );
    }
    return document;
  }

  #eventRows(taskId: string): readonly EventRow[] {
    return this.#database
      .prepare(
        `SELECT ${EVENT_COLUMNS}
         FROM factory_task_events
         WHERE task_id = ?
         ORDER BY sequence
         LIMIT ?`
      )
      .all(taskId, maximumTaskEvents + 1) as unknown as EventRow[];
  }

  #eventFromRow(row: EventRow): CanonicalFactoryDocument<TaskEvent> {
    const document = this.#documents.taskEvent(parseJson(row.event_json, "factory event"));
    if (
      row.event_id !== document.value.eventId ||
      row.task_id !== document.value.taskId ||
      row.sequence !== document.value.sequence ||
      row.event_digest !== document.digest ||
      row.previous_event_digest !== document.value.previousEventDigest ||
      row.contract_digest !== document.value.contractDigest ||
      row.from_state !== document.value.from ||
      row.to_state !== document.value.to ||
      row.occurred_at !== document.value.occurredAt ||
      row.correlation_id !== document.value.correlationId ||
      row.event_json !== document.json
    ) {
      throw new Error(
        `Stored factory event ${document.value.eventId} failed integrity validation.`
      );
    }
    return document;
  }

  #insertEvent(event: CanonicalFactoryDocument<TaskEvent>): void {
    this.#database
      .prepare(
        `INSERT INTO factory_task_events (
          event_id,
          task_id,
          sequence,
          event_digest,
          previous_event_digest,
          contract_digest,
          from_state,
          to_state,
          occurred_at,
          correlation_id,
          event_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.value.eventId,
        event.value.taskId,
        event.value.sequence,
        event.digest,
        event.value.previousEventDigest,
        event.value.contractDigest,
        event.value.from,
        event.value.to,
        event.value.occurredAt,
        event.value.correlationId,
        event.json
      );
  }

  #insertEvidence(bundle: CanonicalFactoryDocument<EvidenceBundle>): void {
    this.#database
      .prepare(
        `INSERT INTO factory_evidence_bundles (
          bundle_id,
          bundle_digest,
          task_id,
          sequence,
          contract_digest,
          previous_bundle_digest,
          policy_bundle_digest,
          created_at,
          bundle_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        bundle.value.bundleId,
        bundle.digest,
        bundle.value.taskId,
        bundle.value.sequence,
        bundle.value.contractDigest,
        bundle.value.previousBundleDigest,
        bundle.value.policyBundleDigest,
        bundle.value.createdAt,
        bundle.json
      );
  }

  #latestControlValue(control: FactoryControlName): boolean {
    const row = this.#database
      .prepare(
        `SELECT ${CONTROL_COLUMNS}
         FROM factory_control_events
         WHERE control_name = ?
         ORDER BY sequence DESC
         LIMIT 1`
      )
      .get(control) as ControlRow | undefined;
    return row === undefined ? false : this.#controlFromRow(row).value.enabled;
  }

  #controlFromRow(row: ControlRow): CanonicalFactoryDocument<FactoryControlEvent> {
    const document = this.#documents.controlEvent(
      parseJson(row.event_json, "factory control event")
    );
    if (
      typeof row.sequence !== "number" ||
      row.event_id !== document.value.eventId ||
      row.event_digest !== document.digest ||
      row.control_name !== document.value.control ||
      row.enabled !== (document.value.enabled ? 1 : 0) ||
      row.occurred_at !== document.value.occurredAt ||
      row.reason !== document.value.reason ||
      row.event_json !== document.json
    ) {
      throw new Error(
        `Stored factory control event ${document.value.eventId} failed integrity validation.`
      );
    }
    return document;
  }

  #verifiedContractDocument(
    claimed: CanonicalFactoryDocument<ImmutableTaskContract>
  ): CanonicalFactoryDocument<ImmutableTaskContract> {
    const actual = this.#documents.taskContract(claimed.value);
    assertDocumentClaim(claimed, actual, "task contract");
    return actual;
  }

  #verifiedEventDocument(
    claimed: CanonicalFactoryDocument<TaskEvent>
  ): CanonicalFactoryDocument<TaskEvent> {
    const actual = this.#documents.taskEvent(claimed.value);
    assertDocumentClaim(claimed, actual, "task event");
    return actual;
  }

  #verifiedControlDocument(
    claimed: CanonicalFactoryDocument<FactoryControlEvent>
  ): CanonicalFactoryDocument<FactoryControlEvent> {
    const actual = this.#documents.controlEvent(claimed.value);
    assertDocumentClaim(claimed, actual, "control event");
    return actual;
  }

  #verifiedEvidenceDocument(
    claimed: CanonicalFactoryDocument<EvidenceBundle>
  ): CanonicalFactoryDocument<EvidenceBundle> {
    const actual = this.#documents.evidenceBundle(claimed.value);
    assertDocumentClaim(claimed, actual, "evidence bundle");
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
      } catch (rollbackError: unknown) {
        throw new AggregateError(
          [error, rollbackError],
          "Factory transaction and rollback failed.",
          {
            cause: error
          }
        );
      }
      throw error;
    }
  }
}

function assertInitialEvent(
  contract: CanonicalFactoryDocument<ImmutableTaskContract>,
  event: CanonicalFactoryDocument<TaskEvent>
): void {
  if (
    event.value.taskId !== contract.value.taskId ||
    event.value.contractDigest !== contract.digest ||
    event.value.sequence !== 1 ||
    event.value.previousEventDigest !== null ||
    event.value.from !== null ||
    !isFactoryTaskTransitionAllowed(null, event.value.to)
  ) {
    throw new Error("Initial factory event does not initialize its exact task contract.");
  }
}

function assertInitialEvidence(
  contract: CanonicalFactoryDocument<ImmutableTaskContract>,
  evidence: CanonicalFactoryDocument<EvidenceBundle>
): void {
  if (
    evidence.value.taskId !== contract.value.taskId ||
    evidence.value.contractDigest !== contract.digest ||
    evidence.value.policyBundleDigest !== contract.value.gateProfile.policyDigest ||
    evidence.value.sequence !== 1 ||
    evidence.value.previousBundleDigest !== null
  ) {
    throw new Error("Initial factory evidence does not initialize its exact task contract.");
  }
}

function assertDocumentClaim<Value>(
  claimed: CanonicalFactoryDocument<Value>,
  actual: CanonicalFactoryDocument<Value>,
  label: string
): void {
  if (claimed.digest !== actual.digest || claimed.json !== actual.json) {
    throw new Error(`Claimed canonical ${label} does not match its value.`);
  }
}

function snapshotFrom(
  contract: ImmutableTaskContract,
  contractDigest: Sha256Digest,
  lastEvent: TaskEvent,
  lastEventDigest: Sha256Digest
): FactoryTaskSnapshot {
  return {
    contract,
    contractDigest,
    state: lastEvent.to,
    sequence: lastEvent.sequence,
    lastEvent,
    lastEventDigest
  };
}

function parseJson(value: unknown, label: string): unknown {
  if (typeof value !== "string") throw new Error(`Stored ${label} is not JSON text.`);
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error(`Stored ${label} is invalid JSON.`, { cause: error });
  }
}

function assertListLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("Factory list limit must be an integer from 1 through 100.");
  }
}
