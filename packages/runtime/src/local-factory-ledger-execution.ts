import type {
  FactoryLedgerOperation,
  FactoryLedgerOperationResult,
  Sha256Digest
} from "@agentlab/contracts";

import type { CanonicalFactoryDocument } from "./domain/factory-documents.js";
import type { FactoryLedgerExecutionTransport } from "./application/factory-ledger-execution-bridge.js";

export interface LocalFactoryLedgerExecutionOwner {
  enqueueOperation(job: CanonicalFactoryDocument<FactoryLedgerOperation>): Promise<Sha256Digest>;
  readOperationResult(
    job: CanonicalFactoryDocument<FactoryLedgerOperation>
  ): Promise<CanonicalFactoryDocument<FactoryLedgerOperationResult> | null>;
}

export interface LocalFactoryLedgerExecutionTransportOptions {
  readonly pollIntervalMs?: number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly now?: () => number;
}

/** Owner-side polling adapter; it never exposes a database handle to a worker. */
export function createLocalFactoryLedgerExecutionTransport(
  owner: LocalFactoryLedgerExecutionOwner,
  options: LocalFactoryLedgerExecutionTransportOptions = {}
): FactoryLedgerExecutionTransport {
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 10 || pollIntervalMs > 5_000) {
    throw new Error("Ledger execution polling interval must be between 10 and 5000 ms.");
  }
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((milliseconds: number) => delay(milliseconds));
  return {
    enqueue: (job) => owner.enqueueOperation(job),
    async awaitResult(job, expiresAt) {
      const deadline = Date.parse(expiresAt);
      if (!Number.isFinite(deadline))
        throw new Error("Ledger operation expiry is not a timestamp.");
      while (now() < deadline) {
        const result = await owner.readOperationResult(job);
        if (result !== null) return result;
        const remaining = deadline - now();
        if (remaining <= 0) break;
        await sleep(Math.min(pollIntervalMs, remaining));
      }
      throw new Error("Ledger operation result was not delivered before its immutable deadline.");
    }
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
