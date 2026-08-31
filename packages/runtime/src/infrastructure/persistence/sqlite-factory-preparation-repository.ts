import { DatabaseSync } from "node:sqlite";

import type {
  FactoryIntakeRequest,
  FactoryPreparationAuthority,
  FactoryPreparationEvent
} from "@agentlab/contracts";
import { factoryIdentifierSchema, sha256DigestSchema } from "@agentlab/contracts";

import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../../domain/factory-documents.js";
import {
  assertFactoryPreparationAuthorityForRequest,
  assertFactoryPreparationEvent,
  assertFactoryPreparationRegistration,
  factoryPreparationRunCoordinates,
  type FactoryPreparationDocuments
} from "../../domain/factory-preparation-integrity.js";
import type {
  FactoryPreparationRepository,
  FactoryPreparationSnapshot
} from "../../domain/factory-preparation-repository.js";
import { NodeFactoryDocumentCodec } from "./canonical-factory-documents.js";
import { openSqliteDatabase, type SqliteDatabaseOptions } from "./sqlite-database.js";

interface PreparationRow {
  readonly task_id: unknown;
  readonly request_digest: unknown;
  readonly authority_digest: unknown;
  readonly conversation_id: unknown;
  readonly deduplication_key: unknown;
  readonly repository_id: unknown;
  readonly base_revision: unknown;
  readonly created_at: unknown;
  readonly issued_at: unknown;
  readonly expires_at: unknown;
  readonly request_json: unknown;
  readonly authority_json: unknown;
}

interface PreparationEventRow {
  readonly event_id: unknown;
  readonly task_id: unknown;
  readonly sequence: unknown;
  readonly event_digest: unknown;
  readonly previous_event_digest: unknown;
  readonly request_digest: unknown;
  readonly authority_digest: unknown;
  readonly kind: unknown;
  readonly phase: unknown;
  readonly execution_id: unknown;
  readonly attempt: unknown;
  readonly from_state: unknown;
  readonly to_state: unknown;
  readonly occurred_at: unknown;
  readonly correlation_id: unknown;
  readonly event_json: unknown;
}

const PREPARATION_COLUMNS = `
  task_id,
  request_digest,
  authority_digest,
  conversation_id,
  deduplication_key,
  repository_id,
  base_revision,
  created_at,
  issued_at,
  expires_at,
  request_json,
  authority_json
`;

const PREPARATION_EVENT_COLUMNS = `
  event_id,
  task_id,
  sequence,
  event_digest,
  previous_event_digest,
  request_digest,
  authority_digest,
  kind,
  phase,
  execution_id,
  attempt,
  from_state,
  to_state,
  occurred_at,
  correlation_id,
  event_json
`;

const maximumPreparationEvents = 1_000;

export interface SqliteFactoryPreparationRepositoryOptions extends SqliteDatabaseOptions {
  readonly documents?: FactoryDocumentCodec;
}

/** SQLite-backed, append-only journal for the request-to-contract workflow. */
export class SqliteFactoryPreparationRepository implements FactoryPreparationRepository {
  readonly #database: DatabaseSync;
  readonly #documents: FactoryDocumentCodec;

  public constructor(
    databasePath: string,
    options: SqliteFactoryPreparationRepositoryOptions = {}
  ) {
    this.#database = openSqliteDatabase(databasePath, options);
    this.#documents = options.documents ?? new NodeFactoryDocumentCodec();
  }

  public register(
    requestClaim: CanonicalFactoryDocument<FactoryIntakeRequest>,
    authorityClaim: CanonicalFactoryDocument<FactoryPreparationAuthority>,
    initialEventClaim: CanonicalFactoryDocument<FactoryPreparationEvent>
  ): Promise<FactoryPreparationSnapshot> {
    const request = this.#verifiedRequest(requestClaim);
    const authority = this.#verifiedAuthority(authorityClaim);
    const initialEvent = this.#verifiedEvent(initialEventClaim);
    assertFactoryPreparationRegistration(request, authority, initialEvent);

    const snapshot = this.#inTransaction(() => {
      this.#database
        .prepare(
          `INSERT INTO factory_preparations (
            task_id,
            request_digest,
            authority_digest,
            conversation_id,
            deduplication_key,
            repository_id,
            base_revision,
            created_at,
            issued_at,
            expires_at,
            request_json,
            authority_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          request.value.taskId,
          request.digest,
          authority.digest,
          request.value.conversationId,
          request.value.deduplicationKey,
          request.value.repository.id,
          request.value.repository.baseRevision,
          request.value.createdAt,
          authority.value.issuedAt,
          authority.value.expiresAt,
          request.json,
          authority.json
        );
      this.#insertEvent(initialEvent);
      return snapshotFrom(request, authority, initialEvent);
    });
    return Promise.resolve(snapshot);
  }

  public findById(taskId: string): Promise<FactoryPreparationSnapshot | null> {
    const preparation = this.#findPreparation(taskId);
    if (preparation === null) return Promise.resolve(null);
    const events = this.#readEventDocuments(preparation);
    const last = events.at(-1);
    if (last === undefined) throw new Error(`Factory preparation ${taskId} has no initial event.`);
    return Promise.resolve(snapshotFrom(preparation.request, preparation.authority, last));
  }

  public findByDeduplicationKey(
    repositoryIdInput: string,
    deduplicationKeyInput: string
  ): Promise<FactoryPreparationSnapshot | null> {
    const repositoryId = factoryIdentifierSchema.parse(repositoryIdInput);
    const deduplicationKey = sha256DigestSchema.parse(deduplicationKeyInput);
    const row = this.#database
      .prepare(
        `SELECT ${PREPARATION_COLUMNS}
         FROM factory_preparations
         WHERE repository_id = ? AND deduplication_key = ?`
      )
      .get(repositoryId, deduplicationKey) as PreparationRow | undefined;
    if (row === undefined) return Promise.resolve(null);
    const preparation = this.#preparationFromRow(row);
    const last = this.#readEventDocuments(preparation).at(-1);
    if (last === undefined) {
      throw new Error(
        `Factory preparation ${preparation.request.value.taskId} has no initial event.`
      );
    }
    return Promise.resolve(snapshotFrom(preparation.request, preparation.authority, last));
  }

  public listForConversation(
    conversationId: string,
    limit: number
  ): Promise<readonly FactoryPreparationSnapshot[]> {
    assertListLimit(limit);
    const rows = this.#database
      .prepare(
        `SELECT ${PREPARATION_COLUMNS}
         FROM factory_preparations
         WHERE conversation_id = ?
         ORDER BY created_at DESC, task_id DESC
         LIMIT ?`
      )
      .all(conversationId, limit) as unknown as PreparationRow[];
    return Promise.resolve(
      rows.map((row) => {
        const preparation = this.#preparationFromRow(row);
        const last = this.#readEventDocuments(preparation).at(-1);
        if (last === undefined) {
          throw new Error(
            `Factory preparation ${preparation.request.value.taskId} has no initial event.`
          );
        }
        return snapshotFrom(preparation.request, preparation.authority, last);
      })
    );
  }

  public listEvents(taskId: string): Promise<readonly FactoryPreparationEvent[]> {
    const preparation = this.#findPreparation(taskId);
    if (preparation === null) return Promise.resolve([]);
    return Promise.resolve(this.#readEventDocuments(preparation).map(({ value }) => value));
  }

  public append(
    eventClaim: CanonicalFactoryDocument<FactoryPreparationEvent>
  ): Promise<FactoryPreparationSnapshot | null> {
    const event = this.#verifiedEvent(eventClaim);
    if (event.value.kind === "prepared") {
      throw new Error("Prepared state requires atomic task-ledger materialization.");
    }
    const result = this.#inTransaction(() => {
      const preparation = this.#findPreparation(event.value.taskId);
      if (
        preparation?.request.digest !== event.value.requestDigest ||
        preparation.authority.digest !== event.value.authorityDigest
      ) {
        return null;
      }
      const history = this.#readEventDocuments(preparation);
      const previous = history.at(-1);
      if (previous === undefined) {
        throw new Error(`Factory preparation ${event.value.taskId} has no initial event.`);
      }
      if (
        event.value.sequence !== previous.value.sequence + 1 ||
        event.value.previousEventDigest !== previous.digest ||
        event.value.from !== previous.value.to
      ) {
        return null;
      }
      assertFactoryPreparationEvent(preparation, event, history);
      this.#insertEvent(event);
      return snapshotFrom(preparation.request, preparation.authority, event);
    });
    return Promise.resolve(result);
  }

  public close(): void {
    this.#database.close();
  }

  #findPreparation(taskId: string): FactoryPreparationDocuments | null {
    const row = this.#database
      .prepare(
        `SELECT ${PREPARATION_COLUMNS}
         FROM factory_preparations
         WHERE task_id = ?`
      )
      .get(taskId) as PreparationRow | undefined;
    return row === undefined ? null : this.#preparationFromRow(row);
  }

  #preparationFromRow(row: PreparationRow): FactoryPreparationDocuments {
    const request = this.#documents.intakeRequest(
      parseJson(row.request_json, "factory intake request")
    );
    const authority = this.#documents.preparationAuthority(
      parseJson(row.authority_json, "factory preparation authority")
    );
    if (
      row.task_id !== request.value.taskId ||
      row.request_digest !== request.digest ||
      row.authority_digest !== authority.digest ||
      row.conversation_id !== request.value.conversationId ||
      row.deduplication_key !== request.value.deduplicationKey ||
      row.repository_id !== request.value.repository.id ||
      row.base_revision !== request.value.repository.baseRevision ||
      row.created_at !== request.value.createdAt ||
      row.issued_at !== authority.value.issuedAt ||
      row.expires_at !== authority.value.expiresAt ||
      row.request_json !== request.json ||
      row.authority_json !== authority.json
    ) {
      throw new Error(
        `Stored factory preparation ${request.value.taskId} failed integrity validation.`
      );
    }
    assertFactoryPreparationAuthorityForRequest(request, authority);
    return { request, authority };
  }

  #readEventDocuments(
    preparation: FactoryPreparationDocuments
  ): readonly CanonicalFactoryDocument<FactoryPreparationEvent>[] {
    const rows = this.#database
      .prepare(
        `SELECT ${PREPARATION_EVENT_COLUMNS}
         FROM factory_preparation_events
         WHERE task_id = ?
         ORDER BY sequence
         LIMIT ?`
      )
      .all(
        preparation.request.value.taskId,
        maximumPreparationEvents + 1
      ) as unknown as PreparationEventRow[];
    if (rows.length > maximumPreparationEvents) {
      throw new Error(
        `Factory preparation ${preparation.request.value.taskId} exceeds the event limit.`
      );
    }
    const events: CanonicalFactoryDocument<FactoryPreparationEvent>[] = [];
    for (const row of rows) {
      const event = this.#eventFromRow(row);
      const previous = events.at(-1) ?? null;
      if (
        event.value.sequence !== events.length + 1 ||
        event.value.previousEventDigest !== (previous?.digest ?? null) ||
        event.value.from !== (previous?.value.to ?? null)
      ) {
        throw new Error(
          `Factory preparation ${preparation.request.value.taskId} has an invalid event chain.`
        );
      }
      assertFactoryPreparationEvent(preparation, event, events);
      events.push(event);
    }
    return events;
  }

  #eventFromRow(row: PreparationEventRow): CanonicalFactoryDocument<FactoryPreparationEvent> {
    const document = this.#documents.preparationEvent(
      parseJson(row.event_json, "factory preparation event")
    );
    const run = factoryPreparationRunCoordinates(document.value);
    if (
      row.event_id !== document.value.eventId ||
      row.task_id !== document.value.taskId ||
      row.sequence !== document.value.sequence ||
      row.event_digest !== document.digest ||
      row.previous_event_digest !== document.value.previousEventDigest ||
      row.request_digest !== document.value.requestDigest ||
      row.authority_digest !== document.value.authorityDigest ||
      row.kind !== document.value.kind ||
      row.phase !== run.phase ||
      row.execution_id !== run.executionId ||
      row.attempt !== run.attempt ||
      row.from_state !== document.value.from ||
      row.to_state !== document.value.to ||
      row.occurred_at !== document.value.occurredAt ||
      row.correlation_id !== document.value.correlationId ||
      row.event_json !== document.json
    ) {
      throw new Error(
        `Stored factory preparation event ${document.value.eventId} failed integrity validation.`
      );
    }
    return document;
  }

  #insertEvent(event: CanonicalFactoryDocument<FactoryPreparationEvent>): void {
    const run = factoryPreparationRunCoordinates(event.value);
    this.#database
      .prepare(
        `INSERT INTO factory_preparation_events (
          event_id,
          task_id,
          sequence,
          event_digest,
          previous_event_digest,
          request_digest,
          authority_digest,
          kind,
          phase,
          execution_id,
          attempt,
          from_state,
          to_state,
          occurred_at,
          correlation_id,
          event_json
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
        run.phase,
        run.executionId,
        run.attempt,
        event.value.from,
        event.value.to,
        event.value.occurredAt,
        event.value.correlationId,
        event.json
      );
  }

  #verifiedRequest(
    claimed: CanonicalFactoryDocument<FactoryIntakeRequest>
  ): CanonicalFactoryDocument<FactoryIntakeRequest> {
    const actual = this.#documents.intakeRequest(claimed.value);
    assertDocumentClaim(claimed, actual, "intake request");
    return actual;
  }

  #verifiedAuthority(
    claimed: CanonicalFactoryDocument<FactoryPreparationAuthority>
  ): CanonicalFactoryDocument<FactoryPreparationAuthority> {
    const actual = this.#documents.preparationAuthority(claimed.value);
    assertDocumentClaim(claimed, actual, "preparation authority");
    return actual;
  }

  #verifiedEvent(
    claimed: CanonicalFactoryDocument<FactoryPreparationEvent>
  ): CanonicalFactoryDocument<FactoryPreparationEvent> {
    const actual = this.#documents.preparationEvent(claimed.value);
    assertDocumentClaim(claimed, actual, "preparation event");
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
          "Factory preparation transaction and rollback failed.",
          { cause: error }
        );
      }
      throw error;
    }
  }
}

function snapshotFrom(
  request: CanonicalFactoryDocument<FactoryIntakeRequest>,
  authority: CanonicalFactoryDocument<FactoryPreparationAuthority>,
  lastEvent: CanonicalFactoryDocument<FactoryPreparationEvent>
): FactoryPreparationSnapshot {
  return {
    request: request.value,
    requestDigest: request.digest,
    authority: authority.value,
    authorityDigest: authority.digest,
    state: lastEvent.value.to,
    sequence: lastEvent.value.sequence,
    lastEvent: lastEvent.value,
    lastEventDigest: lastEvent.digest
  };
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
    throw new Error("Factory preparation list limit must be an integer from 1 through 100.");
  }
}
