import type { DatabaseSync } from "node:sqlite";

/** Immutable jobs, one-shot claims and result receipts; never a resettable work lease. */
export function migrateFactoryLedgerOperations(database: DatabaseSync): void {
  database.exec(`
    BEGIN IMMEDIATE;
    CREATE TABLE factory_ledger_operations (
      job_id TEXT PRIMARY KEY CHECK(length(job_id) = 36),
      task_id TEXT NOT NULL REFERENCES factory_task_contracts(task_id),
      contract_digest TEXT NOT NULL,
      principal_uid INTEGER NOT NULL CHECK(principal_uid BETWEEN 1 AND 4294967294),
      job_digest TEXT NOT NULL UNIQUE,
      job_bytes INTEGER NOT NULL CHECK(job_bytes BETWEEN 2 AND 16000000),
      job_json TEXT NOT NULL CHECK(json_valid(job_json)),
      created_at TEXT NOT NULL, expires_at TEXT NOT NULL CHECK(expires_at > created_at)
    ) STRICT;
    CREATE INDEX factory_ledger_operations_task_idx ON factory_ledger_operations(principal_uid, task_id, contract_digest, created_at, job_id);
    CREATE TABLE factory_ledger_operation_claims (
      job_id TEXT PRIMARY KEY REFERENCES factory_ledger_operations(job_id),
      principal_uid INTEGER NOT NULL,
      invocation_id TEXT NOT NULL CHECK(length(invocation_id) = 36),
      claim_digest TEXT NOT NULL UNIQUE,
      claim_json TEXT NOT NULL CHECK(length(claim_json) BETWEEN 2 AND 2048 AND json_valid(claim_json)),
      claimed_at TEXT NOT NULL,
      UNIQUE(principal_uid, invocation_id)
    ) STRICT;
    CREATE TABLE factory_ledger_operation_receipts (
      job_id TEXT PRIMARY KEY REFERENCES factory_ledger_operation_claims(job_id),
      receipt_digest TEXT NOT NULL UNIQUE,
      receipt_json TEXT NOT NULL CHECK(length(receipt_json) BETWEEN 2 AND 4096 AND json_valid(receipt_json)),
      reported_at TEXT NOT NULL
    ) STRICT;
    CREATE TRIGGER factory_ledger_operations_identity BEFORE INSERT ON factory_ledger_operations
    WHEN json_extract(NEW.job_json, '$.schemaVersion') IS NOT 'agentlab.ledger-operation.v1' OR
      json_extract(NEW.job_json, '$.jobId') IS NOT NEW.job_id OR json_extract(NEW.job_json, '$.taskId') IS NOT NEW.task_id OR
      json_extract(NEW.job_json, '$.contractDigest') IS NOT NEW.contract_digest OR
      json_extract(NEW.job_json, '$.principal.uid') IS NOT NEW.principal_uid OR
      json_extract(NEW.job_json, '$.createdAt') IS NOT NEW.created_at OR json_extract(NEW.job_json, '$.expiresAt') IS NOT NEW.expires_at OR
      length(CAST(NEW.job_json AS BLOB)) IS NOT NEW.job_bytes OR
      NEW.contract_digest IS NOT (SELECT contract_digest FROM factory_task_contracts WHERE task_id = NEW.task_id)
    BEGIN SELECT RAISE(ABORT, 'ledger operation identity mismatch'); END;
    CREATE TRIGGER factory_ledger_operation_claims_identity BEFORE INSERT ON factory_ledger_operation_claims
    WHEN json_extract(NEW.claim_json, '$.schemaVersion') IS NOT 'agentlab.ledger-operation-claim.v1' OR
      json_extract(NEW.claim_json, '$.jobId') IS NOT NEW.job_id OR json_extract(NEW.claim_json, '$.principalUid') IS NOT NEW.principal_uid OR
      json_extract(NEW.claim_json, '$.invocationId') IS NOT NEW.invocation_id OR json_extract(NEW.claim_json, '$.claimedAt') IS NOT NEW.claimed_at OR
      NEW.principal_uid IS NOT (SELECT principal_uid FROM factory_ledger_operations WHERE job_id = NEW.job_id) OR
      json_extract(NEW.claim_json, '$.jobDigest') IS NOT (SELECT job_digest FROM factory_ledger_operations WHERE job_id = NEW.job_id) OR
      NEW.claimed_at < (SELECT created_at FROM factory_ledger_operations WHERE job_id = NEW.job_id) OR
      NEW.claimed_at >= (SELECT expires_at FROM factory_ledger_operations WHERE job_id = NEW.job_id)
    BEGIN SELECT RAISE(ABORT, 'ledger operation claim identity mismatch'); END;
    CREATE TRIGGER factory_ledger_operation_receipts_identity BEFORE INSERT ON factory_ledger_operation_receipts
    WHEN json_extract(NEW.receipt_json, '$.schemaVersion') IS NOT 'agentlab.ledger-operation-receipt.v1' OR
      json_extract(NEW.receipt_json, '$.jobId') IS NOT NEW.job_id OR json_extract(NEW.receipt_json, '$.reportedAt') IS NOT NEW.reported_at OR
      json_extract(NEW.receipt_json, '$.jobDigest') IS NOT (SELECT job_digest FROM factory_ledger_operations WHERE job_id = NEW.job_id) OR
      json_extract(NEW.receipt_json, '$.claimDigest') IS NOT (SELECT claim_digest FROM factory_ledger_operation_claims WHERE job_id = NEW.job_id) OR
      json_extract(NEW.receipt_json, '$.principalUid') IS NOT (SELECT principal_uid FROM factory_ledger_operation_claims WHERE job_id = NEW.job_id) OR
      NEW.reported_at < (SELECT claimed_at FROM factory_ledger_operation_claims WHERE job_id = NEW.job_id) OR
      NEW.reported_at >= (SELECT expires_at FROM factory_ledger_operations WHERE job_id = NEW.job_id)
    BEGIN SELECT RAISE(ABORT, 'ledger operation receipt identity mismatch'); END;
    CREATE TRIGGER factory_ledger_operations_no_update BEFORE UPDATE ON factory_ledger_operations BEGIN SELECT RAISE(ABORT, 'ledger operations are immutable'); END;
    CREATE TRIGGER factory_ledger_operations_no_delete BEFORE DELETE ON factory_ledger_operations BEGIN SELECT RAISE(ABORT, 'ledger operations are immutable'); END;
    CREATE TRIGGER factory_ledger_operation_claims_no_update BEFORE UPDATE ON factory_ledger_operation_claims BEGIN SELECT RAISE(ABORT, 'ledger operation claims are immutable'); END;
    CREATE TRIGGER factory_ledger_operation_claims_no_delete BEFORE DELETE ON factory_ledger_operation_claims BEGIN SELECT RAISE(ABORT, 'ledger operation claims are immutable'); END;
    CREATE TRIGGER factory_ledger_operation_receipts_no_update BEFORE UPDATE ON factory_ledger_operation_receipts BEGIN SELECT RAISE(ABORT, 'ledger operation receipts are immutable'); END;
    CREATE TRIGGER factory_ledger_operation_receipts_no_delete BEFORE DELETE ON factory_ledger_operation_receipts BEGIN SELECT RAISE(ABORT, 'ledger operation receipts are immutable'); END;
    PRAGMA user_version = 34;
    COMMIT;
  `);
}
