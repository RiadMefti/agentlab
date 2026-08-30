import type { DatabaseSync } from "node:sqlite";

export const latestSchemaVersion = 5;

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

  if (version < 5) {
    database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE factory_task_contracts (
        task_id TEXT PRIMARY KEY CHECK (length(task_id) = 36),
        contract_digest TEXT NOT NULL UNIQUE CHECK (
          length(contract_digest) = 71 AND substr(contract_digest, 1, 7) = 'sha256:'
        ),
        conversation_id TEXT NOT NULL CHECK (length(conversation_id) = 36),
        repository_id TEXT NOT NULL CHECK (length(repository_id) BETWEEN 1 AND 128),
        base_revision TEXT NOT NULL CHECK (length(base_revision) IN (40, 64)),
        risk_tier TEXT NOT NULL CHECK (risk_tier IN ('R0', 'R1', 'R2', 'R3', 'R4')),
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        contract_json TEXT NOT NULL CHECK (
          length(contract_json) BETWEEN 2 AND 2097152 AND json_valid(contract_json)
        )
      ) STRICT;
      CREATE INDEX factory_task_contracts_conversation_idx
        ON factory_task_contracts(conversation_id, created_at DESC, task_id DESC);
      CREATE INDEX factory_task_contracts_repository_idx
        ON factory_task_contracts(repository_id, created_at DESC, task_id DESC);

      CREATE TABLE factory_task_events (
        event_id TEXT PRIMARY KEY CHECK (length(event_id) = 36),
        task_id TEXT NOT NULL REFERENCES factory_task_contracts(task_id),
        sequence INTEGER NOT NULL CHECK (sequence >= 1),
        event_digest TEXT NOT NULL UNIQUE CHECK (
          length(event_digest) = 71 AND substr(event_digest, 1, 7) = 'sha256:'
        ),
        previous_event_digest TEXT CHECK (
          previous_event_digest IS NULL OR
          (length(previous_event_digest) = 71 AND substr(previous_event_digest, 1, 7) = 'sha256:')
        ),
        contract_digest TEXT NOT NULL CHECK (
          length(contract_digest) = 71 AND substr(contract_digest, 1, 7) = 'sha256:'
        ),
        from_state TEXT CHECK (
          from_state IS NULL OR from_state IN (
            'intake', 'qualified', 'specified', 'planned',
            'awaiting-execution-approval', 'queued', 'executing', 'verifying',
            'reviewing', 'repairing', 'pr-proposed', 'pr-open', 'merge-ready',
            'awaiting-merge-approval', 'merge-queued', 'merged', 'canary',
            'released', 'observing', 'completed', 'needs-attention', 'rejected',
            'cancelled', 'expired', 'failed', 'quarantined', 'rolled-back'
          )
        ),
        to_state TEXT NOT NULL CHECK (
          to_state IN (
            'intake', 'qualified', 'specified', 'planned',
            'awaiting-execution-approval', 'queued', 'executing', 'verifying',
            'reviewing', 'repairing', 'pr-proposed', 'pr-open', 'merge-ready',
            'awaiting-merge-approval', 'merge-queued', 'merged', 'canary',
            'released', 'observing', 'completed', 'needs-attention', 'rejected',
            'cancelled', 'expired', 'failed', 'quarantined', 'rolled-back'
          )
        ),
        occurred_at TEXT NOT NULL,
        correlation_id TEXT NOT NULL CHECK (length(correlation_id) = 36),
        event_json TEXT NOT NULL CHECK (
          length(event_json) BETWEEN 2 AND 1048576 AND json_valid(event_json)
        ),
        UNIQUE(task_id, sequence)
      ) STRICT;
      CREATE INDEX factory_task_events_task_idx
        ON factory_task_events(task_id, sequence);

      CREATE TRIGGER factory_task_contracts_no_update
      BEFORE UPDATE ON factory_task_contracts
      BEGIN
        SELECT RAISE(ABORT, 'factory task contracts are immutable');
      END;
      CREATE TRIGGER factory_task_contracts_no_delete
      BEFORE DELETE ON factory_task_contracts
      BEGIN
        SELECT RAISE(ABORT, 'factory task contracts are immutable');
      END;
      CREATE TRIGGER factory_task_events_no_update
      BEFORE UPDATE ON factory_task_events
      BEGIN
        SELECT RAISE(ABORT, 'factory task events are append-only');
      END;
      CREATE TRIGGER factory_task_events_no_delete
      BEFORE DELETE ON factory_task_events
      BEGIN
        SELECT RAISE(ABORT, 'factory task events are append-only');
      END;
      CREATE TRIGGER factory_task_events_contract_guard
      BEFORE INSERT ON factory_task_events
      WHEN NEW.contract_digest != (
        SELECT contract_digest FROM factory_task_contracts WHERE task_id = NEW.task_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'factory event contract digest mismatch');
      END;
      CREATE TRIGGER factory_task_events_sequence_guard
      BEFORE INSERT ON factory_task_events
      WHEN NEW.sequence != COALESCE(
        (SELECT MAX(sequence) + 1 FROM factory_task_events WHERE task_id = NEW.task_id),
        1
      )
      BEGIN
        SELECT RAISE(ABORT, 'factory event sequence mismatch');
      END;
      CREATE TRIGGER factory_task_events_initial_guard
      BEFORE INSERT ON factory_task_events
      WHEN
        (NEW.sequence = 1 AND (
          NEW.previous_event_digest IS NOT NULL OR
          NEW.from_state IS NOT NULL OR
          NEW.to_state != 'intake'
        )) OR
        (NEW.sequence > 1 AND (
          NEW.previous_event_digest IS NULL OR
          NEW.from_state IS NULL
        ))
      BEGIN
        SELECT RAISE(ABORT, 'invalid factory initial event');
      END;
      CREATE TRIGGER factory_task_events_digest_chain_guard
      BEFORE INSERT ON factory_task_events
      WHEN NEW.sequence > 1 AND NEW.previous_event_digest IS NOT (
        SELECT event_digest
        FROM factory_task_events
        WHERE task_id = NEW.task_id
        ORDER BY sequence DESC
        LIMIT 1
      )
      BEGIN
        SELECT RAISE(ABORT, 'factory event digest chain mismatch');
      END;
      CREATE TRIGGER factory_task_events_from_guard
      BEFORE INSERT ON factory_task_events
      WHEN NEW.sequence > 1 AND NEW.from_state IS NOT (
        SELECT to_state
        FROM factory_task_events
        WHERE task_id = NEW.task_id
        ORDER BY sequence DESC
        LIMIT 1
      )
      BEGIN
        SELECT RAISE(ABORT, 'factory event previous state mismatch');
      END;

      CREATE TABLE factory_evidence_bundles (
        bundle_id TEXT PRIMARY KEY CHECK (length(bundle_id) = 36),
        bundle_digest TEXT NOT NULL UNIQUE CHECK (
          length(bundle_digest) = 71 AND substr(bundle_digest, 1, 7) = 'sha256:'
        ),
        task_id TEXT NOT NULL REFERENCES factory_task_contracts(task_id),
        sequence INTEGER NOT NULL CHECK (sequence >= 1),
        contract_digest TEXT NOT NULL CHECK (
          length(contract_digest) = 71 AND substr(contract_digest, 1, 7) = 'sha256:'
        ),
        previous_bundle_digest TEXT CHECK (
          previous_bundle_digest IS NULL OR
          (length(previous_bundle_digest) = 71 AND substr(previous_bundle_digest, 1, 7) = 'sha256:')
        ),
        policy_bundle_digest TEXT NOT NULL CHECK (
          length(policy_bundle_digest) = 71 AND substr(policy_bundle_digest, 1, 7) = 'sha256:'
        ),
        created_at TEXT NOT NULL,
        bundle_json TEXT NOT NULL CHECK (
          length(bundle_json) BETWEEN 2 AND 4194304 AND json_valid(bundle_json)
        ),
        UNIQUE(task_id, sequence)
      ) STRICT;
      CREATE INDEX factory_evidence_bundles_task_idx
        ON factory_evidence_bundles(task_id, sequence);
      CREATE TRIGGER factory_evidence_bundles_no_update
      BEFORE UPDATE ON factory_evidence_bundles
      BEGIN
        SELECT RAISE(ABORT, 'factory evidence bundles are append-only');
      END;
      CREATE TRIGGER factory_evidence_bundles_no_delete
      BEFORE DELETE ON factory_evidence_bundles
      BEGIN
        SELECT RAISE(ABORT, 'factory evidence bundles are append-only');
      END;
      CREATE TRIGGER factory_evidence_bundles_contract_guard
      BEFORE INSERT ON factory_evidence_bundles
      WHEN NEW.contract_digest != (
        SELECT contract_digest FROM factory_task_contracts WHERE task_id = NEW.task_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'factory evidence contract digest mismatch');
      END;
      CREATE TRIGGER factory_evidence_bundles_sequence_guard
      BEFORE INSERT ON factory_evidence_bundles
      WHEN NEW.sequence != COALESCE(
        (SELECT MAX(sequence) + 1 FROM factory_evidence_bundles WHERE task_id = NEW.task_id),
        1
      )
      BEGIN
        SELECT RAISE(ABORT, 'factory evidence sequence mismatch');
      END;
      CREATE TRIGGER factory_evidence_bundles_initial_guard
      BEFORE INSERT ON factory_evidence_bundles
      WHEN
        (NEW.sequence = 1 AND NEW.previous_bundle_digest IS NOT NULL) OR
        (NEW.sequence > 1 AND NEW.previous_bundle_digest IS NULL)
      BEGIN
        SELECT RAISE(ABORT, 'invalid factory initial evidence bundle');
      END;
      CREATE TRIGGER factory_evidence_bundles_chain_guard
      BEFORE INSERT ON factory_evidence_bundles
      WHEN NEW.sequence > 1 AND NEW.previous_bundle_digest IS NOT (
        SELECT bundle_digest
        FROM factory_evidence_bundles
        WHERE task_id = NEW.task_id
        ORDER BY sequence DESC
        LIMIT 1
      )
      BEGIN
        SELECT RAISE(ABORT, 'factory evidence digest chain mismatch');
      END;

      CREATE TABLE factory_control_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE CHECK (length(event_id) = 36),
        event_digest TEXT NOT NULL UNIQUE CHECK (
          length(event_digest) = 71 AND substr(event_digest, 1, 7) = 'sha256:'
        ),
        control_name TEXT NOT NULL CHECK (control_name IN ('scheduler', 'pr-broker')),
        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
        event_json TEXT NOT NULL CHECK (
          length(event_json) BETWEEN 2 AND 65536 AND json_valid(event_json)
        ),
        occurred_at TEXT NOT NULL,
        reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 500)
      ) STRICT;
      CREATE INDEX factory_control_events_name_idx
        ON factory_control_events(control_name, sequence DESC);
      CREATE TRIGGER factory_control_events_no_update
      BEFORE UPDATE ON factory_control_events
      BEGIN
        SELECT RAISE(ABORT, 'factory control events are append-only');
      END;
      CREATE TRIGGER factory_control_events_no_delete
      BEFORE DELETE ON factory_control_events
      BEGIN
        SELECT RAISE(ABORT, 'factory control events are append-only');
      END;

      PRAGMA user_version = 5;
      COMMIT;
    `);
  }
}

function readUserVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA user_version").get() as
    { user_version?: unknown } | undefined;
  return typeof row?.user_version === "number" ? row.user_version : 0;
}
