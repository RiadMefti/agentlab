import type { DatabaseSync } from "node:sqlite";

import {
  factoryLedgerOperationSchema,
  factoryLedgerOperationClaimSchema,
  factoryLedgerOperationReceiptSchema,
  factoryTimestampSchema,
  sha256DigestSchema,
  type FactoryLedgerOperation,
  type FactoryLedgerOperationPolicy,
  type FactoryLedgerOperationReceipt,
  type Sha256Digest
} from "@agentlab/contracts";
import { z } from "zod";

import { ConflictError } from "../../domain/errors.js";
import type { CanonicalFactoryDocument } from "../../domain/factory-documents.js";
import type {
  FactoryLedgerOperationQueueRepository,
  FactoryLedgerQueuedOperation
} from "../../domain/factory-ledger-operation-queue.js";
import { factoryTimestampDifferenceSeconds } from "../../domain/factory-timestamp.js";
import { encodeCanonicalDocument } from "./canonical-factory-documents.js";
import { openSqliteDatabase } from "./sqlite-database.js";
import { withImmediateFactoryTransaction } from "./sqlite-factory-execution-journal.js";

const uidSchema = z.number().int().min(1).max(0xffff_fffe);
const quotaSchema = z.strictObject({
  maximumTaskJobs: z.number().int().min(1).max(256),
  maximumTotalJobs: z.number().int().min(1).max(65536),
  maximumStoredJobBytes: z.number().int().min(1).max(1_073_741_824)
});

/** The ledger owns this writer. A claimed operation never becomes pending again. */
export class SqliteFactoryLedgerOperationQueue implements FactoryLedgerOperationQueueRepository {
  readonly #database: DatabaseSync;
  public constructor(path: string) {
    this.#database = openSqliteDatabase(path);
  }

  public enqueue(
    claim: CanonicalFactoryDocument<FactoryLedgerOperation>,
    quotaInput: Pick<
      FactoryLedgerOperationPolicy,
      "maximumTaskJobs" | "maximumTotalJobs" | "maximumStoredJobBytes"
    >,
    now: () => string
  ): Promise<FactoryLedgerQueuedOperation> {
    const job = encodeCanonicalDocument(factoryLedgerOperationSchema.parse(claim.value));
    if (job.digest !== claim.digest || job.json !== claim.json)
      throw new Error("Operation differs from its canonical job identity.");
    const bytes = Buffer.byteLength(job.json, "utf8");
    if (bytes > 16_000_000)
      throw new ConflictError("Operation exceeds its bounded wire representation.");
    const quota = quotaSchema.parse(quotaInput);
    return Promise.resolve(
      withImmediateFactoryTransaction(this.#database, "Ledger operation enqueue", () => {
        const previous = this.#find(job.value.jobId);
        if (previous !== null) {
          if (previous.job.digest !== job.digest)
            throw new ConflictError("Operation ID already binds another immutable job.");
          return previous;
        }
        this.#time(job.value, now, true);
        this.#active(job.value);
        const total = this.#database
          .prepare(
            "SELECT COUNT(*) AS count, COALESCE(SUM(job_bytes), 0) AS bytes FROM factory_ledger_operations"
          )
          .get();
        const task = this.#database
          .prepare("SELECT COUNT(*) AS count FROM factory_ledger_operations WHERE task_id = ?")
          .get(job.value.taskId);
        if (
          typeof total?.count !== "number" ||
          typeof total.bytes !== "number" ||
          typeof task?.count !== "number" ||
          total.count >= quota.maximumTotalJobs ||
          total.bytes + bytes > quota.maximumStoredJobBytes ||
          task.count >= quota.maximumTaskJobs
        )
          throw new ConflictError("Ledger operation reservation quota is exhausted.");
        this.#database
          .prepare(
            `INSERT INTO factory_ledger_operations
        (job_id, task_id, contract_digest, principal_uid, job_digest, job_bytes, job_json, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            job.value.jobId,
            job.value.taskId,
            job.value.contractDigest,
            job.value.principal.uid,
            job.digest,
            bytes,
            job.json,
            job.value.createdAt,
            job.value.expiresAt
          );
        return { job, claim: null, receipt: null };
      })
    );
  }

  public find(jobId: string): Promise<FactoryLedgerQueuedOperation | null> {
    return Promise.resolve(this.#find(z.uuid().parse(jobId)));
  }

  public next(
    uid: number,
    taskId: string,
    contractDigest: Sha256Digest
  ): Promise<FactoryLedgerQueuedOperation | null> {
    return this.nextCandidateIds(uid, taskId, contractDigest, 1).then(([jobId]) =>
      jobId === undefined ? null : this.#find(jobId)
    );
  }

  public nextCandidateIds(
    uid: number,
    taskId: string,
    contractDigest: Sha256Digest,
    limit: number
  ): Promise<readonly string[]> {
    uidSchema.parse(uid);
    z.uuid().parse(taskId);
    sha256DigestSchema.parse(contractDigest);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256)
      throw new Error("Operation candidate limit must be between 1 and 256.");
    const row = this.#database
      .prepare(
        `SELECT job.job_id FROM factory_ledger_operations AS job
      LEFT JOIN factory_ledger_operation_claims AS claim ON claim.job_id = job.job_id
      LEFT JOIN factory_ledger_operation_receipts AS receipt ON receipt.job_id = job.job_id
      WHERE job.principal_uid = ? AND job.task_id = ? AND job.contract_digest = ? AND receipt.job_id IS NULL
      ORDER BY CASE WHEN claim.job_id IS NULL THEN 1 ELSE 0 END, job.created_at, job.job_id LIMIT ?`
      )
      .all(uid, taskId, contractDigest, limit);
    return Promise.resolve(
      row
        .filter((entry): entry is { readonly job_id: string } => typeof entry.job_id === "string")
        .map(({ job_id }) => job_id)
    );
  }

  public claim(
    jobId: string,
    jobDigest: Sha256Digest,
    uid: number,
    invocationId: string,
    now: () => string
  ) {
    z.uuid().parse(jobId);
    sha256DigestSchema.parse(jobDigest);
    uidSchema.parse(uid);
    z.uuid().parse(invocationId);
    return Promise.resolve(
      withImmediateFactoryTransaction(this.#database, "Ledger operation claim", () => {
        const snapshot = this.#require(jobId, jobDigest, uid);
        if (snapshot.claim !== null) {
          if (snapshot.claim.value.invocationId !== invocationId)
            throw new ConflictError("Operation is already consumed by another invocation.");
          return { snapshot, newlyClaimed: false };
        }
        const claimedAt = this.#time(snapshot.job.value, now, true);
        this.#active(snapshot.job.value);
        const outstanding = this.#database
          .prepare(
            `SELECT claim.job_id FROM factory_ledger_operation_claims AS claim
        LEFT JOIN factory_ledger_operation_receipts AS receipt ON receipt.job_id = claim.job_id
        WHERE claim.principal_uid = ? AND receipt.job_id IS NULL LIMIT 1`
          )
          .get(uid);
        if (outstanding !== undefined)
          throw new ConflictError("This worker still owns an unresolved operation.");
        const used = this.#database
          .prepare(
            "SELECT job_id FROM factory_ledger_operation_claims WHERE principal_uid = ? AND invocation_id = ?"
          )
          .get(uid, invocationId);
        if (used !== undefined)
          throw new ConflictError("Worker invocation ID already names another operation.");
        const claim = encodeCanonicalDocument(
          factoryLedgerOperationClaimSchema.parse({
            schemaVersion: "agentlab.ledger-operation-claim.v1",
            jobId,
            jobDigest,
            principalUid: uid,
            invocationId,
            claimedAt
          })
        );
        this.#database
          .prepare(
            `INSERT INTO factory_ledger_operation_claims
        (job_id, principal_uid, invocation_id, claim_digest, claim_json, claimed_at) VALUES (?, ?, ?, ?, ?, ?)`
          )
          .run(jobId, uid, invocationId, claim.digest, claim.json, claimedAt);
        return { snapshot: { ...snapshot, claim }, newlyClaimed: true };
      })
    );
  }

  public report(
    input: Omit<FactoryLedgerOperationReceipt, "reportedAt">,
    now: () => string
  ): Promise<FactoryLedgerQueuedOperation> {
    const parsed = factoryLedgerOperationReceiptSchema.omit({ reportedAt: true }).parse(input);
    return Promise.resolve(
      withImmediateFactoryTransaction(this.#database, "Ledger operation report", () => {
        const snapshot = this.#require(parsed.jobId, parsed.jobDigest, parsed.principalUid);
        if (snapshot.claim?.digest !== parsed.claimDigest)
          throw new ConflictError("Operation result does not bind the consumed claim.");
        if (snapshot.receipt !== null) {
          const replay = encodeCanonicalDocument({
            ...parsed,
            reportedAt: snapshot.receipt.value.reportedAt
          });
          if (replay.digest !== snapshot.receipt.digest)
            throw new ConflictError("Operation already has a different immutable result receipt.");
          return snapshot;
        }
        const reportedAt = this.#time(snapshot.job.value, now, false);
        if (reportedAt < snapshot.claim.value.claimedAt)
          throw new ConflictError("Operation clock regressed after its claim.");
        this.#active(snapshot.job.value);
        const receipt = encodeCanonicalDocument(
          factoryLedgerOperationReceiptSchema.parse({ ...parsed, reportedAt })
        );
        this.#database
          .prepare(
            `INSERT INTO factory_ledger_operation_receipts (job_id, receipt_digest, receipt_json, reported_at) VALUES (?, ?, ?, ?)`
          )
          .run(parsed.jobId, receipt.digest, receipt.json, reportedAt);
        return { ...snapshot, receipt };
      })
    );
  }

  public close(): void {
    this.#database.close();
  }

  #require(jobId: string, digest: Sha256Digest, uid: number): FactoryLedgerQueuedOperation {
    const value = this.#find(jobId);
    if (value?.job.digest !== digest || value.job.value.principal.uid !== uid)
      throw new ConflictError("Operation identity or assigned UID does not match.");
    return value;
  }

  #find(jobId: string): FactoryLedgerQueuedOperation | null {
    const row = this.#database
      .prepare("SELECT * FROM factory_ledger_operations WHERE job_id = ?")
      .get(jobId);
    if (row === undefined) return null;
    if (typeof row.job_json !== "string") throw new Error("Invalid stored ledger operation.");
    const job = encodeCanonicalDocument(
      factoryLedgerOperationSchema.parse(JSON.parse(row.job_json) as unknown)
    );
    if (
      job.json !== row.job_json ||
      job.digest !== row.job_digest ||
      job.value.jobId !== row.job_id ||
      job.value.taskId !== row.task_id ||
      job.value.contractDigest !== row.contract_digest ||
      job.value.principal.uid !== row.principal_uid ||
      Buffer.byteLength(job.json) !== row.job_bytes ||
      job.value.createdAt !== row.created_at ||
      job.value.expiresAt !== row.expires_at
    )
      throw new Error("Stored ledger operation failed canonical projection verification.");
    const claimed = this.#database
      .prepare("SELECT * FROM factory_ledger_operation_claims WHERE job_id = ?")
      .get(jobId);
    const reported = this.#database
      .prepare("SELECT * FROM factory_ledger_operation_receipts WHERE job_id = ?")
      .get(jobId);
    if (claimed !== undefined && typeof claimed.claim_json !== "string")
      throw new Error("Invalid stored operation claim.");
    const claim =
      claimed === undefined
        ? null
        : encodeCanonicalDocument(
            factoryLedgerOperationClaimSchema.parse(
              JSON.parse(String(claimed.claim_json)) as unknown
            )
          );
    if (
      claim !== null &&
      (claim.json !== claimed?.claim_json ||
        claim.digest !== claimed.claim_digest ||
        claim.value.jobId !== jobId ||
        claim.value.jobDigest !== job.digest ||
        claim.value.principalUid !== job.value.principal.uid ||
        claim.value.principalUid !== claimed.principal_uid ||
        claim.value.invocationId !== claimed.invocation_id ||
        claim.value.claimedAt !== claimed.claimed_at ||
        claim.value.claimedAt < job.value.createdAt ||
        claim.value.claimedAt >= job.value.expiresAt)
    )
      throw new Error("Stored operation claim failed canonical projection verification.");
    if (reported !== undefined && typeof reported.receipt_json !== "string")
      throw new Error("Invalid stored operation receipt.");
    const receipt =
      reported === undefined
        ? null
        : encodeCanonicalDocument(
            factoryLedgerOperationReceiptSchema.parse(
              JSON.parse(String(reported.receipt_json)) as unknown
            )
          );
    if (
      receipt !== null &&
      (claim === null ||
        receipt.json !== reported?.receipt_json ||
        receipt.digest !== reported.receipt_digest ||
        receipt.value.jobId !== jobId ||
        receipt.value.jobDigest !== job.digest ||
        receipt.value.claimDigest !== claim.digest ||
        receipt.value.principalUid !== claim.value.principalUid ||
        receipt.value.reportedAt !== reported.reported_at ||
        receipt.value.reportedAt < claim.value.claimedAt ||
        receipt.value.reportedAt >= job.value.expiresAt)
    )
      throw new Error("Stored operation receipt failed canonical projection verification.");
    return { job, claim, receipt };
  }

  #time(job: FactoryLedgerOperation, now: () => string, requireRunTime: boolean): string {
    const timestamp = factoryTimestampSchema.parse(now());
    if (
      timestamp < job.createdAt ||
      timestamp >= job.expiresAt ||
      (requireRunTime &&
        factoryTimestampDifferenceSeconds(timestamp, job.expiresAt) <
          job.limits.maximumRunSeconds + job.limits.cleanupReserveSeconds)
    )
      throw new ConflictError(
        "Operation expired, the clock regressed, or execution/cleanup time is exhausted."
      );
    return timestamp;
  }

  #active(job: FactoryLedgerOperation): void {
    const task = this.#database
      .prepare(
        "SELECT event_digest FROM factory_task_events WHERE task_id = ? AND contract_digest = ? ORDER BY sequence DESC LIMIT 1"
      )
      .get(job.taskId, job.contractDigest);
    const table =
      job.execution.kind === "execution"
        ? "factory_execution_events"
        : "factory_pull_request_repair_events";
    const event = this.#database
      .prepare(
        `SELECT event_digest, run_digest, operation_id, operation_kind, execution_role, gate_id, request_digest, attempt, workspace_id, kind
      FROM ${table} WHERE run_id = ? AND task_id = ? AND contract_digest = ? ORDER BY sequence DESC LIMIT 1`
      )
      .get(job.execution.runId, job.taskId, job.contractDigest);
    if (
      task?.event_digest !== job.expectedTaskEventDigest ||
      event?.event_digest !== job.execution.eventDigest ||
      event.run_digest !== job.execution.runDigest ||
      event.operation_id !== job.jobId ||
      event.operation_kind !== job.kind ||
      event.attempt !== job.attempt ||
      event.workspace_id !== job.logicalWorkspaceId ||
      event.kind !== "operation-started" ||
      (job.kind === "agent"
        ? event.execution_role !== job.request.role ||
          event.request_digest !== encodeCanonicalDocument(job.request).digest
        : event.gate_id !== job.gateId)
    )
      throw new ConflictError("Operation no longer binds the active task and journaled request.");
  }
}
