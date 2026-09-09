import type {
  FactoryLedgerOperation,
  FactoryLedgerOperationClaim,
  FactoryLedgerOperationPolicy,
  FactoryLedgerOperationReceipt,
  Sha256Digest
} from "@agentlab/contracts";

import type { CanonicalFactoryDocument } from "./factory-documents.js";

export interface FactoryLedgerQueuedOperation {
  readonly job: CanonicalFactoryDocument<FactoryLedgerOperation>;
  readonly claim: CanonicalFactoryDocument<FactoryLedgerOperationClaim> | null;
  readonly receipt: CanonicalFactoryDocument<FactoryLedgerOperationReceipt> | null;
}
/** One durable claim per operation. No lease timeout or retry can make it executable again. */
export interface FactoryLedgerOperationQueueRepository {
  enqueue(
    job: CanonicalFactoryDocument<FactoryLedgerOperation>,
    quota: Pick<
      FactoryLedgerOperationPolicy,
      "maximumTaskJobs" | "maximumTotalJobs" | "maximumStoredJobBytes"
    >,
    now: () => string
  ): Promise<FactoryLedgerQueuedOperation>;
  find(jobId: string): Promise<FactoryLedgerQueuedOperation | null>;
  /** Returns bounded job IDs; the application loads one candidate at a time and filters stale identities. */
  nextCandidateIds(
    uid: number,
    taskId: string,
    contractDigest: Sha256Digest,
    limit: number
  ): Promise<readonly string[]>;
  next(
    uid: number,
    taskId: string,
    contractDigest: Sha256Digest
  ): Promise<FactoryLedgerQueuedOperation | null>;
  claim(
    jobId: string,
    jobDigest: Sha256Digest,
    uid: number,
    invocationId: string,
    now: () => string
  ): Promise<{ readonly snapshot: FactoryLedgerQueuedOperation; readonly newlyClaimed: boolean }>;
  report(
    receipt: Omit<FactoryLedgerOperationReceipt, "reportedAt">,
    now: () => string
  ): Promise<FactoryLedgerQueuedOperation>;
}
