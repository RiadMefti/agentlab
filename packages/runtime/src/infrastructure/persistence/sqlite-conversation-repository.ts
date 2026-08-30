import { DatabaseSync } from "node:sqlite";
import { chmodSync } from "node:fs";

import type {
  ConversationLifecycleTransition,
  ConversationRepository,
  RemovableConversationLifecycle
} from "../../domain/conversation-repository.js";
import {
  newConversationReservationSchema,
  storedConversationSchema,
  type NewConversationReservation,
  type StoredConversation
} from "../../domain/conversation-record.js";
import { assertCaptainSessionOwnership } from "../../domain/agent-session-name.js";
import { migrate } from "./migrations.js";

interface ConversationRow {
  readonly id: unknown;
  readonly title: unknown;
  readonly workspace_path: unknown;
  readonly provider: unknown;
  readonly model: unknown;
  readonly reasoning: unknown;
  readonly captain_session_name: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
  readonly lifecycle_state: unknown;
  readonly ownership_mode: unknown;
  readonly ownership_nonce: unknown;
}

const SELECT_COLUMNS = `
  id,
  title,
  workspace_path,
  provider,
  model,
  reasoning,
  captain_session_name,
  created_at,
  updated_at,
  lifecycle_state,
  ownership_mode,
  ownership_nonce
`;

export interface SqliteConversationRepositoryOptions {
  readonly createDatabase?: (databasePath: string) => DatabaseSync;
  readonly secureDatabaseFile?: (databasePath: string) => void;
  readonly migrateDatabase?: (database: DatabaseSync) => void;
}

const retainedAmbiguousInitializationDatabases = new Set<DatabaseSync>();

/** Signals that construction failed without positive confirmation that SQLite closed. */
export class UnconfirmedDatabaseInitializationError extends AggregateError {
  public readonly cleanupConfirmed = false as const;

  public constructor(primary: unknown, cleanup: unknown, database: DatabaseSync) {
    super([primary, cleanup], "Database initialization and connection cleanup failed.", {
      cause: primary
    });
    this.name = "UnconfirmedDatabaseInitializationError";
    retainedAmbiguousInitializationDatabases.add(database);
  }
}

export function isUnconfirmedDatabaseInitializationError(
  error: unknown
): error is UnconfirmedDatabaseInitializationError {
  return error instanceof UnconfirmedDatabaseInitializationError;
}

/** Local SQLite adapter with strict row validation at read boundaries. */
export class SqliteConversationRepository implements ConversationRepository {
  readonly #database: DatabaseSync;

  public constructor(databasePath: string, options: SqliteConversationRepositoryOptions = {}) {
    this.#database = openDatabase(databasePath, options);
  }

  public list(): Promise<readonly StoredConversation[]> {
    const rows = this.#database
      .prepare(
        `SELECT ${SELECT_COLUMNS}
         FROM conversations
         ORDER BY updated_at DESC, id DESC`
      )
      .all() as unknown as ConversationRow[];
    return Promise.resolve(rows.map(toStoredConversation));
  }

  public findById(id: string): Promise<StoredConversation | null> {
    const row = this.#database
      .prepare(
        `SELECT ${SELECT_COLUMNS}
         FROM conversations
         WHERE id = ?`
      )
      .get(id) as ConversationRow | undefined;
    return Promise.resolve(row === undefined ? null : toStoredConversation(row));
  }

  public findByWorkspacePath(workspacePath: string): Promise<StoredConversation | null> {
    const row = this.#database
      .prepare(
        `SELECT ${SELECT_COLUMNS}
         FROM conversations
         WHERE workspace_path = ?`
      )
      .get(workspacePath) as ConversationRow | undefined;
    return Promise.resolve(row === undefined ? null : toStoredConversation(row));
  }

  public create(conversation: NewConversationReservation): Promise<void> {
    const reservation = newConversationReservationSchema.parse(conversation);
    this.#database
      .prepare(
        `INSERT INTO conversations (
          id,
          title,
          workspace_path,
          provider,
          model,
          reasoning,
          captain_session_name,
          created_at,
          updated_at,
          lifecycle_state,
          ownership_mode,
          ownership_nonce
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        reservation.id,
        reservation.title,
        reservation.workspacePath,
        reservation.provider,
        reservation.model,
        reservation.reasoning,
        reservation.captainSessionName,
        reservation.createdAt,
        reservation.updatedAt,
        reservation.lifecycleState,
        reservation.ownershipMode,
        reservation.ownershipNonce
      );
    return Promise.resolve();
  }

  public transitionLifecycle(
    transition: ConversationLifecycleTransition
  ): Promise<StoredConversation | null> {
    assertLegalTransition(transition);
    const row = this.#database
      .prepare(
        `UPDATE conversations
         SET lifecycle_state = ?
         WHERE id = ? AND lifecycle_state = ?
         RETURNING ${SELECT_COLUMNS}`
      )
      .get(transition.next, transition.id, transition.expected) as ConversationRow | undefined;
    return Promise.resolve(row === undefined ? null : toStoredConversation(row));
  }

  public deleteIfLifecycle(id: string, expected: RemovableConversationLifecycle): Promise<boolean> {
    assertRemovableLifecycle(expected);
    const result = this.#database
      .prepare("DELETE FROM conversations WHERE id = ? AND lifecycle_state = ?")
      .run(id, expected);
    return Promise.resolve(result.changes === 1);
  }

  public close(): void {
    this.#database.close();
  }
}

function assertLegalTransition(value: unknown): asserts value is ConversationLifecycleTransition {
  if (typeof value !== "object" || value === null) {
    throw new Error("Illegal durable conversation lifecycle transition.");
  }
  const transition = value as Record<string, unknown>;
  if (
    (transition.expected === "creating" && transition.next === "active") ||
    ((transition.expected === "active" || transition.expected === "legacy-unlinked") &&
      transition.next === "deleting")
  ) {
    return;
  }
  throw new Error("Illegal durable conversation lifecycle transition.");
}

function assertRemovableLifecycle(value: unknown): asserts value is RemovableConversationLifecycle {
  if (value !== "creating" && value !== "deleting") {
    throw new Error("Only pending durable conversation states may be removed.");
  }
}

function openDatabase(
  databasePath: string,
  options: SqliteConversationRepositoryOptions
): DatabaseSync {
  const database = (options.createDatabase ?? ((path) => new DatabaseSync(path)))(databasePath);
  try {
    if (databasePath !== ":memory:") {
      (
        options.secureDatabaseFile ??
        ((path) => {
          chmodSync(path, 0o600);
        })
      )(databasePath);
    }
    (options.migrateDatabase ?? migrate)(database);
    return database;
  } catch (error: unknown) {
    try {
      database.close();
    } catch (cleanupError: unknown) {
      throw new UnconfirmedDatabaseInitializationError(error, cleanupError, database);
    }
    throw error;
  }
}

function toStoredConversation(row: ConversationRow): StoredConversation {
  const conversation = storedConversationSchema.parse({
    id: row.id,
    title: row.title,
    workspacePath: row.workspace_path,
    provider: row.provider,
    model: row.model,
    reasoning: row.reasoning,
    captainSessionName: row.captain_session_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lifecycleState: row.lifecycle_state,
    ownershipMode: row.ownership_mode,
    ownershipNonce: row.ownership_nonce
  });
  assertCaptainSessionOwnership(
    conversation.captainSessionName,
    conversation.id,
    conversation.provider
  );
  return conversation;
}
