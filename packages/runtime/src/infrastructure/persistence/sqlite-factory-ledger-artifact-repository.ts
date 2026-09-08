import type { DatabaseSync } from "node:sqlite";

import {
  factoryLedgerArtifactIntentSchema,
  factoryLedgerArtifactReservationSchema,
  factoryTimestampSchema,
  sha256DigestSchema,
  type FactoryArtifactReference,
  type FactoryLedgerArtifactIntent,
  type FactoryLedgerArtifactReservation,
  type Sha256Digest
} from "@agentlab/contracts";
import { z } from "zod";

import { ConflictError } from "../../domain/errors.js";
import type { CanonicalFactoryDocument } from "../../domain/factory-documents.js";
import type { FactoryLedgerArtifactRepository } from "../../domain/factory-ledger-artifacts.js";
import {
  encodeCanonicalDocument,
  NodeFactoryDocumentCodec
} from "./canonical-factory-documents.js";
import { openSqliteDatabase } from "./sqlite-database.js";
import { withImmediateFactoryTransaction } from "./sqlite-factory-execution-journal.js";

const columns =
  "principal_uid, idempotency_key, task_id, contract_digest, artifact_digest, size_bytes, intent_digest, reservation_digest, reservation_json, reserved_at";

export class SqliteFactoryLedgerArtifactRepository implements FactoryLedgerArtifactRepository {
  readonly #database: DatabaseSync;
  public constructor(path: string) {
    this.#database = openSqliteDatabase(path);
  }

  public find(
    uid: number,
    key: string
  ): Promise<CanonicalFactoryDocument<FactoryLedgerArtifactReservation> | null> {
    z.number().int().min(1).max(0xffff_fffe).parse(uid);
    z.uuid().parse(key);
    return Promise.resolve(this.#find(uid, key));
  }

  public reserve(
    claim: CanonicalFactoryDocument<FactoryLedgerArtifactIntent>,
    limits: {
      maximumTaskBytes: number;
      maximumTaskArtifacts: number;
      maximumTotalBytes: number;
      maximumTotalArtifacts: number;
    },
    now: () => string
  ): Promise<CanonicalFactoryDocument<FactoryLedgerArtifactReservation>> {
    const intent = encodeCanonicalDocument(factoryLedgerArtifactIntentSchema.parse(claim.value));
    if (intent.json !== claim.json || intent.digest !== claim.digest)
      throw new Error("Artifact intent differs from its canonical identity.");
    const quota = z
      .strictObject({
        maximumTaskBytes: z.number().int().min(1).max(67_108_864),
        maximumTaskArtifacts: z.number().int().min(1).max(256),
        maximumTotalBytes: z.number().int().min(1).max(8_589_934_592),
        maximumTotalArtifacts: z.number().int().min(1).max(65536)
      })
      .parse(limits);
    const upload = intent.value.upload;
    return Promise.resolve(
      withImmediateFactoryTransaction(this.#database, "Ledger artifact reservation", () => {
        const previous = this.#find(intent.value.principalUid, upload.idempotencyKey);
        if (previous !== null) {
          if (previous.value.intentDigest !== intent.digest)
            throw new ConflictError("Artifact idempotency key already binds a different intent.");
          return previous;
        }
        const reservedAt = factoryTimestampSchema.parse(now());
        if (reservedAt >= upload.expiresAt)
          throw new ConflictError("Artifact upload expired before reservation.");
        const task = this.#database
          .prepare(
            `SELECT event_digest FROM factory_task_events
        WHERE task_id = ? AND contract_digest = ? ORDER BY sequence DESC LIMIT 1`
          )
          .get(upload.taskId, upload.contractDigest);
        const journal =
          upload.execution.kind === "execution"
            ? "factory_execution_events"
            : "factory_pull_request_repair_events";
        const operation = this.#database
          .prepare(
            `SELECT event_digest, run_digest, operation_id, attempt, kind
        FROM ${journal} WHERE run_id = ? AND task_id = ? AND contract_digest = ? ORDER BY sequence DESC LIMIT 1`
          )
          .get(upload.execution.runId, upload.taskId, upload.contractDigest);
        if (
          task?.event_digest !== upload.expectedTaskEventDigest ||
          operation?.event_digest !== upload.execution.eventDigest ||
          operation.run_digest !== upload.execution.runDigest ||
          operation.operation_id !== upload.operationId ||
          operation.attempt !== upload.attempt ||
          operation.kind !== "operation-started"
        ) {
          throw new ConflictError("Artifact upload no longer names the active task and operation.");
        }
        const usage = this.#database
          .prepare(
            `SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS bytes
        FROM factory_ledger_artifact_reservations WHERE task_id = ?`
          )
          .get(upload.taskId);
        if (
          typeof usage?.count !== "number" ||
          typeof usage.bytes !== "number" ||
          usage.count >= quota.maximumTaskArtifacts ||
          usage.bytes + upload.artifact.sizeBytes > quota.maximumTaskBytes
        ) {
          throw new ConflictError("Task artifact reservation quota is exhausted.");
        }
        const total = this.#database
          .prepare(
            "SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS bytes FROM factory_ledger_artifact_reservations"
          )
          .get();
        if (
          typeof total?.count !== "number" ||
          typeof total.bytes !== "number" ||
          total.count >= quota.maximumTotalArtifacts ||
          total.bytes + upload.artifact.sizeBytes > quota.maximumTotalBytes
        )
          throw new ConflictError("Ledger artifact reservation quota is exhausted.");
        const reservation = encodeCanonicalDocument(
          factoryLedgerArtifactReservationSchema.parse({
            schemaVersion: "agentlab.ledger-artifact-reservation.v1",
            intent: intent.value,
            intentDigest: intent.digest,
            reservedAt
          })
        );
        this.#database
          .prepare(
            `INSERT INTO factory_ledger_artifact_reservations (${columns}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            intent.value.principalUid,
            upload.idempotencyKey,
            upload.taskId,
            upload.contractDigest,
            upload.artifact.digest,
            upload.artifact.sizeBytes,
            intent.digest,
            reservation.digest,
            reservation.json,
            reservedAt
          );
        return reservation;
      })
    );
  }

  public artifactReference(
    taskId: string,
    contractDigest: Sha256Digest,
    artifactDigest: Sha256Digest
  ): Promise<FactoryArtifactReference | null> {
    z.uuid().parse(taskId);
    sha256DigestSchema.parse(contractDigest);
    sha256DigestSchema.parse(artifactDigest);
    const row = this.#database
      .prepare(
        `SELECT ${columns} FROM factory_ledger_artifact_reservations
      WHERE task_id = ? AND contract_digest = ? AND artifact_digest = ? LIMIT 1`
      )
      .get(taskId, contractDigest, artifactDigest);
    if (row !== undefined) return Promise.resolve(this.#decode(row).value.intent.upload.artifact);
    // Compatibility with existing canonical evidence: a digest alone is never a read capability.
    // Select one bounded bundle instead of materializing the full task evidence history.
    const bundle = this.#database
      .prepare(
        `SELECT bundle_id, bundle_digest, task_id, contract_digest, sequence,
      previous_bundle_digest, policy_bundle_digest, created_at, bundle_json FROM factory_evidence_bundles AS bundle
      WHERE task_id = ? AND contract_digest = ? AND EXISTS (
        SELECT 1 FROM json_each(bundle.bundle_json, '$.items') AS item
        WHERE json_extract(item.value, '$.artifact.digest') = ?
      ) ORDER BY sequence DESC LIMIT 1`
      )
      .get(taskId, contractDigest, artifactDigest);
    if (bundle === undefined) return Promise.resolve(null);
    if (typeof bundle.bundle_json !== "string")
      throw new Error("Invalid task artifact evidence storage.");
    const document = new NodeFactoryDocumentCodec().evidenceBundle(
      JSON.parse(bundle.bundle_json) as unknown
    );
    if (
      document.json !== bundle.bundle_json ||
      document.digest !== bundle.bundle_digest ||
      document.value.taskId !== taskId ||
      document.value.contractDigest !== contractDigest ||
      document.value.bundleId !== bundle.bundle_id ||
      document.value.sequence !== bundle.sequence ||
      document.value.previousBundleDigest !== bundle.previous_bundle_digest ||
      document.value.policyBundleDigest !== bundle.policy_bundle_digest ||
      document.value.createdAt !== bundle.created_at
    ) {
      throw new Error("Task artifact evidence failed canonical identity verification.");
    }
    return Promise.resolve(
      document.value.items.find((item) => item.artifact.digest === artifactDigest)?.artifact ?? null
    );
  }

  public close(): void {
    this.#database.close();
  }

  #find(
    uid: number,
    key: string
  ): CanonicalFactoryDocument<FactoryLedgerArtifactReservation> | null {
    const row = this.#database
      .prepare(
        `SELECT ${columns} FROM factory_ledger_artifact_reservations
      WHERE principal_uid = ? AND idempotency_key = ?`
      )
      .get(uid, key);
    return row === undefined ? null : this.#decode(row);
  }

  #decode(
    row: Record<string, unknown>
  ): CanonicalFactoryDocument<FactoryLedgerArtifactReservation> {
    if (typeof row.reservation_json !== "string")
      throw new Error("Invalid artifact reservation storage.");
    const reservation = encodeCanonicalDocument(
      factoryLedgerArtifactReservationSchema.parse(JSON.parse(row.reservation_json) as unknown)
    );
    const { intent, intentDigest, reservedAt } = reservation.value;
    const { upload } = intent;
    if (
      reservation.json !== row.reservation_json ||
      reservation.digest !== row.reservation_digest ||
      intentDigest !== row.intent_digest ||
      encodeCanonicalDocument(intent).digest !== intentDigest ||
      intent.principalUid !== row.principal_uid ||
      upload.idempotencyKey !== row.idempotency_key ||
      upload.taskId !== row.task_id ||
      upload.contractDigest !== row.contract_digest ||
      upload.artifact.digest !== row.artifact_digest ||
      upload.artifact.sizeBytes !== row.size_bytes ||
      reservedAt !== row.reserved_at ||
      reservedAt >= upload.expiresAt
    ) {
      throw new Error("Artifact reservation failed canonical identity verification.");
    }
    return reservation;
  }
}
