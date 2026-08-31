import { DatabaseSync } from "node:sqlite";

import type {
  EvidenceBundle,
  FactoryPreparationEvent,
  ImmutableTaskContract,
  TaskEvent
} from "@agentlab/contracts";

import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../../domain/factory-documents.js";
import {
  assertFactoryPreparationAuthorityForRequest,
  assertFactoryPreparationEvent,
  assertFactoryPreparationRegistration,
  type FactoryPreparationDocuments
} from "../../domain/factory-preparation-integrity.js";
import type { FactoryTaskSnapshot } from "../../domain/factory-task-repository.js";
import type {
  FactoryTaskMaterialization,
  FactoryTaskMaterializationRepository
} from "../../domain/factory-task-materialization.js";
import {
  assertFactoryPreparationHistoryMaterialization,
  assertFactoryTaskMaterialization
} from "../../domain/factory-task-materialization.js";
import { NodeFactoryDocumentCodec } from "./canonical-factory-documents.js";
import { openSqliteDatabase, type SqliteDatabaseOptions } from "./sqlite-database.js";

interface PreparationHeaderRow {
  readonly task_id: unknown;
  readonly request_digest: unknown;
  readonly authority_digest: unknown;
  readonly request_json: unknown;
  readonly authority_json: unknown;
}

interface PreparationEventRow {
  readonly sequence: unknown;
  readonly event_digest: unknown;
  readonly event_json: unknown;
}

export interface SqliteFactoryTaskMaterializerOptions extends SqliteDatabaseOptions {
  readonly documents?: FactoryDocumentCodec;
}

/** SQLite transaction boundary joining the preparation journal to the task ledger. */
export class SqliteFactoryTaskMaterializer implements FactoryTaskMaterializationRepository {
  readonly #database: DatabaseSync;
  readonly #documents: FactoryDocumentCodec;

  public constructor(databasePath: string, options: SqliteFactoryTaskMaterializerOptions = {}) {
    this.#database = openSqliteDatabase(databasePath, options);
    this.#documents = options.documents ?? new NodeFactoryDocumentCodec();
  }

  public materialize(input: FactoryTaskMaterialization): Promise<FactoryTaskSnapshot | null> {
    const bundle = verifiedDocument(
      input.preparationBundle,
      this.#documents.preparationBundle(input.preparationBundle.value),
      "preparation bundle"
    );
    const contract = verifiedDocument(
      input.contract,
      this.#documents.taskContract(input.contract.value),
      "task contract"
    );
    const taskEvents = input.taskEvents.map((event) =>
      verifiedDocument(event, this.#documents.taskEvent(event.value), "task event")
    );
    const evidence = verifiedDocument(
      input.initialEvidence,
      this.#documents.evidenceBundle(input.initialEvidence.value),
      "initial evidence"
    );
    const prepared = verifiedDocument(
      input.preparedEvent,
      this.#documents.preparationEvent(input.preparedEvent.value),
      "prepared event"
    );
    assertFactoryTaskMaterialization({
      preparationBundle: bundle,
      contract,
      taskEvents,
      initialEvidence: evidence,
      preparedEvent: prepared
    });

    const snapshot = this.#inTransaction(() => {
      const preparation = this.#preparation(contract.value.taskId);
      if (preparation === null) return null;
      const history = this.#preparationEvents(preparation);
      const last = history.at(-1);
      if (last === undefined) throw new Error("Factory preparation has no registration event.");
      if (
        preparation.request.digest !== bundle.value.requestDigest ||
        preparation.authority.digest !== bundle.value.authorityDigest ||
        prepared.value.requestDigest !== preparation.request.digest ||
        prepared.value.authorityDigest !== preparation.authority.digest ||
        prepared.value.sequence !== last.value.sequence + 1 ||
        prepared.value.previousEventDigest !== last.digest ||
        prepared.value.from !== last.value.to
      ) {
        return null;
      }
      if (last.value.kind !== "phase-succeeded" || last.value.phase !== "plan") {
        return null;
      }
      assertFactoryPreparationEvent(preparation, prepared, history);
      assertFactoryPreparationHistoryMaterialization(
        bundle.value,
        history,
        preparation.authority.value,
        evidence.value
      );
      this.#insertContract(contract);
      for (const event of taskEvents) this.#insertTaskEvent(event);
      this.#insertEvidence(evidence);
      this.#insertPreparationEvent(prepared);
      const finalEvent = requiredFinalEvent(taskEvents);
      return snapshotFrom(contract, finalEvent);
    });
    return Promise.resolve(snapshot);
  }

  public close(): void {
    this.#database.close();
  }

  #preparation(taskId: string): FactoryPreparationDocuments | null {
    const row = this.#database
      .prepare(
        `SELECT task_id, request_digest, authority_digest, request_json, authority_json
         FROM factory_preparations
         WHERE task_id = ?`
      )
      .get(taskId) as PreparationHeaderRow | undefined;
    if (row === undefined) return null;
    const request = this.#documents.intakeRequest(parseJson(row.request_json, "intake request"));
    const authority = this.#documents.preparationAuthority(
      parseJson(row.authority_json, "preparation authority")
    );
    if (
      row.task_id !== request.value.taskId ||
      row.request_digest !== request.digest ||
      row.authority_digest !== authority.digest ||
      row.request_json !== request.json ||
      row.authority_json !== authority.json ||
      authority.value.taskId !== request.value.taskId ||
      authority.value.requestDigest !== request.digest ||
      authority.value.repository.id !== request.value.repository.id ||
      authority.value.repository.baseRevision !== request.value.repository.baseRevision
    ) {
      throw new Error("Stored preparation header failed materialization integrity validation.");
    }
    assertFactoryPreparationAuthorityForRequest(request, authority);
    return { request, authority };
  }

  #preparationEvents(
    preparation: FactoryPreparationDocuments
  ): readonly CanonicalFactoryDocument<FactoryPreparationEvent>[] {
    const rows = this.#database
      .prepare(
        `SELECT sequence, event_digest, event_json
         FROM factory_preparation_events
         WHERE task_id = ?
         ORDER BY sequence
         LIMIT 1001`
      )
      .all(preparation.request.value.taskId) as unknown as PreparationEventRow[];
    if (rows.length > 1_000) throw new Error("Factory preparation exceeds its event limit.");
    const documents: CanonicalFactoryDocument<FactoryPreparationEvent>[] = [];
    for (const row of rows) {
      const event = this.#documents.preparationEvent(
        parseJson(row.event_json, "preparation event")
      );
      const previous = documents.at(-1) ?? null;
      if (
        row.sequence !== event.value.sequence ||
        row.event_digest !== event.digest ||
        row.event_json !== event.json ||
        event.value.sequence !== documents.length + 1 ||
        event.value.previousEventDigest !== (previous?.digest ?? null) ||
        event.value.from !== (previous?.value.to ?? null)
      ) {
        throw new Error("Stored preparation event chain failed materialization validation.");
      }
      if (documents.length === 0) {
        assertFactoryPreparationRegistration(preparation.request, preparation.authority, event);
      } else {
        assertFactoryPreparationEvent(preparation, event, documents);
      }
      documents.push(event);
    }
    return documents;
  }

  #insertContract(contract: CanonicalFactoryDocument<ImmutableTaskContract>): void {
    this.#database
      .prepare(
        `INSERT INTO factory_task_contracts (
          task_id, contract_digest, conversation_id, repository_id, base_revision,
          risk_tier, created_at, expires_at, contract_json
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
  }

  #insertTaskEvent(event: CanonicalFactoryDocument<TaskEvent>): void {
    this.#database
      .prepare(
        `INSERT INTO factory_task_events (
          event_id, task_id, sequence, event_digest, previous_event_digest,
          contract_digest, from_state, to_state, occurred_at, correlation_id, event_json
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

  #insertEvidence(evidence: CanonicalFactoryDocument<EvidenceBundle>): void {
    this.#database
      .prepare(
        `INSERT INTO factory_evidence_bundles (
          bundle_id, bundle_digest, task_id, sequence, contract_digest,
          previous_bundle_digest, policy_bundle_digest, created_at, bundle_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        evidence.value.bundleId,
        evidence.digest,
        evidence.value.taskId,
        evidence.value.sequence,
        evidence.value.contractDigest,
        evidence.value.previousBundleDigest,
        evidence.value.policyBundleDigest,
        evidence.value.createdAt,
        evidence.json
      );
  }

  #insertPreparationEvent(event: CanonicalFactoryDocument<FactoryPreparationEvent>): void {
    this.#database
      .prepare(
        `INSERT INTO factory_preparation_events (
          event_id, task_id, sequence, event_digest, previous_event_digest,
          request_digest, authority_digest, kind, phase, execution_id, attempt,
          from_state, to_state, occurred_at, correlation_id, event_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        event.value.eventId,
        event.value.taskId,
        event.value.sequence,
        event.digest,
        event.value.previousEventDigest,
        event.value.requestDigest,
        event.value.authorityDigest,
        event.value.kind,
        null,
        null,
        null,
        event.value.from,
        event.value.to,
        event.value.occurredAt,
        event.value.correlationId,
        event.json
      );
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
          "Factory materialization transaction and rollback failed.",
          { cause: error }
        );
      }
      throw error;
    }
  }
}

function requiredFinalEvent(
  events: readonly CanonicalFactoryDocument<TaskEvent>[]
): CanonicalFactoryDocument<TaskEvent> {
  const event = events.at(-1);
  if (event === undefined) throw new Error("Task materialization has no final event.");
  return event;
}

function snapshotFrom(
  contract: CanonicalFactoryDocument<ImmutableTaskContract>,
  event: CanonicalFactoryDocument<TaskEvent>
): FactoryTaskSnapshot {
  return {
    contract: contract.value,
    contractDigest: contract.digest,
    state: event.value.to,
    sequence: event.value.sequence,
    lastEvent: event.value,
    lastEventDigest: event.digest
  };
}

function verifiedDocument<Value>(
  claimed: CanonicalFactoryDocument<Value>,
  actual: CanonicalFactoryDocument<Value>,
  label: string
): CanonicalFactoryDocument<Value> {
  if (claimed.digest !== actual.digest || claimed.json !== actual.json) {
    throw new Error(`Claimed canonical ${label} does not match its value.`);
  }
  return actual;
}

function parseJson(value: unknown, label: string): unknown {
  if (typeof value !== "string") throw new Error(`Stored ${label} is not JSON text.`);
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error(`Stored ${label} is invalid JSON.`, { cause: error });
  }
}
