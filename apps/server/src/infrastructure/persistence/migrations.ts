import type { DatabaseSync } from "node:sqlite";

const LATEST_SCHEMA_VERSION = 1;

export function migrate(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA journal_mode = WAL");
  const version = readUserVersion(database);

  if (version > LATEST_SCHEMA_VERSION) {
    throw new Error(
      `Database schema ${String(version)} is newer than this app supports (${String(LATEST_SCHEMA_VERSION)}).`
    );
  }

  if (version < 1) {
    database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        provider TEXT NOT NULL CHECK (provider IN ('codex', 'claude', 'opencode')),
        model TEXT,
        reasoning TEXT NOT NULL CHECK (
          reasoning IN ('minimal', 'low', 'medium', 'high', 'xhigh', 'max')
        ),
        captain_session_name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX conversations_updated_at_idx
        ON conversations(updated_at DESC, id DESC);
      PRAGMA user_version = 1;
      COMMIT;
    `);
  }
}

function readUserVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA user_version").get() as
    { user_version?: unknown } | undefined;
  return typeof row?.user_version === "number" ? row.user_version : 0;
}
