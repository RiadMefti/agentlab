import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { factoryLedgerOperationSchema, type FactoryLedgerOperation } from "@agentlab/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FactoryLedgerOperationWorker } from "../../packages/runtime/src/application/factory-ledger-operation-worker.js";
import type {
  FactoryAgentExecutionInput,
  FactoryAgentExecutionOutput,
  FactoryAgentExecutor
} from "../../packages/runtime/src/domain/factory-agent-executor.js";
import type {
  FactoryGateExecutionInput,
  FactoryGateExecutionOutput
} from "../../packages/runtime/src/domain/factory-gate.js";
import type { FactoryWorkspacePatch } from "../../packages/runtime/src/domain/factory-workspace.js";
import { GitFactoryWorkspaceManager } from "../../packages/runtime/src/infrastructure/filesystem/git-factory-workspace.js";
import { NodeFactoryArtifactWireCodec } from "../../packages/runtime/src/infrastructure/filesystem/node-factory-artifact-wire-codec.js";
import { encodeCanonicalDocument } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { NodeCommandRunner } from "../../packages/runtime/src/infrastructure/process/command-runner.js";
import { testDigest, testFactoryContract } from "../helpers/factory.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const createdAt = "2026-09-08T12:00:00.000Z";
const finishedAt = "2026-09-08T12:00:01.000Z";
const limits = { maxMemoryBytes: 134_217_728, maxProcesses: 4, cpuQuotaPercent: 100 };
const isolation = (id: string) => ({
  isolationId: id,
  mechanism: { id: "fixture-only", version: "1" },
  scopeName: `agentlab-factory-${id.replaceAll("-", "")}.scope`,
  limits
});

/** Real Git worktrees; injected model/gate outputs are fixtures, not live model or sandbox proof. */
function fixture(kind: FactoryLedgerOperation["principal"]["kind"] = "implementer") {
  const root = mkdtempSync(join(tmpdir(), "agentlab-operation-worker-"));
  roots.push(root);
  const repository = join(root, "source");
  mkdirSync(repository);
  const git = (...args: string[]) =>
    execFileSync("/usr/bin/git", args, {
      cwd: repository,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    }).trim();
  git("init", "--initial-branch=main");
  git("config", "user.name", "Factory Fixture");
  git("config", "user.email", "fixture@example.invalid");
  git("config", "commit.gpgsign", "false");
  writeFileSync(join(repository, "tracked.txt"), "original\n");
  git("add", "tracked.txt");
  git("commit", "-m", "Fixture base");
  const baseRevision = git("rev-parse", "HEAD");
  const manager = new GitFactoryWorkspaceManager(new NodeCommandRunner(), {
    root: join(root, "worktrees"),
    gitExecutable: "/usr/bin/git",
    flockExecutable: "/usr/bin/flock",
    createId: randomUUID
  });
  const agentExecute = vi.fn(
    (input: FactoryAgentExecutionInput): Promise<FactoryAgentExecutionOutput> => {
      if (input.request.role === "implementer" || input.request.role === "repairer")
        writeFileSync(join(input.workspace.root, "tracked.txt"), "changed\n");
      return Promise.resolve(agentOutput(input));
    }
  );
  const agents: FactoryAgentExecutor = {
    capabilities: () => [
      {
        provider: "codex",
        roles: ["implementer", "repairer", "reviewer"],
        preparationPhases: [],
        maintenanceDiscovery: false,
        maximumToolFilesystemAccess: "workspace-write",
        toolNetwork: "off",
        acceptsCommandAllowlist: true,
        acceptsSecrets: false
      }
    ],
    preflight: vi.fn(),
    execute: agentExecute
  };
  const gateExecute = vi.fn(
    (input: FactoryGateExecutionInput): Promise<FactoryGateExecutionOutput> =>
      Promise.resolve({
        gateId: input.gateId,
        evidenceKind: "test",
        command: { executable: "/usr/bin/true", args: [] },
        result: "pass",
        exitCode: 0,
        startedAt: createdAt,
        finishedAt,
        wallClockSeconds: 1,
        outputBytes: 0,
        stdout: "",
        stderr: "",
        isolation: isolation(input.isolationId)
      })
  );
  const principal = {
    uid: kind === "implementer" ? 1001 : kind === "reviewer" ? 1002 : 1003,
    id: kind,
    kind
  };
  const wire = new NodeFactoryArtifactWireCodec();
  const dependencies = {
    principal,
    workerPolicyDigest: testDigest("a"),
    factoryPolicyDigest: testDigest("b"),
    repository: { id: "fixture", root: repository },
    workspaces: manager,
    recovery: { reconcile: vi.fn(() => Promise.resolve({ status: "inactive" as const })) },
    agents,
    providers: {
      resolve: vi.fn(() =>
        Promise.resolve({ executable: "/fixture/pinned-provider", version: "1.0.0" })
      )
    },
    gates: { availableGateIds: () => ["verify"], execute: gateExecute },
    wire,
    encode: encodeCanonicalDocument,
    now: vi.fn(() => finishedAt)
  };
  const job = (seedPatch: FactoryWorkspacePatch | null = null) => {
    const contract = testFactoryContract();
    const jobId = randomUUID();
    const taskId = randomUUID();
    const prompt = "Complete this bounded fixture operation.";
    const common = {
      schemaVersion: "agentlab.ledger-operation.v1",
      jobId,
      taskId,
      contractDigest: testDigest("c"),
      expectedTaskEventDigest: testDigest("d"),
      execution: {
        kind: "execution",
        runId: randomUUID(),
        runDigest: testDigest("e"),
        eventDigest: testDigest("f")
      },
      attempt: 1,
      logicalWorkspaceId: randomUUID(),
      principal,
      workerPolicyDigest: dependencies.workerPolicyDigest,
      factoryPolicyDigest: dependencies.factoryPolicyDigest,
      repository: { id: "fixture", baseRevision },
      createdAt,
      expiresAt: "2026-09-08T12:02:00.000Z",
      resourceLimits: limits,
      limits: {
        maximumChangedFiles: 5,
        maximumChangedLines: 10,
        maximumPatchBytes: 65536,
        maximumResultBytes: 131072,
        maximumRunSeconds: 10,
        cleanupReserveSeconds: 30
      },
      seedPatch
    };
    return encodeCanonicalDocument(
      factoryLedgerOperationSchema.parse(
        kind === "gate-observer"
          ? { ...common, kind: "gate", gateId: "verify" }
          : {
              ...common,
              kind: "agent",
              prompt,
              providerVersion: "1.0.0",
              request: {
                schemaVersion: "agentlab.agent-run-request.v1",
                executionId: jobId,
                taskId,
                contractDigest: common.contractDigest,
                role: kind === "reviewer" ? "reviewer" : "implementer",
                attempt: 1,
                provider: "codex",
                model: null,
                reasoning: null,
                repository: common.repository,
                promptArtifact: {
                  digest: wire.digest(Buffer.from(prompt)),
                  sizeBytes: Buffer.byteLength(prompt),
                  mediaType: "text/plain"
                },
                outputSchemaDigest: null,
                skillDigests: [testDigest("a")],
                capabilities: {
                  ...contract.capabilities,
                  ...(kind === "reviewer" ? { filesystem: "read", git: "read" } : {})
                },
                budget: { ...contract.budget, wallClockSeconds: 10 }
              }
            }
      )
    );
  };
  return {
    root,
    repository,
    baseRevision,
    git,
    manager,
    dependencies,
    job,
    agentExecute,
    gateExecute,
    worker: new FactoryLedgerOperationWorker(dependencies)
  };
}

function agentOutput(input: FactoryAgentExecutionInput): FactoryAgentExecutionOutput {
  return {
    status: "succeeded",
    exitCode: 0,
    stdout: "fixture output",
    stderr: "",
    finalOutput: "done",
    providerSessionId: `fixture-${input.request.executionId}`,
    providerVersion: "1.0.0",
    harnessVersion: "fixture-1",
    startedAt: createdAt,
    finishedAt,
    usage: {
      wallClockSeconds: 1,
      agentTurns: 1,
      toolCalls: 1,
      inputTokens: 10,
      outputTokens: 10,
      costMicrousd: 1,
      processes: 1,
      outputBytes: 24,
      workers: 1,
      repairAttempts: 0,
      changedFiles: 0,
      changedLines: 0
    },
    usageComplete: true,
    errorCode: null,
    isolation: isolation(input.request.executionId)
  };
}

describe("isolated ledger operation worker", () => {
  it("returns a patch only after closing its exact job-owned worktree and does not touch the source", async () => {
    const f = fixture();
    const job = f.job();
    const result = await f.worker.execute(job);
    expect(result.value).toMatchObject({
      jobId: job.value.jobId,
      jobDigest: job.digest,
      workspace: "closed",
      kind: "agent"
    });
    expect(result.value.patch.patch).toContain("+changed");
    expect(readFileSync(join(f.repository, "tracked.txt"), "utf8")).toBe("original\n");
    const call = f.agentExecute.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    if (!call) throw new Error("Missing agent call.");
    expect(call.workspace.id).toBe(job.value.jobId);
    expect(call.workspace.id).not.toBe(job.value.logicalWorkspaceId);
    expect(existsSync(call.workspace.root)).toBe(false);
    await expect(f.worker.execute(job)).rejects.toThrow(/replay/u);
    expect(f.agentExecute).toHaveBeenCalledTimes(1);
  });

  it.each(["reviewer", "gate-observer"] as const)(
    "reconstructs the same immutable patch in a fresh %s worktree",
    async (kind) => {
      const f = fixture();
      const implemented = await f.worker.execute(f.job());
      // A separate executor role gets a new checkout from the exact source revision. The shared
      // test manager and injected identities do not constitute an OS identity-isolation proof.
      const principal = { uid: 1002, id: kind, kind };
      const reviewer = new FactoryLedgerOperationWorker({ ...f.dependencies, principal });
      const sample = fixture(kind).job().value;
      const job = encodeCanonicalDocument(
        factoryLedgerOperationSchema.parse({
          ...sample,
          seedPatch: implemented.value.patch,
          principal,
          repository: { id: "fixture", baseRevision: f.baseRevision },
          ...(sample.kind === "agent"
            ? {
                request: {
                  ...sample.request,
                  repository: { id: "fixture", baseRevision: f.baseRevision }
                }
              }
            : {})
        })
      );
      const result = await reviewer.execute(job);
      expect(result.value.patch).toEqual(implemented.value.patch);
      if (kind === "reviewer") expect(f.agentExecute).toHaveBeenCalledTimes(2);
      else expect(f.gateExecute).toHaveBeenCalledTimes(1);
    }
  );

  it("rejects changed job bytes, wrong roles/policies and expired work before creating a checkout", async () => {
    const f = fixture();
    const create = vi.spyOn(f.manager, "create");
    const job = f.job();
    await expect(f.worker.execute({ ...job, digest: testDigest("0") })).rejects.toThrow(/pinned/u);
    await expect(
      f.worker.execute(
        encodeCanonicalDocument({ ...job.value, workerPolicyDigest: testDigest("1") })
      )
    ).rejects.toThrow(/pinned/u);
    await expect(
      f.worker.execute(
        encodeCanonicalDocument({ ...job.value, principal: { ...job.value.principal, uid: 9999 } })
      )
    ).rejects.toThrow(/pinned/u);
    f.dependencies.now.mockReturnValue("2026-09-08T12:01:59.000Z");
    await expect(f.worker.execute(job)).rejects.toThrow(/time remaining/u);
    expect(create).not.toHaveBeenCalled();
  });

  it("denies prompt/provider drift before model work and cleans the prepared checkout", async () => {
    const f = fixture();
    const job = f.job();
    if (job.value.kind !== "agent") throw new Error("Expected agent.");
    await expect(
      f.worker.execute(encodeCanonicalDocument({ ...job.value, prompt: "changed" }))
    ).rejects.toThrow(/prompt/u);
    f.dependencies.providers.resolve.mockResolvedValue({
      executable: "/fixture/pinned-provider",
      version: "2.0.0"
    });
    await expect(f.worker.execute(f.job())).rejects.toThrow(/version/u);
    expect(f.agentExecute).not.toHaveBeenCalled();
    expect(f.git("worktree", "list", "--porcelain").match(/^worktree /gmu)).toHaveLength(1);
  });

  it.each(["reviewer", "gate-observer"] as const)(
    "rejects candidate changes by the %s",
    async (kind) => {
      const f = fixture(kind);
      if (kind === "reviewer")
        f.agentExecute.mockImplementationOnce((input) => {
          writeFileSync(join(input.workspace.root, "tracked.txt"), "not allowed\n");
          return Promise.resolve(agentOutput(input));
        });
      else {
        const original = f.gateExecute.getMockImplementation();
        f.gateExecute.mockImplementationOnce(async (input) => {
          if (!original) throw new Error("Missing fixture gate.");
          writeFileSync(join(input.workspace.root, "tracked.txt"), "not allowed\n");
          return original(input);
        });
      }
      await expect(f.worker.execute(f.job())).rejects.toThrow(/changed the candidate/u);
      expect(f.git("worktree", "list", "--porcelain").match(/^worktree /gmu)).toHaveLength(1);
    }
  );

  it("retains uncertain processes and prohibits new work until exact recovery succeeds", async () => {
    const f = fixture();
    const job = f.job();
    f.agentExecute.mockImplementationOnce((input) =>
      Promise.resolve({
        ...agentOutput(input),
        status: "failed",
        errorCode: "process-cleanup-failed"
      })
    );
    await expect(f.worker.execute(job)).rejects.toThrow(/cleanup is uncertain/u);
    const call = f.agentExecute.mock.calls[0]?.[0];
    if (!call) throw new Error("Missing fixture call.");
    expect(existsSync(call.workspace.root)).toBe(true);
    await expect(f.worker.execute(f.job())).rejects.toThrow(/overlap/u);
    await f.worker.recover(job);
    expect(f.dependencies.recovery.reconcile).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: job.value.jobId,
        processExecutionIds: [job.value.jobId]
      })
    );
    expect(existsSync(call.workspace.root)).toBe(false);
    await expect(f.worker.execute(job)).rejects.toThrow(/replay/u);
    await expect(f.worker.execute(f.job())).resolves.toMatchObject({
      value: { workspace: "closed" }
    });
  });

  it("keeps a failed workspace construction blocked until recovery instead of silently starting another job", async () => {
    const f = fixture();
    const job = f.job();
    vi.spyOn(f.manager, "create").mockRejectedValueOnce(
      new Error("construction cleanup uncertain")
    );
    await expect(f.worker.execute(job)).rejects.toThrow(/construction/u);
    await expect(f.worker.execute(f.job())).rejects.toThrow(/overlap/u);
    await f.worker.recover(job);
    await expect(f.worker.execute(f.job())).resolves.toMatchObject({
      value: { workspace: "closed" }
    });
  });

  it("retains a checkout if the executor reports another process identity, and rejects late/oversized results", async () => {
    const f = fixture();
    const job = f.job();
    f.agentExecute.mockImplementationOnce((input) =>
      Promise.resolve({
        ...agentOutput(input),
        isolation: isolation(randomUUID())
      })
    );
    await expect(f.worker.execute(job)).rejects.toThrow(/unconfirmed job isolation/u);
    const call = f.agentExecute.mock.calls[0]?.[0];
    if (!call) throw new Error("Missing fixture call.");
    expect(existsSync(call.workspace.root)).toBe(true);
    await f.worker.recover(job);
    const small = f.job();
    await expect(
      f.worker.execute(
        encodeCanonicalDocument({
          ...small.value,
          limits: { ...small.value.limits, maximumResultBytes: 1 }
        })
      )
    ).rejects.toThrow(/transfer budget/u);
    f.agentExecute.mockImplementationOnce((input) =>
      Promise.resolve({
        ...agentOutput(input),
        finishedAt: "2026-09-08T12:00:11.000Z"
      })
    );
    await expect(f.worker.execute(f.job())).rejects.toThrow(/differs from its job/u);
    expect(f.git("worktree", "list", "--porcelain").match(/^worktree /gmu)).toHaveLength(1);
  });
});
