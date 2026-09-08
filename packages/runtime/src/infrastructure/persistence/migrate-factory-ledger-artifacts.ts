import type { DatabaseSync } from "node:sqlite";

/** Quota-charged untrusted artifact reservations, separate from authoritative evidence bundles. */
export function migrateFactoryLedgerArtifacts(database: DatabaseSync): void {
  database.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE factory_ledger_artifact_reservations (
      principal_uid INTEGER NOT NULL CHECK (principal_uid BETWEEN 1 AND 4294967294),
      idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) = 36),
      task_id TEXT NOT NULL REFERENCES factory_task_contracts(task_id),
      contract_digest TEXT NOT NULL,
      artifact_digest TEXT NOT NULL CHECK (length(artifact_digest) = 71 AND substr(artifact_digest, 1, 7) = 'sha256:'),
      size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 0 AND 8388608),
      intent_digest TEXT NOT NULL UNIQUE CHECK (length(intent_digest) = 71 AND substr(intent_digest, 1, 7) = 'sha256:'),
      reservation_digest TEXT NOT NULL UNIQUE CHECK (length(reservation_digest) = 71 AND substr(reservation_digest, 1, 7) = 'sha256:'),
      reservation_json TEXT NOT NULL CHECK (length(reservation_json) BETWEEN 2 AND 16384 AND json_valid(reservation_json)),
      reserved_at TEXT NOT NULL,
      PRIMARY KEY (principal_uid, idempotency_key)
    ) STRICT;
    CREATE INDEX factory_ledger_artifact_reservations_task_idx
      ON factory_ledger_artifact_reservations(task_id, contract_digest, artifact_digest);
    CREATE TRIGGER factory_ledger_artifact_reservations_identity_guard
    BEFORE INSERT ON factory_ledger_artifact_reservations
    WHEN json_extract(NEW.reservation_json, '$.schemaVersion') IS NOT 'agentlab.ledger-artifact-reservation.v1' OR
      json_extract(NEW.reservation_json, '$.intent.schemaVersion') IS NOT 'agentlab.ledger-artifact-intent.v1' OR
      json_extract(NEW.reservation_json, '$.intent.principalUid') IS NOT NEW.principal_uid OR
      json_extract(NEW.reservation_json, '$.intent.upload.idempotencyKey') IS NOT NEW.idempotency_key OR
      json_extract(NEW.reservation_json, '$.intent.upload.taskId') IS NOT NEW.task_id OR
      json_extract(NEW.reservation_json, '$.intent.upload.contractDigest') IS NOT NEW.contract_digest OR
      json_extract(NEW.reservation_json, '$.intent.upload.artifact.digest') IS NOT NEW.artifact_digest OR
      json_extract(NEW.reservation_json, '$.intent.upload.artifact.sizeBytes') IS NOT NEW.size_bytes OR
      json_extract(NEW.reservation_json, '$.intentDigest') IS NOT NEW.intent_digest OR
      json_extract(NEW.reservation_json, '$.reservedAt') IS NOT NEW.reserved_at OR
      NEW.contract_digest IS NOT (SELECT contract_digest FROM factory_task_contracts WHERE task_id = NEW.task_id) OR
      NEW.reserved_at >= json_extract(NEW.reservation_json, '$.intent.upload.expiresAt')
    BEGIN SELECT RAISE(ABORT, 'ledger artifact reservation identity mismatch'); END;
    CREATE TRIGGER factory_ledger_artifact_reservations_no_update
    BEFORE UPDATE ON factory_ledger_artifact_reservations
    BEGIN SELECT RAISE(ABORT, 'ledger artifact reservations are immutable'); END;
    CREATE TRIGGER factory_ledger_artifact_reservations_no_delete
    BEFORE DELETE ON factory_ledger_artifact_reservations
    BEGIN SELECT RAISE(ABORT, 'ledger artifact reservations are immutable'); END;
    PRAGMA user_version = 33;
    COMMIT;
  `);
}
