import type { DatabaseSync } from "node:sqlite";

export const latestSchemaVersion = 7;

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

  if (version < 6) {
    database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE factory_preparations (
        task_id TEXT PRIMARY KEY CHECK (length(task_id) = 36),
        request_digest TEXT NOT NULL UNIQUE CHECK (
          length(request_digest) = 71 AND substr(request_digest, 1, 7) = 'sha256:'
        ),
        authority_digest TEXT NOT NULL UNIQUE CHECK (
          length(authority_digest) = 71 AND substr(authority_digest, 1, 7) = 'sha256:'
        ),
        conversation_id TEXT NOT NULL CHECK (length(conversation_id) = 36),
        deduplication_key TEXT NOT NULL CHECK (
          length(deduplication_key) = 71 AND substr(deduplication_key, 1, 7) = 'sha256:'
        ),
        repository_id TEXT NOT NULL CHECK (length(repository_id) BETWEEN 1 AND 128),
        base_revision TEXT NOT NULL CHECK (length(base_revision) IN (40, 64)),
        created_at TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        request_json TEXT NOT NULL CHECK (
          length(request_json) BETWEEN 2 AND 2097152 AND json_valid(request_json)
        ),
        authority_json TEXT NOT NULL CHECK (
          length(authority_json) BETWEEN 2 AND 4194304 AND json_valid(authority_json)
        ),
        UNIQUE(repository_id, deduplication_key)
      ) STRICT;
      CREATE INDEX factory_preparations_conversation_idx
        ON factory_preparations(conversation_id, created_at DESC, task_id DESC);
      CREATE INDEX factory_preparations_repository_idx
        ON factory_preparations(repository_id, created_at DESC, task_id DESC);

      CREATE TABLE factory_preparation_events (
        event_id TEXT PRIMARY KEY CHECK (length(event_id) = 36),
        task_id TEXT NOT NULL REFERENCES factory_preparations(task_id),
        sequence INTEGER NOT NULL CHECK (sequence BETWEEN 1 AND 1000),
        event_digest TEXT NOT NULL UNIQUE CHECK (
          length(event_digest) = 71 AND substr(event_digest, 1, 7) = 'sha256:'
        ),
        previous_event_digest TEXT CHECK (
          previous_event_digest IS NULL OR
          (length(previous_event_digest) = 71 AND substr(previous_event_digest, 1, 7) = 'sha256:')
        ),
        request_digest TEXT NOT NULL CHECK (
          length(request_digest) = 71 AND substr(request_digest, 1, 7) = 'sha256:'
        ),
        authority_digest TEXT NOT NULL CHECK (
          length(authority_digest) = 71 AND substr(authority_digest, 1, 7) = 'sha256:'
        ),
        kind TEXT NOT NULL CHECK (kind IN (
          'registered', 'phase-started', 'phase-succeeded', 'phase-failed',
          'phase-abandoned', 'needs-human', 'rejected', 'prepared', 'failed',
          'cancelled', 'expired'
        )),
        phase TEXT CHECK (phase IS NULL OR phase IN ('qualify', 'specify', 'plan')),
        execution_id TEXT CHECK (execution_id IS NULL OR length(execution_id) = 36),
        attempt INTEGER CHECK (attempt IS NULL OR attempt BETWEEN 1 AND 5),
        from_state TEXT CHECK (
          from_state IS NULL OR from_state IN (
            'registered', 'qualifying', 'qualified', 'specifying', 'specified',
            'planning', 'planned', 'prepared', 'needs-human', 'rejected', 'failed',
            'cancelled', 'expired'
          )
        ),
        to_state TEXT NOT NULL CHECK (to_state IN (
          'registered', 'qualifying', 'qualified', 'specifying', 'specified',
          'planning', 'planned', 'prepared', 'needs-human', 'rejected', 'failed',
          'cancelled', 'expired'
        )),
        occurred_at TEXT NOT NULL,
        correlation_id TEXT NOT NULL CHECK (length(correlation_id) = 36),
        event_json TEXT NOT NULL CHECK (
          length(event_json) BETWEEN 2 AND 2097152 AND json_valid(event_json)
        ),
        UNIQUE(task_id, sequence)
      ) STRICT;
      CREATE INDEX factory_preparation_events_task_idx
        ON factory_preparation_events(task_id, sequence);
      CREATE INDEX factory_preparation_events_execution_idx
        ON factory_preparation_events(task_id, execution_id)
        WHERE execution_id IS NOT NULL;

      CREATE TRIGGER factory_preparations_no_update
      BEFORE UPDATE ON factory_preparations
      BEGIN
        SELECT RAISE(ABORT, 'factory preparations are immutable');
      END;
      CREATE TRIGGER factory_preparations_no_delete
      BEFORE DELETE ON factory_preparations
      BEGIN
        SELECT RAISE(ABORT, 'factory preparations are immutable');
      END;
      CREATE TRIGGER factory_preparation_events_no_update
      BEFORE UPDATE ON factory_preparation_events
      BEGIN
        SELECT RAISE(ABORT, 'factory preparation events are append-only');
      END;
      CREATE TRIGGER factory_preparation_events_no_delete
      BEFORE DELETE ON factory_preparation_events
      BEGIN
        SELECT RAISE(ABORT, 'factory preparation events are append-only');
      END;
      CREATE TRIGGER factory_preparation_events_identity_guard
      BEFORE INSERT ON factory_preparation_events
      WHEN
        NEW.request_digest != (
          SELECT request_digest FROM factory_preparations WHERE task_id = NEW.task_id
        ) OR
        NEW.authority_digest != (
          SELECT authority_digest FROM factory_preparations WHERE task_id = NEW.task_id
        )
      BEGIN
        SELECT RAISE(ABORT, 'factory preparation identity mismatch');
      END;
      CREATE TRIGGER factory_preparation_events_sequence_guard
      BEFORE INSERT ON factory_preparation_events
      WHEN NEW.sequence != COALESCE(
        (SELECT MAX(sequence) + 1 FROM factory_preparation_events WHERE task_id = NEW.task_id),
        1
      )
      BEGIN
        SELECT RAISE(ABORT, 'factory preparation event sequence mismatch');
      END;
      CREATE TRIGGER factory_preparation_events_initial_guard
      BEFORE INSERT ON factory_preparation_events
      WHEN
        (NEW.sequence = 1 AND (
          NEW.previous_event_digest IS NOT NULL OR NEW.from_state IS NOT NULL OR
          NEW.to_state != 'registered' OR NEW.kind != 'registered'
        )) OR
        (NEW.sequence > 1 AND (
          NEW.previous_event_digest IS NULL OR NEW.from_state IS NULL OR NEW.kind = 'registered'
        ))
      BEGIN
        SELECT RAISE(ABORT, 'invalid factory preparation initial event');
      END;
      CREATE TRIGGER factory_preparation_events_digest_chain_guard
      BEFORE INSERT ON factory_preparation_events
      WHEN NEW.sequence > 1 AND NEW.previous_event_digest IS NOT (
        SELECT event_digest FROM factory_preparation_events
        WHERE task_id = NEW.task_id ORDER BY sequence DESC LIMIT 1
      )
      BEGIN
        SELECT RAISE(ABORT, 'factory preparation event digest chain mismatch');
      END;
      CREATE TRIGGER factory_preparation_events_from_guard
      BEFORE INSERT ON factory_preparation_events
      WHEN NEW.sequence > 1 AND NEW.from_state IS NOT (
        SELECT to_state FROM factory_preparation_events
        WHERE task_id = NEW.task_id ORDER BY sequence DESC LIMIT 1
      )
      BEGIN
        SELECT RAISE(ABORT, 'factory preparation previous state mismatch');
      END;
      CREATE TRIGGER factory_preparation_events_run_fields_guard
      BEFORE INSERT ON factory_preparation_events
      WHEN
        (NEW.kind IN (
          'phase-started', 'phase-succeeded', 'phase-failed', 'phase-abandoned',
          'needs-human', 'rejected'
        ) AND (NEW.phase IS NULL OR NEW.execution_id IS NULL OR NEW.attempt IS NULL)) OR
        (NEW.kind NOT IN (
          'phase-started', 'phase-succeeded', 'phase-failed', 'phase-abandoned',
          'needs-human', 'rejected'
        ) AND (NEW.phase IS NOT NULL OR NEW.execution_id IS NOT NULL OR NEW.attempt IS NOT NULL))
      BEGIN
        SELECT RAISE(ABORT, 'factory preparation event run fields mismatch');
      END;
      CREATE TRIGGER factory_preparation_events_transition_guard
      BEFORE INSERT ON factory_preparation_events
      WHEN NOT (
        (NEW.kind = 'registered' AND NEW.from_state IS NULL AND NEW.to_state = 'registered') OR
        (NEW.kind = 'phase-started' AND (
          (NEW.phase = 'qualify' AND NEW.from_state = 'registered' AND NEW.to_state = 'qualifying') OR
          (NEW.phase = 'specify' AND NEW.from_state = 'qualified' AND NEW.to_state = 'specifying') OR
          (NEW.phase = 'plan' AND NEW.from_state = 'specified' AND NEW.to_state = 'planning')
        )) OR
        (NEW.kind = 'phase-succeeded' AND (
          (NEW.phase = 'qualify' AND NEW.from_state = 'qualifying' AND NEW.to_state = 'qualified') OR
          (NEW.phase = 'specify' AND NEW.from_state = 'specifying' AND NEW.to_state = 'specified') OR
          (NEW.phase = 'plan' AND NEW.from_state = 'planning' AND NEW.to_state = 'planned')
        )) OR
        (NEW.kind IN ('phase-failed', 'phase-abandoned') AND (
          (NEW.phase = 'qualify' AND NEW.from_state = 'qualifying' AND NEW.to_state = 'registered') OR
          (NEW.phase = 'specify' AND NEW.from_state = 'specifying' AND NEW.to_state = 'qualified') OR
          (NEW.phase = 'plan' AND NEW.from_state = 'planning' AND NEW.to_state = 'specified')
        )) OR
        (NEW.kind = 'needs-human' AND NEW.phase = 'qualify' AND
          NEW.from_state = 'qualifying' AND NEW.to_state = 'needs-human') OR
        (NEW.kind = 'rejected' AND NEW.phase = 'qualify' AND
          NEW.from_state = 'qualifying' AND NEW.to_state = 'rejected') OR
        (NEW.kind = 'prepared' AND NEW.from_state = 'planned' AND NEW.to_state = 'prepared') OR
        (NEW.kind IN ('failed', 'cancelled', 'expired') AND
          NEW.from_state IN (
            'registered', 'qualifying', 'qualified', 'specifying', 'specified', 'planning', 'planned'
          ) AND NEW.to_state = NEW.kind)
      )
      BEGIN
        SELECT RAISE(ABORT, 'illegal factory preparation transition');
      END;

      PRAGMA user_version = 6;
      COMMIT;
    `);
  }

  if (version < 7) {
    database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE factory_execution_runs (
        run_id TEXT PRIMARY KEY CHECK (length(run_id) = 36),
        run_digest TEXT NOT NULL UNIQUE CHECK (
          length(run_digest) = 71 AND substr(run_digest, 1, 7) = 'sha256:'
        ),
        task_id TEXT NOT NULL UNIQUE REFERENCES factory_task_contracts(task_id),
        contract_digest TEXT NOT NULL CHECK (
          length(contract_digest) = 71 AND substr(contract_digest, 1, 7) = 'sha256:'
        ),
        repository_id TEXT NOT NULL CHECK (length(repository_id) BETWEEN 1 AND 128),
        base_revision TEXT NOT NULL CHECK (length(base_revision) IN (40, 64)),
        maximum_attempts INTEGER NOT NULL CHECK (maximum_attempts BETWEEN 1 AND 20),
        created_at TEXT NOT NULL,
        correlation_id TEXT NOT NULL CHECK (length(correlation_id) = 36),
        run_json TEXT NOT NULL CHECK (
          length(run_json) BETWEEN 2 AND 1048576 AND json_valid(run_json)
        )
      ) STRICT;
      CREATE INDEX factory_execution_runs_recoverable_idx
        ON factory_execution_runs(created_at, task_id);

      CREATE TABLE factory_execution_events (
        event_id TEXT PRIMARY KEY CHECK (length(event_id) = 36),
        run_id TEXT NOT NULL REFERENCES factory_execution_runs(run_id),
        run_digest TEXT NOT NULL CHECK (
          length(run_digest) = 71 AND substr(run_digest, 1, 7) = 'sha256:'
        ),
        task_id TEXT NOT NULL,
        contract_digest TEXT NOT NULL CHECK (
          length(contract_digest) = 71 AND substr(contract_digest, 1, 7) = 'sha256:'
        ),
        sequence INTEGER NOT NULL CHECK (sequence BETWEEN 1 AND 10000),
        event_digest TEXT NOT NULL UNIQUE CHECK (
          length(event_digest) = 71 AND substr(event_digest, 1, 7) = 'sha256:'
        ),
        previous_event_digest TEXT CHECK (
          previous_event_digest IS NULL OR
          (length(previous_event_digest) = 71 AND substr(previous_event_digest, 1, 7) = 'sha256:')
        ),
        kind TEXT NOT NULL CHECK (kind IN (
          'registered', 'attempt-started', 'operation-started', 'operation-finished',
          'attempt-closed', 'execution-finished', 'execution-abandoned'
        )),
        from_state TEXT CHECK (
          from_state IS NULL OR from_state IN (
            'ready', 'workspace-active', 'operation-active', 'completed', 'abandoned'
          )
        ),
        to_state TEXT NOT NULL CHECK (to_state IN (
          'ready', 'workspace-active', 'operation-active', 'completed', 'abandoned'
        )),
        attempt INTEGER CHECK (attempt IS NULL OR attempt BETWEEN 1 AND 20),
        workspace_id TEXT CHECK (workspace_id IS NULL OR length(workspace_id) = 36),
        operation_id TEXT CHECK (operation_id IS NULL OR length(operation_id) = 36),
        operation_kind TEXT CHECK (operation_kind IS NULL OR operation_kind IN ('agent', 'gate')),
        execution_role TEXT CHECK (
          execution_role IS NULL OR execution_role IN ('implementer', 'repairer', 'reviewer')
        ),
        gate_id TEXT CHECK (gate_id IS NULL OR length(gate_id) BETWEEN 1 AND 128),
        request_digest TEXT CHECK (
          request_digest IS NULL OR
          (length(request_digest) = 71 AND substr(request_digest, 1, 7) = 'sha256:')
        ),
        result TEXT CHECK (
          result IS NULL OR result IN ('succeeded', 'failed', 'timed-out', 'error')
        ),
        record_digest TEXT CHECK (
          record_digest IS NULL OR
          (length(record_digest) = 71 AND substr(record_digest, 1, 7) = 'sha256:')
        ),
        disposition TEXT CHECK (
          disposition IS NULL OR disposition IN ('continue', 'finish')
        ),
        task_state TEXT CHECK (
          task_state IS NULL OR task_state IN (
            'pr-proposed', 'needs-attention', 'failed', 'quarantined'
          )
        ),
        occurred_at TEXT NOT NULL,
        reason_code TEXT NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 128),
        correlation_id TEXT NOT NULL CHECK (length(correlation_id) = 36),
        event_json TEXT NOT NULL CHECK (
          length(event_json) BETWEEN 2 AND 2097152 AND json_valid(event_json)
        ),
        UNIQUE(run_id, sequence)
      ) STRICT;
      CREATE INDEX factory_execution_events_run_idx
        ON factory_execution_events(run_id, sequence);
      CREATE INDEX factory_execution_events_task_idx
        ON factory_execution_events(task_id, sequence);
      CREATE INDEX factory_execution_events_operation_idx
        ON factory_execution_events(operation_id)
        WHERE operation_id IS NOT NULL;
      CREATE UNIQUE INDEX factory_execution_events_workspace_start_idx
        ON factory_execution_events(workspace_id)
        WHERE kind = 'attempt-started';
      CREATE UNIQUE INDEX factory_execution_events_operation_start_idx
        ON factory_execution_events(operation_id)
        WHERE kind = 'operation-started';

      CREATE TRIGGER factory_execution_runs_no_update
      BEFORE UPDATE ON factory_execution_runs
      BEGIN
        SELECT RAISE(ABORT, 'factory execution runs are immutable');
      END;
      CREATE TRIGGER factory_execution_runs_no_delete
      BEFORE DELETE ON factory_execution_runs
      BEGIN
        SELECT RAISE(ABORT, 'factory execution runs are immutable');
      END;
      CREATE TRIGGER factory_execution_runs_contract_guard
      BEFORE INSERT ON factory_execution_runs
      WHEN
        NEW.contract_digest != (
          SELECT contract_digest FROM factory_task_contracts WHERE task_id = NEW.task_id
        ) OR
        NEW.repository_id != (
          SELECT repository_id FROM factory_task_contracts WHERE task_id = NEW.task_id
        ) OR
        NEW.base_revision != (
          SELECT base_revision FROM factory_task_contracts WHERE task_id = NEW.task_id
        ) OR
        NEW.created_at < (
          SELECT created_at FROM factory_task_contracts WHERE task_id = NEW.task_id
        ) OR
        NEW.created_at >= (
          SELECT expires_at FROM factory_task_contracts WHERE task_id = NEW.task_id
        ) OR
        NEW.maximum_attempts != 1 + CAST(json_extract((
          SELECT contract_json FROM factory_task_contracts WHERE task_id = NEW.task_id
        ), '$.budget.maxRepairAttempts') AS INTEGER)
      BEGIN
        SELECT RAISE(ABORT, 'factory execution run contract mismatch');
      END;

      CREATE TRIGGER factory_execution_events_no_update
      BEFORE UPDATE ON factory_execution_events
      BEGIN
        SELECT RAISE(ABORT, 'factory execution events are append-only');
      END;
      CREATE TRIGGER factory_execution_events_no_delete
      BEFORE DELETE ON factory_execution_events
      BEGIN
        SELECT RAISE(ABORT, 'factory execution events are append-only');
      END;
      CREATE TRIGGER factory_execution_events_identity_guard
      BEFORE INSERT ON factory_execution_events
      WHEN
        NEW.run_digest != (
          SELECT run_digest FROM factory_execution_runs WHERE run_id = NEW.run_id
        ) OR
        NEW.task_id != (
          SELECT task_id FROM factory_execution_runs WHERE run_id = NEW.run_id
        ) OR
        NEW.contract_digest != (
          SELECT contract_digest FROM factory_execution_runs WHERE run_id = NEW.run_id
        )
      BEGIN
        SELECT RAISE(ABORT, 'factory execution event identity mismatch');
      END;
      CREATE TRIGGER factory_execution_events_sequence_guard
      BEFORE INSERT ON factory_execution_events
      WHEN NEW.sequence != COALESCE(
        (SELECT MAX(sequence) + 1 FROM factory_execution_events WHERE run_id = NEW.run_id),
        1
      )
      BEGIN
        SELECT RAISE(ABORT, 'factory execution event sequence mismatch');
      END;
      CREATE TRIGGER factory_execution_events_chain_guard
      BEFORE INSERT ON factory_execution_events
      WHEN
        (NEW.sequence = 1 AND NEW.previous_event_digest IS NOT NULL) OR
        (NEW.sequence > 1 AND NEW.previous_event_digest IS NOT (
          SELECT event_digest FROM factory_execution_events
          WHERE run_id = NEW.run_id ORDER BY sequence DESC LIMIT 1
        ))
      BEGIN
        SELECT RAISE(ABORT, 'factory execution event digest chain mismatch');
      END;
      CREATE TRIGGER factory_execution_events_from_guard
      BEFORE INSERT ON factory_execution_events
      WHEN
        (NEW.sequence = 1 AND NEW.from_state IS NOT NULL) OR
        (NEW.sequence > 1 AND NEW.from_state IS NOT (
          SELECT to_state FROM factory_execution_events
          WHERE run_id = NEW.run_id ORDER BY sequence DESC LIMIT 1
        ))
      BEGIN
        SELECT RAISE(ABORT, 'factory execution previous state mismatch');
      END;
      CREATE TRIGGER factory_execution_events_transition_guard
      BEFORE INSERT ON factory_execution_events
      WHEN NOT (
        (NEW.kind = 'registered' AND NEW.from_state IS NULL AND NEW.to_state = 'ready') OR
        (NEW.kind = 'attempt-started' AND
          NEW.from_state = 'ready' AND NEW.to_state = 'workspace-active') OR
        (NEW.kind = 'operation-started' AND
          NEW.from_state = 'workspace-active' AND NEW.to_state = 'operation-active') OR
        (NEW.kind = 'operation-finished' AND
          NEW.from_state = 'operation-active' AND NEW.to_state = 'workspace-active') OR
        (NEW.kind = 'attempt-closed' AND
          NEW.from_state = 'workspace-active' AND NEW.to_state = 'ready') OR
        (NEW.kind = 'execution-finished' AND
          NEW.from_state = 'ready' AND NEW.to_state = 'completed') OR
        (NEW.kind = 'execution-abandoned' AND
          NEW.from_state IN ('ready', 'workspace-active', 'operation-active') AND
          NEW.to_state = 'abandoned')
      )
      BEGIN
        SELECT RAISE(ABORT, 'illegal factory execution transition');
      END;
      CREATE TRIGGER factory_execution_events_fields_guard
      BEFORE INSERT ON factory_execution_events
      WHEN NOT (
        (NEW.kind = 'registered' AND
          NEW.attempt IS NULL AND NEW.workspace_id IS NULL AND NEW.operation_id IS NULL AND
          NEW.operation_kind IS NULL AND NEW.execution_role IS NULL AND NEW.gate_id IS NULL AND
          NEW.request_digest IS NULL AND NEW.result IS NULL AND NEW.record_digest IS NULL AND
          NEW.disposition IS NULL AND NEW.task_state IS NULL) OR
        (NEW.kind = 'attempt-started' AND
          NEW.attempt IS NOT NULL AND NEW.workspace_id IS NOT NULL AND NEW.operation_id IS NULL AND
          NEW.operation_kind IS NULL AND NEW.execution_role IS NULL AND NEW.gate_id IS NULL AND
          NEW.request_digest IS NULL AND NEW.result IS NULL AND NEW.record_digest IS NULL AND
          NEW.disposition IS NULL AND NEW.task_state IS NULL) OR
        (NEW.kind = 'operation-started' AND
          NEW.attempt IS NOT NULL AND NEW.workspace_id IS NOT NULL AND NEW.operation_id IS NOT NULL AND
          NEW.operation_kind IS NOT NULL AND NEW.result IS NULL AND NEW.record_digest IS NULL AND
          NEW.disposition IS NULL AND NEW.task_state IS NULL AND (
            (NEW.operation_kind = 'agent' AND NEW.execution_role IS NOT NULL AND
              NEW.gate_id IS NULL AND NEW.request_digest IS NOT NULL) OR
            (NEW.operation_kind = 'gate' AND NEW.execution_role IS NULL AND
              NEW.gate_id IS NOT NULL AND NEW.request_digest IS NULL)
          )) OR
        (NEW.kind = 'operation-finished' AND
          NEW.attempt IS NOT NULL AND NEW.workspace_id IS NOT NULL AND NEW.operation_id IS NOT NULL AND
          NEW.operation_kind IS NOT NULL AND NEW.result IS NOT NULL AND NEW.record_digest IS NOT NULL AND
          NEW.disposition IS NULL AND NEW.task_state IS NULL AND (
            (NEW.operation_kind = 'agent' AND NEW.execution_role IS NOT NULL AND
              NEW.gate_id IS NULL AND NEW.request_digest IS NOT NULL) OR
            (NEW.operation_kind = 'gate' AND NEW.execution_role IS NULL AND
              NEW.gate_id IS NOT NULL AND NEW.request_digest IS NULL)
          )) OR
        (NEW.kind = 'attempt-closed' AND
          NEW.attempt IS NOT NULL AND NEW.workspace_id IS NOT NULL AND NEW.operation_id IS NULL AND
          NEW.operation_kind IS NULL AND NEW.execution_role IS NULL AND NEW.gate_id IS NULL AND
          NEW.request_digest IS NULL AND NEW.result IS NULL AND NEW.record_digest IS NULL AND
          NEW.disposition IS NOT NULL AND NEW.task_state IS NULL) OR
        (NEW.kind = 'execution-finished' AND
          NEW.attempt IS NULL AND NEW.workspace_id IS NULL AND NEW.operation_id IS NULL AND
          NEW.operation_kind IS NULL AND NEW.execution_role IS NULL AND NEW.gate_id IS NULL AND
          NEW.request_digest IS NULL AND NEW.result IS NULL AND NEW.record_digest IS NULL AND
          NEW.disposition IS NULL AND NEW.task_state IS NOT NULL) OR
        (NEW.kind = 'execution-abandoned' AND
          NEW.operation_kind IS NULL AND NEW.execution_role IS NULL AND NEW.gate_id IS NULL AND
          NEW.request_digest IS NULL AND NEW.result IS NULL AND NEW.record_digest IS NULL AND
          NEW.disposition IS NULL AND NEW.task_state IS NULL AND (
            (NEW.from_state = 'ready' AND NEW.attempt IS NULL AND
              NEW.workspace_id IS NULL AND NEW.operation_id IS NULL) OR
            (NEW.from_state = 'workspace-active' AND NEW.attempt IS NOT NULL AND
              NEW.workspace_id IS NOT NULL AND NEW.operation_id IS NULL) OR
            (NEW.from_state = 'operation-active' AND NEW.attempt IS NOT NULL AND
              NEW.workspace_id IS NOT NULL AND NEW.operation_id IS NOT NULL)
          ))
      )
      BEGIN
        SELECT RAISE(ABORT, 'factory execution event fields mismatch');
      END;
      CREATE TRIGGER factory_execution_events_attempt_guard
      BEFORE INSERT ON factory_execution_events
      WHEN
        (NEW.attempt IS NOT NULL AND NEW.attempt > (
          SELECT maximum_attempts FROM factory_execution_runs WHERE run_id = NEW.run_id
        )) OR
        (NEW.kind = 'attempt-started' AND NEW.attempt != 1 + (
          SELECT COUNT(*) FROM factory_execution_events
          WHERE run_id = NEW.run_id AND kind = 'attempt-started'
        ))
      BEGIN
        SELECT RAISE(ABORT, 'factory execution attempt mismatch');
      END;
      CREATE TRIGGER factory_execution_events_coordinates_guard
      BEFORE INSERT ON factory_execution_events
      WHEN
        (NEW.kind IN ('operation-started', 'operation-finished', 'attempt-closed') AND (
          NEW.attempt IS NOT (
            SELECT attempt FROM factory_execution_events
            WHERE run_id = NEW.run_id ORDER BY sequence DESC LIMIT 1
          ) OR
          NEW.workspace_id IS NOT (
            SELECT workspace_id FROM factory_execution_events
            WHERE run_id = NEW.run_id ORDER BY sequence DESC LIMIT 1
          )
        )) OR
        (NEW.kind = 'operation-finished' AND (
          NEW.operation_id IS NOT (
            SELECT operation_id FROM factory_execution_events
            WHERE run_id = NEW.run_id ORDER BY sequence DESC LIMIT 1
          ) OR
          NEW.operation_kind IS NOT (
            SELECT operation_kind FROM factory_execution_events
            WHERE run_id = NEW.run_id ORDER BY sequence DESC LIMIT 1
          ) OR
          NEW.execution_role IS NOT (
            SELECT execution_role FROM factory_execution_events
            WHERE run_id = NEW.run_id ORDER BY sequence DESC LIMIT 1
          ) OR
          NEW.gate_id IS NOT (
            SELECT gate_id FROM factory_execution_events
            WHERE run_id = NEW.run_id ORDER BY sequence DESC LIMIT 1
          ) OR
          NEW.request_digest IS NOT (
            SELECT request_digest FROM factory_execution_events
            WHERE run_id = NEW.run_id ORDER BY sequence DESC LIMIT 1
          )
        )) OR
        (NEW.kind = 'execution-abandoned' AND NEW.from_state != 'ready' AND (
          NEW.attempt IS NOT (
            SELECT attempt FROM factory_execution_events
            WHERE run_id = NEW.run_id ORDER BY sequence DESC LIMIT 1
          ) OR
          NEW.workspace_id IS NOT (
            SELECT workspace_id FROM factory_execution_events
            WHERE run_id = NEW.run_id ORDER BY sequence DESC LIMIT 1
          ) OR
          NEW.operation_id IS NOT (
            SELECT operation_id FROM factory_execution_events
            WHERE run_id = NEW.run_id ORDER BY sequence DESC LIMIT 1
          )
        ))
      BEGIN
        SELECT RAISE(ABORT, 'factory execution resource coordinates mismatch');
      END;
      CREATE TRIGGER factory_execution_events_timestamp_guard
      BEFORE INSERT ON factory_execution_events
      WHEN NEW.sequence > 1 AND NEW.occurred_at < (
        SELECT occurred_at FROM factory_execution_events
        WHERE run_id = NEW.run_id ORDER BY sequence DESC LIMIT 1
      )
      BEGIN
        SELECT RAISE(ABORT, 'factory execution timestamp predates predecessor');
      END;

      PRAGMA user_version = 7;
      COMMIT;
    `);
  }
}

function readUserVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA user_version").get() as
    { user_version?: unknown } | undefined;
  return typeof row?.user_version === "number" ? row.user_version : 0;
}
