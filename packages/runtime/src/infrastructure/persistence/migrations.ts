import type { DatabaseSync } from "node:sqlite";

export const latestSchemaVersion = 12;

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

  if (version < 8) {
    database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE factory_pull_request_dispatches (
        dispatch_id TEXT PRIMARY KEY CHECK (length(dispatch_id) = 36),
        dispatch_digest TEXT NOT NULL UNIQUE CHECK (
          length(dispatch_digest) = 71 AND substr(dispatch_digest, 1, 7) = 'sha256:'
        ),
        task_id TEXT NOT NULL UNIQUE REFERENCES factory_task_contracts(task_id),
        contract_digest TEXT NOT NULL CHECK (
          length(contract_digest) = 71 AND substr(contract_digest, 1, 7) = 'sha256:'
        ),
        proposal_digest TEXT NOT NULL UNIQUE CHECK (
          length(proposal_digest) = 71 AND substr(proposal_digest, 1, 7) = 'sha256:'
        ),
        broker_id TEXT NOT NULL CHECK (length(broker_id) BETWEEN 1 AND 128),
        repository_id TEXT NOT NULL CHECK (length(repository_id) BETWEEN 1 AND 128),
        base_revision TEXT NOT NULL CHECK (length(base_revision) IN (40, 64)),
        branch_name TEXT NOT NULL CHECK (length(branch_name) BETWEEN 1 AND 128),
        created_at TEXT NOT NULL,
        correlation_id TEXT NOT NULL CHECK (length(correlation_id) = 36),
        dispatch_json TEXT NOT NULL CHECK (
          length(dispatch_json) BETWEEN 2 AND 2097152 AND json_valid(dispatch_json)
        ),
        UNIQUE(repository_id, branch_name)
      ) STRICT;
      CREATE INDEX factory_pull_request_dispatches_recoverable_idx
        ON factory_pull_request_dispatches(created_at, task_id);

      CREATE TABLE factory_pull_request_dispatch_events (
        event_id TEXT PRIMARY KEY CHECK (length(event_id) = 36),
        dispatch_id TEXT NOT NULL REFERENCES factory_pull_request_dispatches(dispatch_id),
        dispatch_digest TEXT NOT NULL CHECK (
          length(dispatch_digest) = 71 AND substr(dispatch_digest, 1, 7) = 'sha256:'
        ),
        task_id TEXT NOT NULL,
        contract_digest TEXT NOT NULL CHECK (
          length(contract_digest) = 71 AND substr(contract_digest, 1, 7) = 'sha256:'
        ),
        sequence INTEGER NOT NULL CHECK (sequence BETWEEN 1 AND 5),
        event_digest TEXT NOT NULL UNIQUE CHECK (
          length(event_digest) = 71 AND substr(event_digest, 1, 7) = 'sha256:'
        ),
        previous_event_digest TEXT CHECK (
          previous_event_digest IS NULL OR
          (length(previous_event_digest) = 71 AND substr(previous_event_digest, 1, 7) = 'sha256:')
        ),
        kind TEXT NOT NULL CHECK (kind IN (
          'registered', 'dispatch-started', 'remote-observed', 'evidence-recorded', 'task-recorded'
        )),
        from_state TEXT CHECK (
          from_state IS NULL OR from_state IN (
            'ready', 'dispatch-active', 'remote-open', 'evidence-recorded', 'completed'
          )
        ),
        to_state TEXT NOT NULL CHECK (to_state IN (
          'ready', 'dispatch-active', 'remote-open', 'evidence-recorded', 'completed'
        )),
        record_digest TEXT CHECK (
          record_digest IS NULL OR
          (length(record_digest) = 71 AND substr(record_digest, 1, 7) = 'sha256:')
        ),
        pull_request_number INTEGER CHECK (
          pull_request_number IS NULL OR pull_request_number >= 1
        ),
        head_revision TEXT CHECK (
          head_revision IS NULL OR length(head_revision) IN (40, 64)
        ),
        remote_created INTEGER CHECK (remote_created IS NULL OR remote_created IN (0, 1)),
        evidence_bundle_digest TEXT REFERENCES factory_evidence_bundles(bundle_digest),
        task_event_digest TEXT REFERENCES factory_task_events(event_digest),
        occurred_at TEXT NOT NULL,
        reason_code TEXT NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 128),
        correlation_id TEXT NOT NULL CHECK (length(correlation_id) = 36),
        event_json TEXT NOT NULL CHECK (
          length(event_json) BETWEEN 2 AND 2097152 AND json_valid(event_json)
        ),
        UNIQUE(dispatch_id, sequence)
      ) STRICT;
      CREATE INDEX factory_pull_request_dispatch_events_dispatch_idx
        ON factory_pull_request_dispatch_events(dispatch_id, sequence);
      CREATE INDEX factory_pull_request_dispatch_events_task_idx
        ON factory_pull_request_dispatch_events(task_id, sequence);

      CREATE TRIGGER factory_pull_request_dispatches_no_update
      BEFORE UPDATE ON factory_pull_request_dispatches
      BEGIN
        SELECT RAISE(ABORT, 'factory pull-request dispatches are immutable');
      END;
      CREATE TRIGGER factory_pull_request_dispatches_no_delete
      BEFORE DELETE ON factory_pull_request_dispatches
      BEGIN
        SELECT RAISE(ABORT, 'factory pull-request dispatches are immutable');
      END;
      CREATE TRIGGER factory_pull_request_dispatches_contract_guard
      BEFORE INSERT ON factory_pull_request_dispatches
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
        json_extract(NEW.dispatch_json, '$.taskId') IS NOT NEW.task_id OR
        json_extract(NEW.dispatch_json, '$.contractDigest') IS NOT NEW.contract_digest OR
        json_extract(NEW.dispatch_json, '$.proposalDigest') IS NOT NEW.proposal_digest OR
        json_extract(NEW.dispatch_json, '$.brokerId') IS NOT NEW.broker_id OR
        json_extract(NEW.dispatch_json, '$.proposal.repositoryId') IS NOT NEW.repository_id OR
        json_extract(NEW.dispatch_json, '$.proposal.baseRevision') IS NOT NEW.base_revision OR
        json_extract(NEW.dispatch_json, '$.proposal.branchName') IS NOT NEW.branch_name OR
        json_extract(NEW.dispatch_json, '$.proposal.createdAt') IS NOT NEW.created_at
      BEGIN
        SELECT RAISE(ABORT, 'factory pull-request dispatch contract mismatch');
      END;

      CREATE TRIGGER factory_pull_request_dispatch_events_no_update
      BEFORE UPDATE ON factory_pull_request_dispatch_events
      BEGIN
        SELECT RAISE(ABORT, 'factory pull-request dispatch events are append-only');
      END;
      CREATE TRIGGER factory_pull_request_dispatch_events_no_delete
      BEFORE DELETE ON factory_pull_request_dispatch_events
      BEGIN
        SELECT RAISE(ABORT, 'factory pull-request dispatch events are append-only');
      END;
      CREATE TRIGGER factory_pull_request_dispatch_events_identity_guard
      BEFORE INSERT ON factory_pull_request_dispatch_events
      WHEN
        NEW.dispatch_digest != (
          SELECT dispatch_digest FROM factory_pull_request_dispatches
          WHERE dispatch_id = NEW.dispatch_id
        ) OR
        NEW.task_id != (
          SELECT task_id FROM factory_pull_request_dispatches WHERE dispatch_id = NEW.dispatch_id
        ) OR
        NEW.contract_digest != (
          SELECT contract_digest FROM factory_pull_request_dispatches
          WHERE dispatch_id = NEW.dispatch_id
        ) OR
        NEW.correlation_id != (
          SELECT correlation_id FROM factory_pull_request_dispatches
          WHERE dispatch_id = NEW.dispatch_id
        )
      BEGIN
        SELECT RAISE(ABORT, 'factory pull-request dispatch event identity mismatch');
      END;
      CREATE TRIGGER factory_pull_request_dispatch_events_sequence_guard
      BEFORE INSERT ON factory_pull_request_dispatch_events
      WHEN NEW.sequence != COALESCE((
        SELECT MAX(sequence) + 1 FROM factory_pull_request_dispatch_events
        WHERE dispatch_id = NEW.dispatch_id
      ), 1)
      BEGIN
        SELECT RAISE(ABORT, 'factory pull-request dispatch event sequence mismatch');
      END;
      CREATE TRIGGER factory_pull_request_dispatch_events_chain_guard
      BEFORE INSERT ON factory_pull_request_dispatch_events
      WHEN
        (NEW.sequence = 1 AND NEW.previous_event_digest IS NOT NULL) OR
        (NEW.sequence > 1 AND NEW.previous_event_digest IS NOT (
          SELECT event_digest FROM factory_pull_request_dispatch_events
          WHERE dispatch_id = NEW.dispatch_id ORDER BY sequence DESC LIMIT 1
        ))
      BEGIN
        SELECT RAISE(ABORT, 'factory pull-request dispatch digest chain mismatch');
      END;
      CREATE TRIGGER factory_pull_request_dispatch_events_from_guard
      BEFORE INSERT ON factory_pull_request_dispatch_events
      WHEN
        (NEW.sequence = 1 AND NEW.from_state IS NOT NULL) OR
        (NEW.sequence > 1 AND NEW.from_state IS NOT (
          SELECT to_state FROM factory_pull_request_dispatch_events
          WHERE dispatch_id = NEW.dispatch_id ORDER BY sequence DESC LIMIT 1
        ))
      BEGIN
        SELECT RAISE(ABORT, 'factory pull-request dispatch previous state mismatch');
      END;
      CREATE TRIGGER factory_pull_request_dispatch_events_transition_guard
      BEFORE INSERT ON factory_pull_request_dispatch_events
      WHEN NOT (
        (NEW.kind = 'registered' AND NEW.from_state IS NULL AND NEW.to_state = 'ready') OR
        (NEW.kind = 'dispatch-started' AND
          NEW.from_state = 'ready' AND NEW.to_state = 'dispatch-active') OR
        (NEW.kind = 'remote-observed' AND
          NEW.from_state = 'dispatch-active' AND NEW.to_state = 'remote-open') OR
        (NEW.kind = 'evidence-recorded' AND
          NEW.from_state = 'remote-open' AND NEW.to_state = 'evidence-recorded') OR
        (NEW.kind = 'task-recorded' AND
          NEW.from_state = 'evidence-recorded' AND NEW.to_state = 'completed')
      )
      BEGIN
        SELECT RAISE(ABORT, 'illegal factory pull-request dispatch transition');
      END;
      CREATE TRIGGER factory_pull_request_dispatch_events_fields_guard
      BEFORE INSERT ON factory_pull_request_dispatch_events
      WHEN NOT (
        (NEW.kind IN ('registered', 'dispatch-started') AND
          NEW.record_digest IS NULL AND NEW.pull_request_number IS NULL AND
          NEW.head_revision IS NULL AND NEW.remote_created IS NULL AND
          NEW.evidence_bundle_digest IS NULL AND NEW.task_event_digest IS NULL) OR
        (NEW.kind = 'remote-observed' AND
          NEW.record_digest IS NOT NULL AND NEW.pull_request_number IS NOT NULL AND
          NEW.head_revision IS NOT NULL AND NEW.remote_created IS NOT NULL AND
          NEW.evidence_bundle_digest IS NULL AND NEW.task_event_digest IS NULL) OR
        (NEW.kind = 'evidence-recorded' AND
          NEW.record_digest IS NULL AND NEW.pull_request_number IS NULL AND
          NEW.head_revision IS NULL AND NEW.remote_created IS NULL AND
          NEW.evidence_bundle_digest IS NOT NULL AND NEW.task_event_digest IS NULL) OR
        (NEW.kind = 'task-recorded' AND
          NEW.record_digest IS NULL AND NEW.pull_request_number IS NULL AND
          NEW.head_revision IS NULL AND NEW.remote_created IS NULL AND
          NEW.evidence_bundle_digest IS NULL AND NEW.task_event_digest IS NOT NULL)
      )
      BEGIN
        SELECT RAISE(ABORT, 'factory pull-request dispatch event fields mismatch');
      END;
      CREATE TRIGGER factory_pull_request_dispatch_events_remote_guard
      BEFORE INSERT ON factory_pull_request_dispatch_events
      WHEN NEW.kind = 'remote-observed' AND (
        json_extract(NEW.event_json, '$.record.taskId') IS NOT NEW.task_id OR
        json_extract(NEW.event_json, '$.record.contractDigest') IS NOT NEW.contract_digest OR
        json_extract(NEW.event_json, '$.record.proposalDigest') IS NOT (
          SELECT proposal_digest FROM factory_pull_request_dispatches
          WHERE dispatch_id = NEW.dispatch_id
        ) OR
        json_extract(NEW.event_json, '$.record.repositoryId') IS NOT (
          SELECT repository_id FROM factory_pull_request_dispatches
          WHERE dispatch_id = NEW.dispatch_id
        ) OR
        json_extract(NEW.event_json, '$.record.baseRevision') IS NOT (
          SELECT base_revision FROM factory_pull_request_dispatches
          WHERE dispatch_id = NEW.dispatch_id
        ) OR
        json_extract(NEW.event_json, '$.record.branchName') IS NOT (
          SELECT branch_name FROM factory_pull_request_dispatches
          WHERE dispatch_id = NEW.dispatch_id
        ) OR
        json_extract(NEW.event_json, '$.record.brokerId') IS NOT (
          SELECT broker_id FROM factory_pull_request_dispatches
          WHERE dispatch_id = NEW.dispatch_id
        ) OR
        json_extract(NEW.event_json, '$.record.number') IS NOT NEW.pull_request_number OR
        json_extract(NEW.event_json, '$.record.headRevision') IS NOT NEW.head_revision
      )
      BEGIN
        SELECT RAISE(ABORT, 'factory pull-request remote record mismatch');
      END;
      CREATE TRIGGER factory_pull_request_dispatch_events_evidence_guard
      BEFORE INSERT ON factory_pull_request_dispatch_events
      WHEN NEW.kind = 'evidence-recorded' AND (
        NEW.task_id IS NOT (
          SELECT task_id FROM factory_evidence_bundles
          WHERE bundle_digest = NEW.evidence_bundle_digest
        ) OR
        NEW.contract_digest IS NOT (
          SELECT contract_digest FROM factory_evidence_bundles
          WHERE bundle_digest = NEW.evidence_bundle_digest
        )
      )
      BEGIN
        SELECT RAISE(ABORT, 'factory pull-request evidence identity mismatch');
      END;
      CREATE TRIGGER factory_pull_request_dispatch_events_task_guard
      BEFORE INSERT ON factory_pull_request_dispatch_events
      WHEN NEW.kind = 'task-recorded' AND (
        NEW.task_id IS NOT (
          SELECT task_id FROM factory_task_events WHERE event_digest = NEW.task_event_digest
        ) OR
        (SELECT to_state FROM factory_task_events WHERE event_digest = NEW.task_event_digest) != 'pr-open' OR
        json_extract((
          SELECT event_json FROM factory_task_events WHERE event_digest = NEW.task_event_digest
        ), '$.evidenceBundleDigest') IS NOT (
          SELECT evidence_bundle_digest FROM factory_pull_request_dispatch_events
          WHERE dispatch_id = NEW.dispatch_id ORDER BY sequence DESC LIMIT 1
        )
      )
      BEGIN
        SELECT RAISE(ABORT, 'factory pull-request task event mismatch');
      END;
      CREATE TRIGGER factory_pull_request_dispatch_events_timestamp_guard
      BEFORE INSERT ON factory_pull_request_dispatch_events
      WHEN
        (NEW.sequence = 1 AND NEW.occurred_at != (
          SELECT created_at FROM factory_pull_request_dispatches
          WHERE dispatch_id = NEW.dispatch_id
        )) OR
        (NEW.sequence > 1 AND NEW.occurred_at < (
          SELECT occurred_at FROM factory_pull_request_dispatch_events
          WHERE dispatch_id = NEW.dispatch_id ORDER BY sequence DESC LIMIT 1
        ))
      BEGIN
        SELECT RAISE(ABORT, 'factory pull-request dispatch timestamp mismatch');
      END;

      PRAGMA user_version = 8;
      COMMIT;
    `);
  }

  if (version < 9) {
    database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE factory_pull_request_repair_runs (
        run_id TEXT PRIMARY KEY CHECK (length(run_id) = 36),
        run_digest TEXT NOT NULL UNIQUE CHECK (
          length(run_digest) = 71 AND substr(run_digest, 1, 7) = 'sha256:'
        ),
        task_id TEXT NOT NULL REFERENCES factory_task_contracts(task_id),
        contract_digest TEXT NOT NULL CHECK (
          length(contract_digest) = 71 AND substr(contract_digest, 1, 7) = 'sha256:'
        ),
        policy_bundle_digest TEXT NOT NULL CHECK (
          length(policy_bundle_digest) = 71 AND substr(policy_bundle_digest, 1, 7) = 'sha256:'
        ),
        authorization_id TEXT NOT NULL UNIQUE CHECK (length(authorization_id) = 36),
        authorization_digest TEXT NOT NULL UNIQUE CHECK (
          length(authorization_digest) = 71 AND substr(authorization_digest, 1, 7) = 'sha256:'
        ),
        observation_digest TEXT NOT NULL CHECK (
          length(observation_digest) = 71 AND substr(observation_digest, 1, 7) = 'sha256:'
        ),
        prior_patch_proposal_digest TEXT NOT NULL CHECK (
          length(prior_patch_proposal_digest) = 71 AND
          substr(prior_patch_proposal_digest, 1, 7) = 'sha256:'
        ),
        repository_id TEXT NOT NULL CHECK (length(repository_id) BETWEEN 1 AND 128),
        base_revision TEXT NOT NULL CHECK (length(base_revision) IN (40, 64)),
        contract_repair_attempt INTEGER NOT NULL CHECK (contract_repair_attempt BETWEEN 1 AND 20),
        maximum_attempts INTEGER NOT NULL CHECK (maximum_attempts BETWEEN 1 AND 20),
        created_at TEXT NOT NULL,
        correlation_id TEXT NOT NULL CHECK (length(correlation_id) = 36),
        run_json TEXT NOT NULL CHECK (
          length(run_json) BETWEEN 2 AND 1048576 AND json_valid(run_json)
        ),
        UNIQUE(task_id, contract_repair_attempt)
      ) STRICT;
      CREATE INDEX factory_pull_request_repair_runs_recoverable_idx
        ON factory_pull_request_repair_runs(created_at, task_id, contract_repair_attempt);

      CREATE TABLE factory_pull_request_repair_events (
        event_id TEXT PRIMARY KEY CHECK (length(event_id) = 36),
        run_id TEXT NOT NULL REFERENCES factory_pull_request_repair_runs(run_id),
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
      CREATE INDEX factory_pull_request_repair_events_run_idx
        ON factory_pull_request_repair_events(run_id, sequence);
      CREATE INDEX factory_pull_request_repair_events_task_idx
        ON factory_pull_request_repair_events(task_id, sequence);
      CREATE INDEX factory_pull_request_repair_events_operation_idx
        ON factory_pull_request_repair_events(operation_id)
        WHERE operation_id IS NOT NULL;
      CREATE UNIQUE INDEX factory_pull_request_repair_events_workspace_start_idx
        ON factory_pull_request_repair_events(workspace_id)
        WHERE kind = 'attempt-started';
      CREATE UNIQUE INDEX factory_pull_request_repair_events_operation_start_idx
        ON factory_pull_request_repair_events(operation_id)
        WHERE kind = 'operation-started';

      CREATE TRIGGER factory_pull_request_repair_runs_no_update
      BEFORE UPDATE ON factory_pull_request_repair_runs
      BEGIN
        SELECT RAISE(ABORT, 'factory PR repair runs are immutable');
      END;
      CREATE TRIGGER factory_pull_request_repair_runs_no_delete
      BEFORE DELETE ON factory_pull_request_repair_runs
      BEGIN
        SELECT RAISE(ABORT, 'factory PR repair runs are immutable');
      END;
      CREATE TRIGGER factory_pull_request_repair_runs_contract_guard
      BEFORE INSERT ON factory_pull_request_repair_runs
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
        NEW.policy_bundle_digest != json_extract((
          SELECT contract_json FROM factory_task_contracts WHERE task_id = NEW.task_id
        ), '$.gateProfile.policyDigest') OR
        NEW.created_at < (
          SELECT created_at FROM factory_task_contracts WHERE task_id = NEW.task_id
        ) OR
        NEW.created_at >= (
          SELECT expires_at FROM factory_task_contracts WHERE task_id = NEW.task_id
        ) OR
        NEW.maximum_attempts != NEW.contract_repair_attempt OR
        NEW.contract_repair_attempt > CAST(json_extract((
          SELECT contract_json FROM factory_task_contracts WHERE task_id = NEW.task_id
        ), '$.budget.maxRepairAttempts') AS INTEGER) OR
        json_extract(NEW.run_json, '$.runId') IS NOT NEW.run_id OR
        json_extract(NEW.run_json, '$.taskId') IS NOT NEW.task_id OR
        json_extract(NEW.run_json, '$.contractDigest') IS NOT NEW.contract_digest OR
        json_extract(NEW.run_json, '$.policyBundleDigest') IS NOT NEW.policy_bundle_digest OR
        json_extract(NEW.run_json, '$.authorizationId') IS NOT NEW.authorization_id OR
        json_extract(NEW.run_json, '$.authorizationDigest') IS NOT NEW.authorization_digest OR
        json_extract(NEW.run_json, '$.observationDigest') IS NOT NEW.observation_digest OR
        json_extract(NEW.run_json, '$.priorPatchProposalDigest') IS NOT NEW.prior_patch_proposal_digest OR
        json_extract(NEW.run_json, '$.repository.id') IS NOT NEW.repository_id OR
        json_extract(NEW.run_json, '$.repository.baseRevision') IS NOT NEW.base_revision OR
        json_extract(NEW.run_json, '$.contractRepairAttempt') IS NOT NEW.contract_repair_attempt OR
        json_extract(NEW.run_json, '$.maximumAttempts') IS NOT NEW.maximum_attempts OR
        json_extract(NEW.run_json, '$.createdAt') IS NOT NEW.created_at OR
        json_extract(NEW.run_json, '$.correlationId') IS NOT NEW.correlation_id
      BEGIN
        SELECT RAISE(ABORT, 'factory PR repair run contract mismatch');
      END;

      CREATE TRIGGER factory_pull_request_repair_events_no_update
      BEFORE UPDATE ON factory_pull_request_repair_events
      BEGIN
        SELECT RAISE(ABORT, 'factory PR repair events are append-only');
      END;
      CREATE TRIGGER factory_pull_request_repair_events_no_delete
      BEFORE DELETE ON factory_pull_request_repair_events
      BEGIN
        SELECT RAISE(ABORT, 'factory PR repair events are append-only');
      END;
      CREATE TRIGGER factory_pull_request_repair_events_identity_guard
      BEFORE INSERT ON factory_pull_request_repair_events
      WHEN
        NEW.run_digest != (
          SELECT run_digest FROM factory_pull_request_repair_runs WHERE run_id = NEW.run_id
        ) OR
        NEW.task_id != (
          SELECT task_id FROM factory_pull_request_repair_runs WHERE run_id = NEW.run_id
        ) OR
        NEW.contract_digest != (
          SELECT contract_digest FROM factory_pull_request_repair_runs WHERE run_id = NEW.run_id
        ) OR
        NEW.correlation_id != (
          SELECT correlation_id FROM factory_pull_request_repair_runs WHERE run_id = NEW.run_id
        )
      BEGIN
        SELECT RAISE(ABORT, 'factory PR repair event identity mismatch');
      END;
      CREATE TRIGGER factory_pull_request_repair_events_sequence_guard
      BEFORE INSERT ON factory_pull_request_repair_events
      WHEN NEW.sequence != COALESCE((
        SELECT MAX(sequence) + 1 FROM factory_pull_request_repair_events WHERE run_id = NEW.run_id
      ), 1)
      BEGIN
        SELECT RAISE(ABORT, 'factory PR repair event sequence mismatch');
      END;
      CREATE TRIGGER factory_pull_request_repair_events_chain_guard
      BEFORE INSERT ON factory_pull_request_repair_events
      WHEN
        (NEW.sequence = 1 AND NEW.previous_event_digest IS NOT NULL) OR
        (NEW.sequence > 1 AND NEW.previous_event_digest IS NOT (
          SELECT event_digest FROM factory_pull_request_repair_events
          WHERE run_id = NEW.run_id ORDER BY sequence DESC LIMIT 1
        ))
      BEGIN
        SELECT RAISE(ABORT, 'factory PR repair event digest chain mismatch');
      END;
      CREATE TRIGGER factory_pull_request_repair_events_from_guard
      BEFORE INSERT ON factory_pull_request_repair_events
      WHEN
        (NEW.sequence = 1 AND NEW.from_state IS NOT NULL) OR
        (NEW.sequence > 1 AND NEW.from_state IS NOT (
          SELECT to_state FROM factory_pull_request_repair_events
          WHERE run_id = NEW.run_id ORDER BY sequence DESC LIMIT 1
        ))
      BEGIN
        SELECT RAISE(ABORT, 'factory PR repair previous state mismatch');
      END;
      CREATE TRIGGER factory_pull_request_repair_events_transition_guard
      BEFORE INSERT ON factory_pull_request_repair_events
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
        SELECT RAISE(ABORT, 'illegal factory PR repair transition');
      END;
      CREATE TRIGGER factory_pull_request_repair_events_fields_guard
      BEFORE INSERT ON factory_pull_request_repair_events
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
        SELECT RAISE(ABORT, 'factory PR repair event fields mismatch');
      END;
      CREATE TRIGGER factory_pull_request_repair_events_attempt_guard
      BEFORE INSERT ON factory_pull_request_repair_events
      WHEN
        (NEW.attempt IS NOT NULL AND NEW.attempt != (
          SELECT contract_repair_attempt FROM factory_pull_request_repair_runs
          WHERE run_id = NEW.run_id
        )) OR
        (NEW.kind = 'attempt-started' AND 0 != (
          SELECT COUNT(*) FROM factory_pull_request_repair_events
          WHERE run_id = NEW.run_id AND kind = 'attempt-started'
        ))
      BEGIN
        SELECT RAISE(ABORT, 'factory PR repair attempt mismatch');
      END;
      CREATE TRIGGER factory_pull_request_repair_events_coordinates_guard
      BEFORE INSERT ON factory_pull_request_repair_events
      WHEN
        (NEW.kind IN ('operation-started', 'operation-finished', 'attempt-closed') AND (
          NEW.attempt IS NOT (
            SELECT attempt FROM factory_pull_request_repair_events
            WHERE run_id = NEW.run_id ORDER BY sequence DESC LIMIT 1
          ) OR
          NEW.workspace_id IS NOT (
            SELECT workspace_id FROM factory_pull_request_repair_events
            WHERE run_id = NEW.run_id ORDER BY sequence DESC LIMIT 1
          )
        )) OR
        (NEW.kind = 'operation-finished' AND (
          NEW.operation_id IS NOT (
            SELECT operation_id FROM factory_pull_request_repair_events
            WHERE run_id = NEW.run_id ORDER BY sequence DESC LIMIT 1
          ) OR
          NEW.operation_kind IS NOT (
            SELECT operation_kind FROM factory_pull_request_repair_events
            WHERE run_id = NEW.run_id ORDER BY sequence DESC LIMIT 1
          ) OR
          NEW.execution_role IS NOT (
            SELECT execution_role FROM factory_pull_request_repair_events
            WHERE run_id = NEW.run_id ORDER BY sequence DESC LIMIT 1
          ) OR
          NEW.gate_id IS NOT (
            SELECT gate_id FROM factory_pull_request_repair_events
            WHERE run_id = NEW.run_id ORDER BY sequence DESC LIMIT 1
          ) OR
          NEW.request_digest IS NOT (
            SELECT request_digest FROM factory_pull_request_repair_events
            WHERE run_id = NEW.run_id ORDER BY sequence DESC LIMIT 1
          )
        )) OR
        (NEW.kind = 'execution-abandoned' AND NEW.from_state != 'ready' AND (
          NEW.attempt IS NOT (
            SELECT attempt FROM factory_pull_request_repair_events
            WHERE run_id = NEW.run_id ORDER BY sequence DESC LIMIT 1
          ) OR
          NEW.workspace_id IS NOT (
            SELECT workspace_id FROM factory_pull_request_repair_events
            WHERE run_id = NEW.run_id ORDER BY sequence DESC LIMIT 1
          ) OR
          NEW.operation_id IS NOT (
            SELECT operation_id FROM factory_pull_request_repair_events
            WHERE run_id = NEW.run_id ORDER BY sequence DESC LIMIT 1
          )
        ))
      BEGIN
        SELECT RAISE(ABORT, 'factory PR repair resource coordinates mismatch');
      END;
      CREATE TRIGGER factory_pull_request_repair_events_timestamp_guard
      BEFORE INSERT ON factory_pull_request_repair_events
      WHEN
        (NEW.sequence = 1 AND NEW.occurred_at != (
          SELECT created_at FROM factory_pull_request_repair_runs WHERE run_id = NEW.run_id
        )) OR
        (NEW.sequence > 1 AND NEW.occurred_at < (
          SELECT occurred_at FROM factory_pull_request_repair_events
          WHERE run_id = NEW.run_id ORDER BY sequence DESC LIMIT 1
        ))
      BEGIN
        SELECT RAISE(ABORT, 'factory PR repair timestamp mismatch');
      END;

      PRAGMA user_version = 9;
      COMMIT;
    `);
  }

  if (version < 10) {
    database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE factory_pull_request_updates (
        update_id TEXT PRIMARY KEY CHECK (length(update_id) = 36),
        update_digest TEXT NOT NULL UNIQUE CHECK (
          length(update_digest) = 71 AND substr(update_digest, 1, 7) = 'sha256:'
        ),
        task_id TEXT NOT NULL REFERENCES factory_task_contracts(task_id),
        contract_digest TEXT NOT NULL CHECK (
          length(contract_digest) = 71 AND substr(contract_digest, 1, 7) = 'sha256:'
        ),
        proposal_digest TEXT NOT NULL UNIQUE CHECK (
          length(proposal_digest) = 71 AND substr(proposal_digest, 1, 7) = 'sha256:'
        ),
        repair_authorization_digest TEXT NOT NULL UNIQUE CHECK (
          length(repair_authorization_digest) = 71 AND
          substr(repair_authorization_digest, 1, 7) = 'sha256:'
        ),
        repair_run_digest TEXT NOT NULL UNIQUE CHECK (
          length(repair_run_digest) = 71 AND substr(repair_run_digest, 1, 7) = 'sha256:'
        ),
        repaired_patch_proposal_digest TEXT NOT NULL UNIQUE CHECK (
          length(repaired_patch_proposal_digest) = 71 AND
          substr(repaired_patch_proposal_digest, 1, 7) = 'sha256:'
        ),
        prior_record_digest TEXT NOT NULL CHECK (
          length(prior_record_digest) = 71 AND substr(prior_record_digest, 1, 7) = 'sha256:'
        ),
        broker_id TEXT NOT NULL CHECK (length(broker_id) BETWEEN 1 AND 128),
        repository_id TEXT NOT NULL CHECK (length(repository_id) BETWEEN 1 AND 128),
        base_revision TEXT NOT NULL CHECK (length(base_revision) IN (40, 64)),
        branch_name TEXT NOT NULL CHECK (length(branch_name) BETWEEN 1 AND 128),
        pull_request_number INTEGER NOT NULL CHECK (pull_request_number >= 1),
        prior_head_revision TEXT NOT NULL CHECK (length(prior_head_revision) IN (40, 64)),
        contract_repair_attempt INTEGER NOT NULL CHECK (contract_repair_attempt BETWEEN 1 AND 20),
        created_at TEXT NOT NULL,
        correlation_id TEXT NOT NULL CHECK (length(correlation_id) = 36),
        update_json TEXT NOT NULL CHECK (
          length(update_json) BETWEEN 2 AND 2097152 AND json_valid(update_json)
        ),
        UNIQUE(task_id, contract_repair_attempt)
      ) STRICT;
      CREATE INDEX factory_pull_request_updates_recoverable_idx
        ON factory_pull_request_updates(created_at, task_id, contract_repair_attempt);

      CREATE TABLE factory_pull_request_update_events (
        event_id TEXT PRIMARY KEY CHECK (length(event_id) = 36),
        update_id TEXT NOT NULL REFERENCES factory_pull_request_updates(update_id),
        update_digest TEXT NOT NULL CHECK (
          length(update_digest) = 71 AND substr(update_digest, 1, 7) = 'sha256:'
        ),
        task_id TEXT NOT NULL,
        contract_digest TEXT NOT NULL CHECK (
          length(contract_digest) = 71 AND substr(contract_digest, 1, 7) = 'sha256:'
        ),
        sequence INTEGER NOT NULL CHECK (sequence BETWEEN 1 AND 5),
        event_digest TEXT NOT NULL UNIQUE CHECK (
          length(event_digest) = 71 AND substr(event_digest, 1, 7) = 'sha256:'
        ),
        previous_event_digest TEXT CHECK (
          previous_event_digest IS NULL OR
          (length(previous_event_digest) = 71 AND substr(previous_event_digest, 1, 7) = 'sha256:')
        ),
        kind TEXT NOT NULL CHECK (kind IN (
          'registered', 'update-started', 'remote-updated', 'evidence-recorded', 'task-recorded'
        )),
        from_state TEXT CHECK (
          from_state IS NULL OR from_state IN (
            'ready', 'update-active', 'remote-updated', 'evidence-recorded', 'completed'
          )
        ),
        to_state TEXT NOT NULL CHECK (to_state IN (
          'ready', 'update-active', 'remote-updated', 'evidence-recorded', 'completed'
        )),
        record_digest TEXT CHECK (
          record_digest IS NULL OR
          (length(record_digest) = 71 AND substr(record_digest, 1, 7) = 'sha256:')
        ),
        head_revision TEXT CHECK (
          head_revision IS NULL OR length(head_revision) IN (40, 64)
        ),
        remote_updated INTEGER CHECK (remote_updated IS NULL OR remote_updated IN (0, 1)),
        evidence_bundle_digest TEXT REFERENCES factory_evidence_bundles(bundle_digest),
        task_event_digest TEXT REFERENCES factory_task_events(event_digest),
        occurred_at TEXT NOT NULL,
        reason_code TEXT NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 128),
        correlation_id TEXT NOT NULL CHECK (length(correlation_id) = 36),
        event_json TEXT NOT NULL CHECK (
          length(event_json) BETWEEN 2 AND 2097152 AND json_valid(event_json)
        ),
        UNIQUE(update_id, sequence)
      ) STRICT;
      CREATE INDEX factory_pull_request_update_events_update_idx
        ON factory_pull_request_update_events(update_id, sequence);
      CREATE INDEX factory_pull_request_update_events_task_idx
        ON factory_pull_request_update_events(task_id, sequence);

      CREATE TRIGGER factory_pull_request_updates_no_update
      BEFORE UPDATE ON factory_pull_request_updates
      BEGIN
        SELECT RAISE(ABORT, 'factory pull-request updates are immutable');
      END;
      CREATE TRIGGER factory_pull_request_updates_no_delete
      BEFORE DELETE ON factory_pull_request_updates
      BEGIN
        SELECT RAISE(ABORT, 'factory pull-request updates are immutable');
      END;
      CREATE TRIGGER factory_pull_request_updates_contract_guard
      BEFORE INSERT ON factory_pull_request_updates
      WHEN
        NEW.contract_digest IS NOT (
          SELECT contract_digest FROM factory_task_contracts WHERE task_id = NEW.task_id
        ) OR
        NEW.repository_id IS NOT (
          SELECT repository_id FROM factory_task_contracts WHERE task_id = NEW.task_id
        ) OR
        NEW.base_revision IS NOT (
          SELECT base_revision FROM factory_task_contracts WHERE task_id = NEW.task_id
        ) OR
        NEW.repair_run_digest IS NOT (
          SELECT run_digest FROM factory_pull_request_repair_runs
          WHERE authorization_digest = NEW.repair_authorization_digest
        ) OR
        NEW.contract_repair_attempt IS NOT (
          SELECT contract_repair_attempt FROM factory_pull_request_repair_runs
          WHERE authorization_digest = NEW.repair_authorization_digest
        ) OR
        json_extract(NEW.update_json, '$.taskId') IS NOT NEW.task_id OR
        json_extract(NEW.update_json, '$.contractDigest') IS NOT NEW.contract_digest OR
        json_extract(NEW.update_json, '$.proposalDigest') IS NOT NEW.proposal_digest OR
        json_extract(NEW.update_json, '$.brokerId') IS NOT NEW.broker_id OR
        json_extract(NEW.update_json, '$.proposal.repositoryId') IS NOT NEW.repository_id OR
        json_extract(NEW.update_json, '$.proposal.baseRevision') IS NOT NEW.base_revision OR
        json_extract(NEW.update_json, '$.proposal.branchName') IS NOT NEW.branch_name OR
        json_extract(NEW.update_json, '$.proposal.pullRequestNumber') IS NOT NEW.pull_request_number OR
        json_extract(NEW.update_json, '$.proposal.priorHeadRevision') IS NOT NEW.prior_head_revision OR
        json_extract(NEW.update_json, '$.proposal.priorPullRequestRecordDigest') IS NOT NEW.prior_record_digest OR
        json_extract(NEW.update_json, '$.proposal.repairAuthorizationDigest') IS NOT NEW.repair_authorization_digest OR
        json_extract(NEW.update_json, '$.proposal.repairRunDigest') IS NOT NEW.repair_run_digest OR
        json_extract(NEW.update_json, '$.proposal.repairedPatchProposalDigest') IS NOT NEW.repaired_patch_proposal_digest OR
        json_extract(NEW.update_json, '$.proposal.contractRepairAttempt') IS NOT NEW.contract_repair_attempt OR
        json_extract(NEW.update_json, '$.proposal.createdAt') IS NOT NEW.created_at
      BEGIN
        SELECT RAISE(ABORT, 'factory pull-request update contract mismatch');
      END;
      CREATE TRIGGER factory_pull_request_updates_chain_guard
      BEFORE INSERT ON factory_pull_request_updates
      WHEN
        (NEW.contract_repair_attempt = 1 AND (
          NEW.prior_record_digest IS NOT (
            SELECT record_digest FROM factory_pull_request_dispatch_events
            WHERE task_id = NEW.task_id AND kind = 'remote-observed'
          ) OR
          NEW.prior_head_revision IS NOT (
            SELECT head_revision FROM factory_pull_request_dispatch_events
            WHERE task_id = NEW.task_id AND kind = 'remote-observed'
          )
        )) OR
        (NEW.contract_repair_attempt > 1 AND (
          NEW.prior_record_digest IS NOT (
            SELECT event.record_digest
            FROM factory_pull_request_updates AS prior
            JOIN factory_pull_request_update_events AS event
              ON event.update_id = prior.update_id AND event.kind = 'remote-updated'
            WHERE prior.task_id = NEW.task_id
              AND prior.contract_repair_attempt = NEW.contract_repair_attempt - 1
          ) OR
          NEW.prior_head_revision IS NOT (
            SELECT event.head_revision
            FROM factory_pull_request_updates AS prior
            JOIN factory_pull_request_update_events AS event
              ON event.update_id = prior.update_id AND event.kind = 'remote-updated'
            WHERE prior.task_id = NEW.task_id
              AND prior.contract_repair_attempt = NEW.contract_repair_attempt - 1
          ) OR
          'completed' IS NOT (
            SELECT event.to_state
            FROM factory_pull_request_updates AS prior
            JOIN factory_pull_request_update_events AS event ON event.update_id = prior.update_id
            WHERE prior.task_id = NEW.task_id
              AND prior.contract_repair_attempt = NEW.contract_repair_attempt - 1
            ORDER BY event.sequence DESC LIMIT 1
          )
        ))
      BEGIN
        SELECT RAISE(ABORT, 'factory pull-request update lineage mismatch');
      END;

      CREATE TRIGGER factory_pull_request_update_events_no_update
      BEFORE UPDATE ON factory_pull_request_update_events
      BEGIN
        SELECT RAISE(ABORT, 'factory pull-request update events are append-only');
      END;
      CREATE TRIGGER factory_pull_request_update_events_no_delete
      BEFORE DELETE ON factory_pull_request_update_events
      BEGIN
        SELECT RAISE(ABORT, 'factory pull-request update events are append-only');
      END;
      CREATE TRIGGER factory_pull_request_update_events_identity_guard
      BEFORE INSERT ON factory_pull_request_update_events
      WHEN
        NEW.update_digest IS NOT (
          SELECT update_digest FROM factory_pull_request_updates WHERE update_id = NEW.update_id
        ) OR
        NEW.task_id IS NOT (
          SELECT task_id FROM factory_pull_request_updates WHERE update_id = NEW.update_id
        ) OR
        NEW.contract_digest IS NOT (
          SELECT contract_digest FROM factory_pull_request_updates WHERE update_id = NEW.update_id
        ) OR
        NEW.correlation_id IS NOT (
          SELECT correlation_id FROM factory_pull_request_updates WHERE update_id = NEW.update_id
        )
      BEGIN
        SELECT RAISE(ABORT, 'factory pull-request update event identity mismatch');
      END;
      CREATE TRIGGER factory_pull_request_update_events_sequence_guard
      BEFORE INSERT ON factory_pull_request_update_events
      WHEN NEW.sequence != COALESCE((
        SELECT MAX(sequence) + 1 FROM factory_pull_request_update_events
        WHERE update_id = NEW.update_id
      ), 1)
      BEGIN
        SELECT RAISE(ABORT, 'factory pull-request update event sequence mismatch');
      END;
      CREATE TRIGGER factory_pull_request_update_events_chain_guard
      BEFORE INSERT ON factory_pull_request_update_events
      WHEN
        (NEW.sequence = 1 AND NEW.previous_event_digest IS NOT NULL) OR
        (NEW.sequence > 1 AND NEW.previous_event_digest IS NOT (
          SELECT event_digest FROM factory_pull_request_update_events
          WHERE update_id = NEW.update_id ORDER BY sequence DESC LIMIT 1
        )) OR
        (NEW.sequence > 1 AND NEW.from_state IS NOT (
          SELECT to_state FROM factory_pull_request_update_events
          WHERE update_id = NEW.update_id ORDER BY sequence DESC LIMIT 1
        ))
      BEGIN
        SELECT RAISE(ABORT, 'factory pull-request update event chain mismatch');
      END;
      CREATE TRIGGER factory_pull_request_update_events_transition_guard
      BEFORE INSERT ON factory_pull_request_update_events
      WHEN NOT (
        (NEW.sequence = 1 AND NEW.kind = 'registered' AND NEW.from_state IS NULL AND NEW.to_state = 'ready') OR
        (NEW.sequence = 2 AND NEW.kind = 'update-started' AND NEW.from_state = 'ready' AND NEW.to_state = 'update-active') OR
        (NEW.sequence = 3 AND NEW.kind = 'remote-updated' AND NEW.from_state = 'update-active' AND NEW.to_state = 'remote-updated') OR
        (NEW.sequence = 4 AND NEW.kind = 'evidence-recorded' AND NEW.from_state = 'remote-updated' AND NEW.to_state = 'evidence-recorded') OR
        (NEW.sequence = 5 AND NEW.kind = 'task-recorded' AND NEW.from_state = 'evidence-recorded' AND NEW.to_state = 'completed')
      )
      BEGIN
        SELECT RAISE(ABORT, 'factory pull-request update transition mismatch');
      END;
      CREATE TRIGGER factory_pull_request_update_events_fields_guard
      BEFORE INSERT ON factory_pull_request_update_events
      WHEN
        (NEW.kind = 'remote-updated') != (NEW.record_digest IS NOT NULL) OR
        (NEW.kind = 'remote-updated') != (NEW.head_revision IS NOT NULL) OR
        (NEW.kind = 'remote-updated') != (NEW.remote_updated IS NOT NULL) OR
        (NEW.kind = 'evidence-recorded') != (NEW.evidence_bundle_digest IS NOT NULL) OR
        (NEW.kind = 'task-recorded') != (NEW.task_event_digest IS NOT NULL)
      BEGIN
        SELECT RAISE(ABORT, 'factory pull-request update event fields mismatch');
      END;
      CREATE TRIGGER factory_pull_request_update_events_record_guard
      BEFORE INSERT ON factory_pull_request_update_events
      WHEN NEW.kind = 'remote-updated' AND (
        json_extract(NEW.event_json, '$.record.updateProposalDigest') IS NOT (
          SELECT proposal_digest FROM factory_pull_request_updates WHERE update_id = NEW.update_id
        ) OR
        json_extract(NEW.event_json, '$.record.priorPullRequestRecordDigest') IS NOT (
          SELECT prior_record_digest FROM factory_pull_request_updates WHERE update_id = NEW.update_id
        ) OR
        json_extract(NEW.event_json, '$.record.priorHeadRevision') IS NOT (
          SELECT prior_head_revision FROM factory_pull_request_updates WHERE update_id = NEW.update_id
        ) OR
        json_extract(NEW.event_json, '$.record.headRevision') IS NOT NEW.head_revision OR
        json_extract(NEW.event_json, '$.record.contractRepairAttempt') IS NOT (
          SELECT contract_repair_attempt FROM factory_pull_request_updates WHERE update_id = NEW.update_id
        )
      )
      BEGIN
        SELECT RAISE(ABORT, 'factory pull-request update record mismatch');
      END;
      CREATE TRIGGER factory_pull_request_update_events_timestamp_guard
      BEFORE INSERT ON factory_pull_request_update_events
      WHEN
        (NEW.sequence = 1 AND NEW.occurred_at IS NOT (
          SELECT created_at FROM factory_pull_request_updates WHERE update_id = NEW.update_id
        )) OR
        (NEW.sequence > 1 AND NEW.occurred_at < (
          SELECT occurred_at FROM factory_pull_request_update_events
          WHERE update_id = NEW.update_id ORDER BY sequence DESC LIMIT 1
        ))
      BEGIN
        SELECT RAISE(ABORT, 'factory pull-request update timestamp mismatch');
      END;

      PRAGMA user_version = 10;
      COMMIT;
    `);
  }

  if (version < 11) {
    database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE factory_schedule_runs (
        run_id TEXT PRIMARY KEY CHECK (length(run_id) = 36),
        run_digest TEXT NOT NULL UNIQUE CHECK (
          length(run_digest) = 71 AND substr(run_digest, 1, 7) = 'sha256:'
        ),
        schedule_policy_id TEXT NOT NULL CHECK (length(schedule_policy_id) BETWEEN 1 AND 128),
        schedule_policy_digest TEXT NOT NULL CHECK (
          length(schedule_policy_digest) = 71 AND substr(schedule_policy_digest, 1, 7) = 'sha256:'
        ),
        factory_policy_bundle_digest TEXT NOT NULL CHECK (
          length(factory_policy_bundle_digest) = 71 AND
          substr(factory_policy_bundle_digest, 1, 7) = 'sha256:'
        ),
        scheduled_for TEXT NOT NULL,
        deadline_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        correlation_id TEXT NOT NULL CHECK (length(correlation_id) = 36),
        run_json TEXT NOT NULL CHECK (
          length(run_json) BETWEEN 2 AND 1048576 AND json_valid(run_json)
        ),
        CHECK (scheduled_for <= created_at AND created_at <= deadline_at),
        UNIQUE(schedule_policy_id, scheduled_for)
      ) STRICT;
      CREATE INDEX factory_schedule_runs_slot_idx
        ON factory_schedule_runs(scheduled_for, schedule_policy_id);

      CREATE TABLE factory_schedule_events (
        event_id TEXT PRIMARY KEY CHECK (length(event_id) = 36),
        run_id TEXT NOT NULL REFERENCES factory_schedule_runs(run_id),
        run_digest TEXT NOT NULL CHECK (
          length(run_digest) = 71 AND substr(run_digest, 1, 7) = 'sha256:'
        ),
        sequence INTEGER NOT NULL CHECK (sequence BETWEEN 1 AND 1000),
        event_digest TEXT NOT NULL UNIQUE CHECK (
          length(event_digest) = 71 AND substr(event_digest, 1, 7) = 'sha256:'
        ),
        previous_event_digest TEXT CHECK (
          previous_event_digest IS NULL OR
          (length(previous_event_digest) = 71 AND substr(previous_event_digest, 1, 7) = 'sha256:')
        ),
        kind TEXT NOT NULL CHECK (kind IN (
          'registered', 'task-claimed', 'task-finished', 'task-skipped', 'completed'
        )),
        from_state TEXT CHECK (
          from_state IS NULL OR from_state IN ('ready', 'task-active', 'completed')
        ),
        to_state TEXT NOT NULL CHECK (to_state IN ('ready', 'task-active', 'completed')),
        task_id TEXT CHECK (task_id IS NULL OR length(task_id) = 36),
        task_correlation_id TEXT CHECK (
          task_correlation_id IS NULL OR length(task_correlation_id) = 36
        ),
        occurred_at TEXT NOT NULL,
        reason_code TEXT NOT NULL CHECK (length(reason_code) BETWEEN 1 AND 128),
        correlation_id TEXT NOT NULL CHECK (length(correlation_id) = 36),
        event_json TEXT NOT NULL CHECK (
          length(event_json) BETWEEN 2 AND 2097152 AND json_valid(event_json)
        ),
        UNIQUE(run_id, sequence)
      ) STRICT;
      CREATE INDEX factory_schedule_events_run_idx
        ON factory_schedule_events(run_id, sequence);
      CREATE UNIQUE INDEX factory_schedule_events_task_selection_idx
        ON factory_schedule_events(run_id, task_id)
        WHERE kind IN ('task-claimed', 'task-skipped');

      CREATE TRIGGER factory_schedule_runs_no_update
      BEFORE UPDATE ON factory_schedule_runs
      BEGIN
        SELECT RAISE(ABORT, 'factory schedule runs are immutable');
      END;
      CREATE TRIGGER factory_schedule_runs_no_delete
      BEFORE DELETE ON factory_schedule_runs
      BEGIN
        SELECT RAISE(ABORT, 'factory schedule runs are immutable');
      END;
      CREATE TRIGGER factory_schedule_runs_identity_guard
      BEFORE INSERT ON factory_schedule_runs
      WHEN
        json_extract(NEW.run_json, '$.runId') IS NOT NEW.run_id OR
        json_extract(NEW.run_json, '$.schedulePolicy.id') IS NOT NEW.schedule_policy_id OR
        json_extract(NEW.run_json, '$.schedulePolicyDigest') IS NOT NEW.schedule_policy_digest OR
        json_extract(NEW.run_json, '$.factoryPolicyBundleDigest') IS NOT NEW.factory_policy_bundle_digest OR
        json_extract(NEW.run_json, '$.scheduledFor') IS NOT NEW.scheduled_for OR
        json_extract(NEW.run_json, '$.deadlineAt') IS NOT NEW.deadline_at OR
        json_extract(NEW.run_json, '$.createdAt') IS NOT NEW.created_at OR
        json_extract(NEW.run_json, '$.correlationId') IS NOT NEW.correlation_id
      BEGIN
        SELECT RAISE(ABORT, 'factory schedule run identity mismatch');
      END;

      CREATE TRIGGER factory_schedule_events_no_update
      BEFORE UPDATE ON factory_schedule_events
      BEGIN
        SELECT RAISE(ABORT, 'factory schedule events are append-only');
      END;
      CREATE TRIGGER factory_schedule_events_no_delete
      BEFORE DELETE ON factory_schedule_events
      BEGIN
        SELECT RAISE(ABORT, 'factory schedule events are append-only');
      END;
      CREATE TRIGGER factory_schedule_events_identity_guard
      BEFORE INSERT ON factory_schedule_events
      WHEN
        NEW.run_digest IS NOT (
          SELECT run_digest FROM factory_schedule_runs WHERE run_id = NEW.run_id
        ) OR
        NEW.correlation_id IS NOT (
          SELECT correlation_id FROM factory_schedule_runs WHERE run_id = NEW.run_id
        ) OR
        json_extract(NEW.event_json, '$.eventId') IS NOT NEW.event_id OR
        json_extract(NEW.event_json, '$.runId') IS NOT NEW.run_id OR
        json_extract(NEW.event_json, '$.runDigest') IS NOT NEW.run_digest OR
        json_extract(NEW.event_json, '$.sequence') IS NOT NEW.sequence OR
        json_extract(NEW.event_json, '$.previousEventDigest') IS NOT NEW.previous_event_digest OR
        json_extract(NEW.event_json, '$.kind') IS NOT NEW.kind OR
        json_extract(NEW.event_json, '$.from') IS NOT NEW.from_state OR
        json_extract(NEW.event_json, '$.to') IS NOT NEW.to_state OR
        json_extract(NEW.event_json, '$.taskId') IS NOT NEW.task_id OR
        json_extract(NEW.event_json, '$.taskCorrelationId') IS NOT NEW.task_correlation_id OR
        json_extract(NEW.event_json, '$.occurredAt') IS NOT NEW.occurred_at OR
        json_extract(NEW.event_json, '$.reasonCode') IS NOT NEW.reason_code OR
        json_extract(NEW.event_json, '$.correlationId') IS NOT NEW.correlation_id
      BEGIN
        SELECT RAISE(ABORT, 'factory schedule event identity mismatch');
      END;
      CREATE TRIGGER factory_schedule_events_sequence_guard
      BEFORE INSERT ON factory_schedule_events
      WHEN NEW.sequence != COALESCE((
        SELECT MAX(sequence) + 1 FROM factory_schedule_events WHERE run_id = NEW.run_id
      ), 1)
      BEGIN
        SELECT RAISE(ABORT, 'factory schedule event sequence mismatch');
      END;
      CREATE TRIGGER factory_schedule_events_chain_guard
      BEFORE INSERT ON factory_schedule_events
      WHEN
        (NEW.sequence = 1 AND (NEW.previous_event_digest IS NOT NULL OR NEW.from_state IS NOT NULL)) OR
        (NEW.sequence > 1 AND NEW.previous_event_digest IS NOT (
          SELECT event_digest FROM factory_schedule_events
          WHERE run_id = NEW.run_id ORDER BY sequence DESC LIMIT 1
        )) OR
        (NEW.sequence > 1 AND NEW.from_state IS NOT (
          SELECT to_state FROM factory_schedule_events
          WHERE run_id = NEW.run_id ORDER BY sequence DESC LIMIT 1
        ))
      BEGIN
        SELECT RAISE(ABORT, 'factory schedule event chain mismatch');
      END;
      CREATE TRIGGER factory_schedule_events_transition_guard
      BEFORE INSERT ON factory_schedule_events
      WHEN NOT (
        (NEW.kind = 'registered' AND NEW.from_state IS NULL AND NEW.to_state = 'ready') OR
        (NEW.kind = 'task-claimed' AND NEW.from_state = 'ready' AND NEW.to_state = 'task-active') OR
        (NEW.kind = 'task-finished' AND NEW.from_state = 'task-active' AND NEW.to_state = 'ready') OR
        (NEW.kind = 'task-skipped' AND NEW.from_state = 'ready' AND NEW.to_state = 'ready') OR
        (NEW.kind = 'completed' AND NEW.from_state = 'ready' AND NEW.to_state = 'completed')
      )
      BEGIN
        SELECT RAISE(ABORT, 'illegal factory schedule transition');
      END;
      CREATE TRIGGER factory_schedule_events_fields_guard
      BEFORE INSERT ON factory_schedule_events
      WHEN NOT (
        (NEW.kind IN ('registered', 'completed') AND
          NEW.task_id IS NULL AND NEW.task_correlation_id IS NULL) OR
        (NEW.kind IN ('task-claimed', 'task-finished') AND
          NEW.task_id IS NOT NULL AND NEW.task_correlation_id IS NOT NULL) OR
        (NEW.kind = 'task-skipped' AND
          NEW.task_id IS NOT NULL AND NEW.task_correlation_id IS NULL)
      )
      BEGIN
        SELECT RAISE(ABORT, 'factory schedule event fields mismatch');
      END;
      CREATE TRIGGER factory_schedule_events_task_guard
      BEFORE INSERT ON factory_schedule_events
      WHEN NEW.kind IN ('task-claimed', 'task-skipped') AND (
        json_extract(NEW.event_json, '$.taskId') IS NOT NEW.task_id OR
        json_extract(NEW.event_json, '$.requestDigest') IS NOT (
          SELECT request_digest FROM factory_preparations WHERE task_id = NEW.task_id
        ) OR
        json_extract(NEW.event_json, '$.authorityDigest') IS NOT (
          SELECT authority_digest FROM factory_preparations WHERE task_id = NEW.task_id
        ) OR
        json_extract((
          SELECT request_json FROM factory_preparations WHERE task_id = NEW.task_id
        ), '$.trigger') IS NOT 'scheduled' OR
        json_extract((
          SELECT authority_json FROM factory_preparations WHERE task_id = NEW.task_id
        ), '$.policyBundleDigest') IS NOT (
          SELECT factory_policy_bundle_digest FROM factory_schedule_runs WHERE run_id = NEW.run_id
        )
      )
      BEGIN
        SELECT RAISE(ABORT, 'factory schedule task identity mismatch');
      END;
      CREATE TRIGGER factory_schedule_events_finish_guard
      BEFORE INSERT ON factory_schedule_events
      WHEN NEW.kind = 'task-finished' AND (
        NEW.task_id IS NOT (
          SELECT task_id FROM factory_schedule_events
          WHERE run_id = NEW.run_id ORDER BY sequence DESC LIMIT 1
        ) OR
        NEW.task_correlation_id IS NOT (
          SELECT task_correlation_id FROM factory_schedule_events
          WHERE run_id = NEW.run_id ORDER BY sequence DESC LIMIT 1
        ) OR
        (SELECT kind FROM factory_schedule_events
          WHERE run_id = NEW.run_id ORDER BY sequence DESC LIMIT 1) IS NOT 'task-claimed'
      )
      BEGIN
        SELECT RAISE(ABORT, 'factory schedule task finish mismatch');
      END;
      CREATE TRIGGER factory_schedule_events_timestamp_guard
      BEFORE INSERT ON factory_schedule_events
      WHEN
        (NEW.sequence = 1 AND NEW.occurred_at IS NOT (
          SELECT created_at FROM factory_schedule_runs WHERE run_id = NEW.run_id
        )) OR
        (NEW.sequence > 1 AND NEW.occurred_at < (
          SELECT occurred_at FROM factory_schedule_events
          WHERE run_id = NEW.run_id ORDER BY sequence DESC LIMIT 1
        ))
      BEGIN
        SELECT RAISE(ABORT, 'factory schedule event timestamp mismatch');
      END;

      PRAGMA user_version = 11;
      COMMIT;
    `);
  }

  if (version < 12) {
    database.exec(`
      BEGIN IMMEDIATE;
      CREATE TABLE factory_eval_runs (
        run_id TEXT PRIMARY KEY CHECK (length(run_id) = 36),
        run_digest TEXT NOT NULL UNIQUE CHECK (
          length(run_digest) = 71 AND substr(run_digest, 1, 7) = 'sha256:'
        ),
        suite_digest TEXT NOT NULL CHECK (
          length(suite_digest) = 71 AND substr(suite_digest, 1, 7) = 'sha256:'
        ),
        baseline_candidate_digest TEXT NOT NULL CHECK (
          length(baseline_candidate_digest) = 71 AND
          substr(baseline_candidate_digest, 1, 7) = 'sha256:'
        ),
        challenger_candidate_digest TEXT NOT NULL CHECK (
          length(challenger_candidate_digest) = 71 AND
          substr(challenger_candidate_digest, 1, 7) = 'sha256:'
        ),
        started_at TEXT NOT NULL,
        completed_at TEXT NOT NULL,
        correlation_id TEXT NOT NULL CHECK (length(correlation_id) = 36),
        run_json TEXT NOT NULL CHECK (
          length(run_json) BETWEEN 2 AND 33554432 AND json_valid(run_json)
        ),
        CHECK (started_at <= completed_at)
      ) STRICT;

      CREATE TABLE factory_eval_assessments (
        assessment_id TEXT PRIMARY KEY CHECK (length(assessment_id) = 36),
        assessment_digest TEXT NOT NULL UNIQUE CHECK (
          length(assessment_digest) = 71 AND substr(assessment_digest, 1, 7) = 'sha256:'
        ),
        run_id TEXT NOT NULL UNIQUE REFERENCES factory_eval_runs(run_id),
        run_digest TEXT NOT NULL CHECK (
          length(run_digest) = 71 AND substr(run_digest, 1, 7) = 'sha256:'
        ),
        decision TEXT NOT NULL CHECK (decision IN ('pass', 'deny')),
        assessed_at TEXT NOT NULL,
        assessment_json TEXT NOT NULL CHECK (
          length(assessment_json) BETWEEN 2 AND 1048576 AND json_valid(assessment_json)
        )
      ) STRICT;
      CREATE INDEX factory_eval_assessments_challenger_idx
        ON factory_eval_assessments(
          json_extract(assessment_json, '$.challengerCandidateDigest'), assessed_at
        );

      CREATE TABLE factory_canary_approvals (
        approval_id TEXT PRIMARY KEY CHECK (length(approval_id) = 36),
        approval_digest TEXT NOT NULL UNIQUE CHECK (
          length(approval_digest) = 71 AND substr(approval_digest, 1, 7) = 'sha256:'
        ),
        assessment_digest TEXT NOT NULL UNIQUE
          REFERENCES factory_eval_assessments(assessment_digest),
        challenger_candidate_digest TEXT NOT NULL CHECK (
          length(challenger_candidate_digest) = 71 AND
          substr(challenger_candidate_digest, 1, 7) = 'sha256:'
        ),
        stage TEXT NOT NULL CHECK (
          stage IN ('read-only-shadow', 'local-proposal', 'brokered-draft-pr')
        ),
        actor_id TEXT NOT NULL CHECK (length(actor_id) BETWEEN 1 AND 128),
        occurred_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        approval_json TEXT NOT NULL CHECK (
          length(approval_json) BETWEEN 2 AND 1048576 AND json_valid(approval_json)
        ),
        CHECK (occurred_at < expires_at)
      ) STRICT;

      CREATE TABLE factory_canary_cohorts (
        cohort_id TEXT PRIMARY KEY CHECK (length(cohort_id) = 36),
        cohort_digest TEXT NOT NULL UNIQUE CHECK (
          length(cohort_digest) = 71 AND substr(cohort_digest, 1, 7) = 'sha256:'
        ),
        assessment_digest TEXT NOT NULL UNIQUE
          REFERENCES factory_eval_assessments(assessment_digest),
        run_digest TEXT NOT NULL CHECK (
          length(run_digest) = 71 AND substr(run_digest, 1, 7) = 'sha256:'
        ),
        approval_digest TEXT NOT NULL UNIQUE
          REFERENCES factory_canary_approvals(approval_digest),
        challenger_candidate_digest TEXT NOT NULL CHECK (
          length(challenger_candidate_digest) = 71 AND
          substr(challenger_candidate_digest, 1, 7) = 'sha256:'
        ),
        stage TEXT NOT NULL CHECK (
          stage IN ('read-only-shadow', 'local-proposal', 'brokered-draft-pr')
        ),
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        cohort_json TEXT NOT NULL CHECK (
          length(cohort_json) BETWEEN 2 AND 1048576 AND json_valid(cohort_json)
        ),
        CHECK (issued_at < expires_at)
      ) STRICT;

      CREATE TRIGGER factory_eval_runs_no_update
      BEFORE UPDATE ON factory_eval_runs
      BEGIN
        SELECT RAISE(ABORT, 'factory eval runs are immutable');
      END;
      CREATE TRIGGER factory_eval_runs_no_delete
      BEFORE DELETE ON factory_eval_runs
      BEGIN
        SELECT RAISE(ABORT, 'factory eval runs are immutable');
      END;
      CREATE TRIGGER factory_eval_runs_identity_guard
      BEFORE INSERT ON factory_eval_runs
      WHEN
        json_extract(NEW.run_json, '$.runId') IS NOT NEW.run_id OR
        json_extract(NEW.run_json, '$.suiteDigest') IS NOT NEW.suite_digest OR
        json_extract(NEW.run_json, '$.baselineCandidateDigest') IS NOT NEW.baseline_candidate_digest OR
        json_extract(NEW.run_json, '$.challengerCandidateDigest') IS NOT NEW.challenger_candidate_digest OR
        json_extract(NEW.run_json, '$.startedAt') IS NOT NEW.started_at OR
        json_extract(NEW.run_json, '$.completedAt') IS NOT NEW.completed_at OR
        json_extract(NEW.run_json, '$.correlationId') IS NOT NEW.correlation_id
      BEGIN
        SELECT RAISE(ABORT, 'factory eval run identity mismatch');
      END;

      CREATE TRIGGER factory_eval_assessments_no_update
      BEFORE UPDATE ON factory_eval_assessments
      BEGIN
        SELECT RAISE(ABORT, 'factory eval assessments are immutable');
      END;
      CREATE TRIGGER factory_eval_assessments_no_delete
      BEFORE DELETE ON factory_eval_assessments
      BEGIN
        SELECT RAISE(ABORT, 'factory eval assessments are immutable');
      END;
      CREATE TRIGGER factory_eval_assessments_identity_guard
      BEFORE INSERT ON factory_eval_assessments
      WHEN
        NEW.run_digest IS NOT (
          SELECT run_digest FROM factory_eval_runs WHERE run_id = NEW.run_id
        ) OR
        json_extract(NEW.assessment_json, '$.assessmentId') IS NOT NEW.assessment_id OR
        json_extract(NEW.assessment_json, '$.runId') IS NOT NEW.run_id OR
        json_extract(NEW.assessment_json, '$.runDigest') IS NOT NEW.run_digest OR
        json_extract(NEW.assessment_json, '$.decision') IS NOT NEW.decision OR
        json_extract(NEW.assessment_json, '$.assessedAt') IS NOT NEW.assessed_at OR
        json_extract(NEW.assessment_json, '$.suiteDigest') IS NOT (
          SELECT suite_digest FROM factory_eval_runs WHERE run_id = NEW.run_id
        ) OR
        json_extract(NEW.assessment_json, '$.baselineCandidateDigest') IS NOT (
          SELECT baseline_candidate_digest FROM factory_eval_runs WHERE run_id = NEW.run_id
        ) OR
        json_extract(NEW.assessment_json, '$.challengerCandidateDigest') IS NOT (
          SELECT challenger_candidate_digest FROM factory_eval_runs WHERE run_id = NEW.run_id
        )
      BEGIN
        SELECT RAISE(ABORT, 'factory eval assessment identity mismatch');
      END;

      CREATE TRIGGER factory_canary_approvals_no_update
      BEFORE UPDATE ON factory_canary_approvals
      BEGIN
        SELECT RAISE(ABORT, 'factory canary approvals are immutable');
      END;
      CREATE TRIGGER factory_canary_approvals_no_delete
      BEFORE DELETE ON factory_canary_approvals
      BEGIN
        SELECT RAISE(ABORT, 'factory canary approvals are immutable');
      END;
      CREATE TRIGGER factory_canary_approvals_identity_guard
      BEFORE INSERT ON factory_canary_approvals
      WHEN
        (SELECT decision FROM factory_eval_assessments
          WHERE assessment_digest = NEW.assessment_digest) IS NOT 'pass' OR
        NEW.challenger_candidate_digest IS NOT (
          SELECT json_extract(assessment_json, '$.challengerCandidateDigest')
          FROM factory_eval_assessments WHERE assessment_digest = NEW.assessment_digest
        ) OR
        json_extract(NEW.approval_json, '$.approvalId') IS NOT NEW.approval_id OR
        json_extract(NEW.approval_json, '$.assessmentDigest') IS NOT NEW.assessment_digest OR
        json_extract(NEW.approval_json, '$.challengerCandidateDigest') IS NOT NEW.challenger_candidate_digest OR
        json_extract(NEW.approval_json, '$.stage') IS NOT NEW.stage OR
        json_extract(NEW.approval_json, '$.actor.id') IS NOT NEW.actor_id OR
        json_extract(NEW.approval_json, '$.actor.kind') IS NOT 'human' OR
        json_extract(NEW.approval_json, '$.actor.role') IS NOT 'release-controller' OR
        json_extract(NEW.approval_json, '$.occurredAt') IS NOT NEW.occurred_at OR
        json_extract(NEW.approval_json, '$.expiresAt') IS NOT NEW.expires_at
      BEGIN
        SELECT RAISE(ABORT, 'factory canary approval identity mismatch');
      END;

      CREATE TRIGGER factory_canary_cohorts_no_update
      BEFORE UPDATE ON factory_canary_cohorts
      BEGIN
        SELECT RAISE(ABORT, 'factory canary cohorts are immutable');
      END;
      CREATE TRIGGER factory_canary_cohorts_no_delete
      BEFORE DELETE ON factory_canary_cohorts
      BEGIN
        SELECT RAISE(ABORT, 'factory canary cohorts are immutable');
      END;
      CREATE TRIGGER factory_canary_cohorts_identity_guard
      BEFORE INSERT ON factory_canary_cohorts
      WHEN
        NEW.assessment_digest IS NOT (
          SELECT assessment_digest FROM factory_canary_approvals
          WHERE approval_digest = NEW.approval_digest
        ) OR
        NEW.run_digest IS NOT (
          SELECT run_digest FROM factory_eval_assessments
          WHERE assessment_digest = NEW.assessment_digest
        ) OR
        NEW.challenger_candidate_digest IS NOT (
          SELECT challenger_candidate_digest FROM factory_canary_approvals
          WHERE approval_digest = NEW.approval_digest
        ) OR
        NEW.stage IS NOT (
          SELECT stage FROM factory_canary_approvals
          WHERE approval_digest = NEW.approval_digest
        ) OR
        NEW.issued_at IS NOT (
          SELECT occurred_at FROM factory_canary_approvals
          WHERE approval_digest = NEW.approval_digest
        ) OR
        NEW.expires_at IS NOT (
          SELECT expires_at FROM factory_canary_approvals
          WHERE approval_digest = NEW.approval_digest
        ) OR
        json_extract(NEW.cohort_json, '$.cohortId') IS NOT NEW.cohort_id OR
        json_extract(NEW.cohort_json, '$.assessmentDigest') IS NOT NEW.assessment_digest OR
        json_extract(NEW.cohort_json, '$.runDigest') IS NOT NEW.run_digest OR
        json_extract(NEW.cohort_json, '$.approvalDigest') IS NOT NEW.approval_digest OR
        json_extract(NEW.cohort_json, '$.challengerCandidateDigest') IS NOT NEW.challenger_candidate_digest OR
        json_extract(NEW.cohort_json, '$.stage') IS NOT NEW.stage OR
        json_extract(NEW.cohort_json, '$.issuedAt') IS NOT NEW.issued_at OR
        json_extract(NEW.cohort_json, '$.expiresAt') IS NOT NEW.expires_at OR
        json_extract(NEW.cohort_json, '$.autoMerge') IS NOT 0 OR
        json_extract(NEW.cohort_json, '$.release') IS NOT 0
      BEGIN
        SELECT RAISE(ABORT, 'factory canary cohort identity mismatch');
      END;

      PRAGMA user_version = 12;
      COMMIT;
    `);
  }
}

function readUserVersion(database: DatabaseSync): number {
  const row = database.prepare("PRAGMA user_version").get() as
    { user_version?: unknown } | undefined;
  return typeof row?.user_version === "number" ? row.user_version : 0;
}
