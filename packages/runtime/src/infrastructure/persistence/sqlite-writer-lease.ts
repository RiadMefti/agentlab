import { chmodSync, lstatSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import type { WriterLease } from "../../domain/writer-lease.js";
import { prepareDatabaseTarget } from "../filesystem/database-target.js";

const defaultContentionTimeoutMs = 1_500;

export interface SqliteWriterLeaseOptions {
  readonly contentionTimeoutMs?: number;
}

export function acquireSqliteWriterLease(
  databasePathInput: string,
  options: SqliteWriterLeaseOptions = {}
): WriterLease {
  const databasePath = prepareDatabaseTarget(databasePathInput);
  if (databasePath === ":memory:") return new MemoryWriterLease(databasePath);

  const contentionTimeoutMs = options.contentionTimeoutMs ?? defaultContentionTimeoutMs;
  if (!Number.isSafeInteger(contentionTimeoutMs) || contentionTimeoutMs < 1) {
    throw new Error("Writer-lease contention timeout must be a positive integer.");
  }

  const lockPath = `${databasePath}.agentlab-writer-lock.sqlite`;
  rejectAmbiguousLockFile(lockPath);
  const database = new DatabaseSync(lockPath, { timeout: contentionTimeoutMs });
  let acquired = false;
  try {
    chmodSync(lockPath, 0o600);
    database.exec(`PRAGMA busy_timeout = ${String(contentionTimeoutMs)}`);
    database.exec("PRAGMA journal_mode = DELETE");
    database.exec(
      "CREATE TABLE IF NOT EXISTS writer_lease (singleton INTEGER PRIMARY KEY CHECK (singleton = 1)) STRICT"
    );
    database.exec("BEGIN EXCLUSIVE");
    acquired = true;
    return new SqliteWriterLease(databasePath, database);
  } catch (error: unknown) {
    if (acquired) {
      try {
        database.exec("ROLLBACK");
      } catch {
        // The primary acquisition error remains authoritative.
      }
    }
    try {
      database.close();
    } catch {
      // The primary acquisition error remains authoritative.
    }
    throw new Error(
      `Another AgentLab runtime already owns ${databasePath}, or its writer lease could not be acquired.`,
      { cause: error }
    );
  }
}

class SqliteWriterLease implements WriterLease {
  #closed = false;
  #transactionFinished = false;

  public constructor(
    public readonly databasePath: string,
    private readonly database: DatabaseSync
  ) {}

  public close(): void {
    if (this.#closed) return;
    const failures: unknown[] = [];
    if (!this.#transactionFinished) {
      try {
        this.database.exec("ROLLBACK");
        this.#transactionFinished = true;
      } catch (error: unknown) {
        failures.push(error);
      }
    }
    try {
      this.database.close();
      this.#closed = true;
    } catch (error: unknown) {
      failures.push(error);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "The AgentLab writer lease could not close cleanly.");
    }
  }
}

class MemoryWriterLease implements WriterLease {
  public constructor(public readonly databasePath: string) {}
  public close(): void {
    // Each :memory: database is process-local and has no shared lease resource.
  }
}

function rejectAmbiguousLockFile(path: string): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch (error: unknown) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { readonly code?: unknown }).code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink > 1) {
    throw new Error("Writer-lease path must be one unambiguous regular file.");
  }
}
