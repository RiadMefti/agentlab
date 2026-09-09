import type { DatabaseSync } from "node:sqlite";

/** Append-only receipts share the control-event transaction; no authority is enabled by migration. */
export function migrateFactoryLedgerAuthority(database: DatabaseSync): void {
  database.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE factory_ledger_authority_receipts (
      principal_uid INTEGER NOT NULL CHECK (principal_uid BETWEEN 1 AND 4294967294),
      idempotency_key TEXT NOT NULL CHECK (length(idempotency_key) = 36),
      intent_digest TEXT NOT NULL CHECK (length(intent_digest) = 71 AND substr(intent_digest, 1, 7) = 'sha256:'),
      receipt_digest TEXT NOT NULL UNIQUE CHECK (length(receipt_digest) = 71 AND substr(receipt_digest, 1, 7) = 'sha256:'),
      receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json)),
      recorded_at TEXT NOT NULL,
      PRIMARY KEY (principal_uid, idempotency_key)
    ) STRICT;
    CREATE TRIGGER factory_ledger_authority_receipts_identity_guard
    BEFORE INSERT ON factory_ledger_authority_receipts
    WHEN json_extract(NEW.receipt_json, '$.schemaVersion') IS NOT 'agentlab.ledger-authority-receipt.v1' OR
      json_extract(NEW.receipt_json, '$.intent.principalUid') IS NOT NEW.principal_uid OR
      json_extract(NEW.receipt_json, '$.intent.command.idempotencyKey') IS NOT NEW.idempotency_key OR
      json_extract(NEW.receipt_json, '$.intentDigest') IS NOT NEW.intent_digest OR
      json_extract(NEW.receipt_json, '$.recordedAt') IS NOT NEW.recorded_at OR
      json_extract(NEW.receipt_json, '$.outcome') NOT IN ('applied', 'conflict') OR
      json_type(NEW.receipt_json, '$.outcome') IS NOT 'text' OR
      (json_extract(NEW.receipt_json, '$.outcome') = 'applied' AND
        json_type(NEW.receipt_json, '$.head.event') IS NOT 'object') OR
      (json_type(NEW.receipt_json, '$.head.event') = 'null' AND
        (json_type(NEW.receipt_json, '$.head.eventDigest') IS NOT 'null' OR
          json_extract(NEW.receipt_json, '$.head.enabled') IS NOT 0)) OR
      (json_type(NEW.receipt_json, '$.head.event') = 'object' AND NOT EXISTS (
        SELECT 1 FROM factory_control_events
        WHERE event_digest = json_extract(NEW.receipt_json, '$.head.eventDigest')
          AND event_json = json_extract(NEW.receipt_json, '$.head.event')
        UNION ALL
        SELECT 1 FROM factory_merge_control_events
        WHERE event_digest = json_extract(NEW.receipt_json, '$.head.eventDigest')
          AND event_json = json_extract(NEW.receipt_json, '$.head.event')
      ))
    BEGIN SELECT RAISE(ABORT, 'ledger authority receipt identity mismatch'); END;
    CREATE TRIGGER factory_ledger_authority_receipts_no_update
    BEFORE UPDATE ON factory_ledger_authority_receipts
    BEGIN SELECT RAISE(ABORT, 'ledger authority receipts are immutable'); END;
    CREATE TRIGGER factory_ledger_authority_receipts_no_delete
    BEFORE DELETE ON factory_ledger_authority_receipts
    BEGIN SELECT RAISE(ABORT, 'ledger authority receipts are immutable'); END;
    PRAGMA user_version = 32;
    COMMIT;
  `);
}
