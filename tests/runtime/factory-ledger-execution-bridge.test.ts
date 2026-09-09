import { randomUUID } from "node:crypto";

import {
  factoryAgentRunRequestSchema,
  factoryLedgerOperationResultSchema,
  type FactoryLedgerOperation,
  type FactoryResourceLimits
} from "@agentlab/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  FactoryLedgerExecutionBridge,
  type FactoryLedgerExecutionTransport
} from "../../packages/runtime/src/application/factory-ledger-execution-bridge.js";
import type {
  FactoryWorkspace,
  FactoryWorkspaceManager,
  FactoryWorkspacePatch
} from "../../packages/runtime/src/domain/factory-workspace.js";
import { NodeFactoryArtifactWireCodec } from "../../packages/runtime/src/infrastructure/filesystem/node-factory-artifact-wire-codec.js";
import { encodeCanonicalDocument } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import {
  TEST_FACTORY_TASK_ID,
  TEST_FACTORY_CONVERSATION_ID,
  testFactoryContract,
  testDigest
} from "../helpers/factory.js";
import type { FactoryTaskSnapshot } from "../../packages/runtime/src/domain/factory-task-repository.js";

const now = "2026-08-30T13:00:00.000Z";
const limits: FactoryResourceLimits = {
  maxMemoryBytes: 134_217_728,
  maxProcesses: 32,
  cpuQuotaPercent: 100
};
const wire = new NodeFactoryArtifactWireCodec();

describe("FactoryLedgerExecutionBridge", () => {
  it("binds a job to the post-start journal head and applies the verified worker patch", async () => {
    const contract = testFactoryContract();
    const task = taskSnapshot(contract);
    const clean = patch(contract.repository.baseRevision, "", []);
    const candidate = patch(contract.repository.baseRevision, "worker-patch", ["tracked.txt"]);
    const workspace = new FakeWorkspace(clean, candidate);
    let captured: FactoryLedgerOperation | null = null;
    const transport: FactoryLedgerExecutionTransport = {
      enqueue: vi.fn(async (job) => {
        captured = job.value;
        return job.digest;
      }),
      awaitResult: vi.fn(async (job) => result(job, candidate))
    };
    const bridge = new FactoryLedgerExecutionBridge({
      transport,
      workspaces: workspace,
      principals: [
        {
          principal: { uid: 1001, id: "writer", kind: "implementer" },
          workerPolicyDigest: testDigest("a")
        },
        {
          principal: { uid: 1002, id: "reviewer", kind: "reviewer" },
          workerPolicyDigest: testDigest("b")
        }
      ],
      digest: (bytes) => wire.digest(bytes),
      encode: encodeCanonicalDocument,
      now: () => now
    });
    const request = agentRequest(task, "implementer");
    const execution = {
      kind: "execution" as const,
      runId: randomUUID(),
      runDigest: testDigest("c"),
      eventDigest: testDigest("b")
    };

    const output = await bridge.execute({
      task,
      workspace: workspace.workspace,
      request,
      requestDigest: encodeCanonicalDocument(request).digest,
      prompt: "Implement the bounded change.",
      providerVersion: "1.0.0",
      role: "implementer",
      budget: { ...contract.budget, maxOutputBytes: 1_000_000 },
      attempt: 1,
      seedPatch: null,
      execution,
      resourceLimits: limits
    });

    expect(captured).toMatchObject({
      kind: "agent",
      jobId: request.executionId,
      taskId: TEST_FACTORY_TASK_ID,
      expectedTaskEventDigest: task.lastEventDigest,
      execution,
      logicalWorkspaceId: workspace.workspace.id,
      principal: { uid: 1001, kind: "implementer" },
      providerVersion: "1.0.0",
      seedPatch: null
    });
    expect(output.patch).toEqual(candidate);
    expect(workspace.applied).toEqual([{ patch: "worker-patch", direction: "forward" }]);
  });

  it("replaces a captain seed by reversing it before applying the worker result", async () => {
    const contract = testFactoryContract();
    const task = taskSnapshot(contract);
    const seed = patch(contract.repository.baseRevision, "seed-patch", ["tracked.txt"]);
    const candidate = patch(contract.repository.baseRevision, "candidate-patch", ["tracked.txt"]);
    const workspace = new FakeWorkspace(seed, candidate, 2);
    const transport: FactoryLedgerExecutionTransport = {
      enqueue: async (job) => job.digest,
      awaitResult: async (job) => result(job, candidate)
    };
    const bridge = new FactoryLedgerExecutionBridge({
      transport,
      workspaces: workspace,
      principals: [
        {
          principal: { uid: 1001, id: "writer", kind: "implementer" },
          workerPolicyDigest: testDigest("a")
        }
      ],
      digest: (bytes) => wire.digest(bytes),
      encode: encodeCanonicalDocument,
      now: () => now
    });
    const request = agentRequest(task, "repairer");

    await bridge.execute({
      task,
      workspace: workspace.workspace,
      request,
      requestDigest: encodeCanonicalDocument(request).digest,
      prompt: "Repair the bounded change.",
      providerVersion: "1.0.0",
      role: "repairer",
      budget: { ...contract.budget, maxOutputBytes: 1_000_000 },
      attempt: 2,
      seedPatch: seed,
      execution: {
        kind: "execution",
        runId: randomUUID(),
        runDigest: testDigest("c"),
        eventDigest: testDigest("b")
      },
      resourceLimits: limits
    });

    expect(workspace.applied).toEqual([
      { patch: "seed-patch", direction: "reverse" },
      { patch: "candidate-patch", direction: "forward" }
    ]);
  });
});

function taskSnapshot(contract: ReturnType<typeof testFactoryContract>): FactoryTaskSnapshot {
  return {
    contract,
    contractDigest: encodeCanonicalDocument(contract).digest,
    state: "executing",
    sequence: 1,
    lastEvent: {} as FactoryTaskSnapshot["lastEvent"],
    lastEventDigest: testDigest("d")
  };
}

function agentRequest(
  task: FactoryTaskSnapshot,
  role: "implementer" | "repairer"
): ReturnType<typeof factoryAgentRunRequestSchema.parse> {
  const prompt =
    role === "repairer" ? "Repair the bounded change." : "Implement the bounded change.";
  return factoryAgentRunRequestSchema.parse({
    schemaVersion: "agentlab.agent-run-request.v1",
    executionId: randomUUID(),
    taskId: task.contract.taskId,
    contractDigest: task.contractDigest,
    role,
    attempt: role === "repairer" ? 2 : 1,
    provider: "codex",
    model: "gpt-5.4",
    reasoning: "high",
    repository: task.contract.repository,
    promptArtifact: {
      digest: wire.digest(new TextEncoder().encode(prompt)),
      mediaType: "text/plain",
      sizeBytes: new TextEncoder().encode(prompt).byteLength
    },
    outputSchemaDigest: null,
    skillDigests: [testDigest("a")],
    capabilities: task.contract.capabilities,
    budget: { ...task.contract.budget, maxOutputBytes: 1_000_000 }
  });
}

function result(
  job: { readonly value: FactoryLedgerOperation; readonly digest: string },
  patchValue: FactoryWorkspacePatch
) {
  if (job.value.kind !== "agent") throw new Error("Expected agent job.");
  return encodeCanonicalDocument(
    factoryLedgerOperationResultSchema.parse({
      schemaVersion: "agentlab.ledger-operation-result.v1",
      kind: "agent",
      jobId: job.value.jobId,
      jobDigest: job.digest,
      output: {
        status: "succeeded",
        exitCode: 0,
        stdout: "done",
        stderr: "",
        finalOutput: "done",
        providerSessionId: "fixture-session",
        providerVersion: job.value.providerVersion,
        harnessVersion: "fixture-1",
        startedAt: "2026-08-30T13:00:01.000Z",
        finishedAt: "2026-08-30T13:00:02.000Z",
        usage: {
          wallClockSeconds: 1,
          agentTurns: 1,
          toolCalls: 1,
          inputTokens: 1,
          outputTokens: 1,
          costMicrousd: 1,
          processes: 1,
          outputBytes: 4,
          workers: 1,
          repairAttempts: 0,
          changedFiles: patchValue.changeSet.changedFiles,
          changedLines: patchValue.changeSet.changedLines
        },
        usageComplete: true,
        errorCode: null,
        isolation: {
          isolationId: job.value.jobId,
          mechanism: { id: "fixture", version: "1" },
          scopeName: `agentlab-factory-${job.value.jobId.replaceAll("-", "")}.scope`,
          limits
        }
      },
      patch: patchValue,
      workspace: "closed",
      completedAt: "2026-08-30T13:00:03.000Z"
    })
  );
}

function patch(baseRevision: string, value: string, changedPaths: string[]): FactoryWorkspacePatch {
  return {
    patch: value,
    changeSet: {
      baseRevision: baseRevision as FactoryWorkspacePatch["changeSet"]["baseRevision"],
      headRevision: null,
      changedPaths,
      binaryPaths: [],
      changedFiles: changedPaths.length,
      changedLines: changedPaths.length
    }
  };
}

class FakeWorkspace implements FactoryWorkspaceManager {
  readonly applied: { readonly patch: string; readonly direction?: "forward" | "reverse" }[] = [];
  readonly #initial: FactoryWorkspacePatch;
  readonly #candidate: FactoryWorkspacePatch;
  #current: FactoryWorkspacePatch;
  readonly workspace: FactoryWorkspace;

  public constructor(
    initial: FactoryWorkspacePatch,
    candidate: FactoryWorkspacePatch,
    attempt = 1
  ) {
    this.#initial = initial;
    this.#candidate = candidate;
    this.#current = initial;
    this.workspace = {
      id: "33333333-3333-4333-8333-333333333333",
      taskId: TEST_FACTORY_TASK_ID,
      attempt,
      repositoryRoot: "/tmp/agentlab-source",
      root: "/tmp/agentlab-workspace",
      baseRevision: "a".repeat(40),
      closeAndWait: async () => undefined
    };
  }

  public create(): Promise<FactoryWorkspace> {
    return Promise.resolve(this.workspace);
  }

  public apply(
    _workspace: FactoryWorkspace,
    patchValue: string,
    _maximumPatchBytes: number,
    direction: "forward" | "reverse" = "forward"
  ): Promise<void> {
    this.applied.push({ patch: patchValue, direction });
    if (direction === "reverse") this.#current = this.#initial;
    else this.#current = this.#candidate;
    return Promise.resolve();
  }

  public collect(): Promise<FactoryWorkspacePatch> {
    return Promise.resolve(this.#current);
  }
}
