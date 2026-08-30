import type { DatabaseSync } from "node:sqlite";

export const latestSchemaVersion = 4;

/** Applies forward-only SQLite migrations in transactions. */
export function migrate(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA journal_mode = WAL");
  const version = readUserVersion(database);

  if (version > latestSchemaVersion) {
    throw new Error(
      `Database schema ${String(version)} is newer than this app supports (${String(latestSchemaVersion)}).`
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

  if (version < 2) {
    database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE conversations_v2 (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        provider TEXT NOT NULL CHECK (provider IN ('codex', 'claude', 'opencode')),
        model TEXT,
        reasoning TEXT CHECK (
          reasoning IS NULL OR length(reasoning) BETWEEN 1 AND 40
        ),
        captain_session_name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO conversations_v2 (
        id,
        title,
        provider,
        model,
        reasoning,
        captain_session_name,
        created_at,
        updated_at
      )
      SELECT
        id,
        title,
        provider,
        model,
        reasoning,
        captain_session_name,
        created_at,
        updated_at
      FROM conversations;
      DROP TABLE conversations;
      ALTER TABLE conversations_v2 RENAME TO conversations;
      CREATE INDEX conversations_updated_at_idx
        ON conversations(updated_at DESC, id DESC);
      PRAGMA user_version = 2;
      COMMIT;
    `);
  }

  if (version < 3) {
    database.exec(`
      BEGIN IMMEDIATE;
      ALTER TABLE conversations ADD COLUMN workspace_path TEXT CHECK (
        workspace_path IS NULL OR length(workspace_path) BETWEEN 1 AND 4096
      );
      CREATE UNIQUE INDEX conversations_workspace_path_idx
        ON conversations(workspace_path)
        WHERE workspace_path IS NOT NULL;
      PRAGMA user_version = 3;
      COMMIT;
    `);
  }

  if (version < 4) {
    database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE conversations_v4 (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        provider TEXT NOT NULL CHECK (provider IN ('codex', 'claude', 'opencode')),
        model TEXT,
        reasoning TEXT CHECK (
          reasoning IS NULL OR length(reasoning) BETWEEN 1 AND 40
        ),
        captain_session_name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        workspace_path TEXT CHECK (
          workspace_path IS NULL OR length(workspace_path) BETWEEN 1 AND 4096
        ),
        lifecycle_state TEXT NOT NULL CHECK (
          lifecycle_state IN ('creating', 'active', 'deleting', 'legacy-unlinked')
        ),
        ownership_mode TEXT NOT NULL CHECK (ownership_mode IN ('nonce', 'legacy-name')),
        ownership_nonce TEXT CHECK (
          ownership_nonce IS NULL OR length(ownership_nonce) BETWEEN 1 AND 200
        ),
        CHECK (
          (ownership_mode = 'nonce' AND ownership_nonce IS NOT NULL) OR
          (ownership_mode = 'legacy-name' AND ownership_nonce IS NULL)
        ),
        CHECK (lifecycle_state != 'creating' OR ownership_mode = 'nonce'),
        CHECK (lifecycle_state != 'legacy-unlinked' OR ownership_mode = 'legacy-name'),
        CHECK (lifecycle_state NOT IN ('creating', 'active') OR workspace_path IS NOT NULL),
        CHECK (lifecycle_state != 'legacy-unlinked' OR workspace_path IS NULL)
      ) STRICT;
      INSERT INTO conversations_v4 (
        id,
        title,
        provider,
        model,
        reasoning,
        captain_session_name,
        created_at,
        updated_at,
        workspace_path,
        lifecycle_state,
        ownership_mode,
        ownership_nonce
      )
      SELECT
        id,
        title,
        provider,
        model,
        reasoning,
        captain_session_name,
        created_at,
        updated_at,
        workspace_path,
        CASE WHEN workspace_path IS NULL THEN 'legacy-unlinked' ELSE 'active' END,
        'legacy-name',
        NULL
      FROM conversations;
      DROP TABLE conversations;
      ALTER TABLE conversations_v4 RENAME TO conversations;
      CREATE INDEX conversations_updated_at_idx
        ON conversations(updated_at DESC, id DESC);
      CREATE UNIQUE INDEX conversations_workspace_path_idx
        ON conversations(workspace_path)
        WHERE workspace_path IS NOT NULL;
      CREATE INDEX conversations_lifecycle_state_idx
        ON conversations(lifecycle_state, updated_at DESC, id DESC);
      PRAGMA user_version = 4;
      COMMIT;
    `);
  }
}

function readUserVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA user_version").get() as
    { user_version?: unknown } | undefined;
  return typeof row?.user_version === "number" ? row.user_version : 0;
}
