import { describe, expect, it } from "vitest";

import { createLocalFactoryLedgerExecutionTransport } from "../../packages/runtime/src/local-factory-ledger-execution.js";
import {
  ledgerOperationResult,
  ledgerOperationSeed
} from "../helpers/factory-ledger-operations.js";

const createdAt = "2026-09-08T12:00:00.000Z";

describe("local factory ledger execution transport", () => {
  it("polls owner reads until a committed result is available", async () => {
    const seed = ledgerOperationSeed(createdAt);
    const result = ledgerOperationResult(seed.job, createdAt);
    let reads = 0;
    const owner = {
      enqueueOperation: async () => seed.job.digest,
      readOperationResult: async () => {
        reads += 1;
        return reads < 3 ? null : result;
      }
    };
    const sleeps: number[] = [];
    const transport = createLocalFactoryLedgerExecutionTransport(owner, {
      pollIntervalMs: 50,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
      now: () => Date.parse(createdAt)
    });

    await expect(transport.enqueue(seed.job)).resolves.toBe(seed.job.digest);
    await expect(transport.awaitResult(seed.job, seed.job.value.expiresAt)).resolves.toEqual(
      result
    );
    expect(reads).toBe(3);
    expect(sleeps).toEqual([50, 50]);
  });

  it("stops polling at the immutable deadline", async () => {
    const seed = ledgerOperationSeed(createdAt);
    let clock = Date.parse(createdAt);
    const transport = createLocalFactoryLedgerExecutionTransport(
      {
        enqueueOperation: async () => seed.job.digest,
        readOperationResult: async () => null
      },
      {
        pollIntervalMs: 10,
        now: () => clock,
        sleep: async (milliseconds) => {
          clock += milliseconds;
        }
      }
    );

    await expect(transport.awaitResult(seed.job, seed.job.value.expiresAt)).rejects.toThrow(
      /immutable deadline/u
    );
  });
});
