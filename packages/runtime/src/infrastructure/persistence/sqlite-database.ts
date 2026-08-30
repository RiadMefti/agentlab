import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { migrate } from "./migrations.js";

export interface SqliteDatabaseOptions {
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

export function openSqliteDatabase(
  databasePath: string,
  options: SqliteDatabaseOptions = {}
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
