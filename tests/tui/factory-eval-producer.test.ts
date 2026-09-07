import type { FactoryEvalProductionResult } from "@agentlab/contracts";
import type {
  LocalFactoryEvalProducerConfig,
  LocalFactoryEvalProducerRuntime
} from "@agentlab/runtime/factory-eval-producer";
import { describe, expect, it, vi } from "vitest";

import {
  runFactoryEvalProduce,
  runFactoryEvalProducerPreflight
} from "../../apps/tui/src/run-factory-eval-producer.js";
import { testFactoryEvalProductionJob } from "../helpers/factory-eval-production.js";
import { NodeFactoryDocumentCodec } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";

const documents = new NodeFactoryDocumentCodec();

describe("factory eval producer CLI runner", () => {
  it("preflights an exact immutable job and always closes the runtime", async () => {
    const job = testFactoryEvalProductionJob();
    const digest = documents.evalProductionJob(job).digest;
    const preflight = vi.fn(() => Promise.resolve({ jobId: job.jobId, jobDigest: digest }));
    const close = vi.fn(() => Promise.resolve());
    const write = vi.fn();

    await expect(
      runFactoryEvalProducerPreflight(
        "/private/eval-producer.json",
        "/private/eval-job.json",
        digest,
        dependencies(job, { preflight, produce: vi.fn() }, close, write)
      )
    ).resolves.toBe(0);

    expect(preflight).toHaveBeenCalledWith(job, digest);
    expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toEqual({
      schemaVersion: "agentlab.eval-producer-preflight-result.v1",
      status: "ready",
      jobId: job.jobId,
      jobDigest: digest
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("returns a nonzero status for a durable terminal failure", async () => {
    const job = testFactoryEvalProductionJob();
    const digest = documents.evalProductionJob(job).digest;
    const result: FactoryEvalProductionResult = {
      schemaVersion: "agentlab.eval-production-result.v1",
      status: "failed",
      jobId: job.jobId,
      jobDigest: digest,
      state: "failed",
      evalRunDigest: null,
      evalRunArtifact: null,
      sampleCount: 0,
      usage: {
        wallClockSeconds: 0,
        agentTurns: 0,
        toolCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        costMicrousd: 0,
        processes: 0,
        outputBytes: 0,
        workers: 1,
        repairAttempts: 0,
        changedFiles: 0,
        changedLines: 0
      },
      reasonCode: "execution-timeout"
    };
    const close = vi.fn(() => Promise.resolve());
    const write = vi.fn();

    await expect(
      runFactoryEvalProduce(
        "/private/eval-producer.json",
        "/private/eval-job.json",
        digest,
        dependencies(
          job,
          { preflight: vi.fn(), produce: vi.fn(() => Promise.resolve(result)) },
          close,
          write
        )
      )
    ).resolves.toBe(1);

    expect(JSON.parse(String(write.mock.calls[0]?.[0]))).toEqual(result);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed coordinates before loading local files", async () => {
    const loadConfig = vi.fn();
    const loadJob = vi.fn();

    await expect(
      runFactoryEvalProduce("relative.json", "/private/eval-job.json", "not-a-digest", {
        loadConfig,
        loadJob,
        createRuntime: vi.fn(),
        write: vi.fn()
      })
    ).rejects.toThrow(/absolute config/u);
    expect(loadConfig).not.toHaveBeenCalled();
    expect(loadJob).not.toHaveBeenCalled();
  });
});

function dependencies(
  job: ReturnType<typeof testFactoryEvalProductionJob>,
  commands: LocalFactoryEvalProducerRuntime["commands"],
  close: () => Promise<void>,
  write: (message: string) => void
) {
  return {
    loadConfig: () => Promise.resolve({} as LocalFactoryEvalProducerConfig),
    loadJob: () => Promise.resolve(job),
    createRuntime: () => ({ commands, close }),
    write
  };
}
