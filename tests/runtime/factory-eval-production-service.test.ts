import { createHash } from "node:crypto";

import type {
  FactoryEvalProductionEvent,
  FactoryEvalProductionJob,
  FactoryEvalSubjectResponse,
  Sha256Digest
} from "@agentlab/contracts";
import { describe, expect, it, vi } from "vitest";

import { FactoryEvalProductionService } from "../../packages/runtime/src/application/factory-eval-production-service.js";
import type { FactoryArtifactStore } from "../../packages/runtime/src/domain/factory-artifact-store.js";
import type {
  FactoryEvalExecutableResolver,
  FactoryEvalHarnessExecutor
} from "../../packages/runtime/src/domain/factory-eval-harness.js";
import { FactoryEvalProcessCleanupUncertainError } from "../../packages/runtime/src/domain/factory-eval-harness.js";
import type {
  FactoryEvalProductionRepository,
  FactoryEvalProductionSnapshot
} from "../../packages/runtime/src/domain/factory-eval-production-repository.js";
import type { CanonicalFactoryDocument } from "../../packages/runtime/src/domain/factory-documents.js";
import { NodeFactoryDocumentCodec } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import {
  testFactoryEvalIsolation,
  testFactoryEvalProductionJob,
  testFactoryEvalUsage
} from "../helpers/factory-eval-production.js";

const documents = new NodeFactoryDocumentCodec();

describe("FactoryEvalProductionService", () => {
  it("produces one complete content-addressed matched run and replays it exactly", async () => {
    const job = testFactoryEvalProductionJob();
    const artifacts = new MemoryArtifacts(job);
    const repository = new MemoryProductions();
    const harness = successfulHarness();
    const createId = idGenerator();
    let now = "2026-09-01T10:30:00.000Z";
    const service = new FactoryEvalProductionService({
      runnerId: job.runnerId,
      productions: repository,
      artifacts,
      executables: executableResolver(job),
      harness,
      recovery: { state: () => Promise.resolve("inactive") },
      documents,
      now: () => now,
      createId
    });
    const digest = documents.evalProductionJob(job).digest;

    await expect(service.preflight(job, digest)).resolves.toEqual({
      jobId: job.jobId,
      jobDigest: digest
    });
    const first = await service.produce(job, digest);
    const second = await service.produce(job, digest);
    now = "2026-09-01T12:00:01.000Z";
    const afterDeadline = await service.produce(job, digest);

    expect(first).toMatchObject({
      status: "completed",
      state: "completed",
      jobId: job.jobId,
      jobDigest: digest,
      sampleCount: job.suite.caseIds.length * job.suite.trialsPerCase,
      reasonCode: "run-produced"
    });
    expect(second).toEqual({ ...first, status: "existing" });
    expect(afterDeadline).toEqual({ ...first, status: "existing" });
    expect(harness.executeSubject).toHaveBeenCalledTimes(first.sampleCount * 2);
    expect(harness.executeGrader).toHaveBeenCalledTimes(first.sampleCount);
    expect(repository.snapshot?.events.at(-1)?.event.kind).toBe("completed");
    const runText = await artifacts.readText(
      first.evalRunArtifact?.digest ?? fail("Missing run artifact."),
      10_000_000
    );
    const run = documents.evalRun(JSON.parse(runText) as unknown);
    expect(run.digest).toBe(first.evalRunDigest);
    expect(run.value.samples).toHaveLength(first.sampleCount);
    expect(run.value.samples[0]).toMatchObject({
      baseline: { taskSuccess: true, safetyPass: true },
      challenger: { taskSuccess: true, safetyPass: true }
    });
  });

  it("fails closed before executing substituted job content or an uninstalled harness", async () => {
    const job = testFactoryEvalProductionJob();
    const digest = documents.evalProductionJob(job).digest;
    const harness = successfulHarness();
    const service = new FactoryEvalProductionService({
      runnerId: job.runnerId,
      productions: new MemoryProductions(),
      artifacts: new MemoryArtifacts(job),
      executables: { resolve: () => Promise.resolve(null) },
      harness,
      recovery: { state: () => Promise.resolve("inactive") },
      documents,
      now: () => "2026-09-01T10:30:00.000Z",
      createId: idGenerator()
    });

    await expect(service.produce(job, `sha256:${"f".repeat(64)}`)).rejects.toThrow(
      /changed after review/u
    );
    const result = await service.produce(job, digest);
    expect(result).toMatchObject({ state: "failed", reasonCode: "executable-invalid" });
    expect(harness.executeSubject).not.toHaveBeenCalled();
  });

  it("preserves failed invocation output and accounts its declared usage", async () => {
    const job = testFactoryEvalProductionJob();
    const artifacts = new MemoryArtifacts(job);
    const repository = new MemoryProductions();
    const implementation = successfulHarness();
    const failedUsage = { ...testFactoryEvalUsage(17), outputBytes: 1_024 };
    const executeSubject = vi.fn<FactoryEvalHarnessExecutor["executeSubject"]>((input) =>
      Promise.resolve({
        status: "failed" as const,
        response: {
          schemaVersion: "agentlab.eval-subject-response.v1" as const,
          status: "failed" as const,
          usage: failedUsage,
          usageComplete: true as const,
          reasonCode: "subject-rejected"
        },
        stdout: new TextEncoder().encode('{"status":"failed"}'),
        stderr: new TextEncoder().encode("rejected"),
        output: null,
        trace: null,
        graderEvidence: null,
        startedAt: "2026-09-01T10:30:00.000Z",
        finishedAt: "2026-09-01T10:30:01.000Z",
        latencyMilliseconds: 1_000,
        isolation: testFactoryEvalIsolation(input.request.executionId),
        errorCode: "subject-rejected"
      })
    );
    const harness = { executeSubject, executeGrader: implementation.executeGrader };
    const service = new FactoryEvalProductionService({
      runnerId: job.runnerId,
      productions: repository,
      artifacts,
      executables: executableResolver(job),
      harness,
      recovery: { state: () => Promise.resolve("inactive") },
      documents,
      now: () => "2026-09-01T10:30:00.000Z",
      createId: idGenerator(400)
    });

    await expect(
      service.produce(job, documents.evalProductionJob(job).digest)
    ).resolves.toMatchObject({
      state: "failed",
      reasonCode: "subject-rejected",
      usage: failedUsage
    });
    const failed = repository.snapshot?.events.at(-1)?.event ?? fail("Missing failure event.");
    expect(failed.evidenceDigest).not.toBeNull();
    const evidence = documents.evalInvocationFailureEvidence(
      JSON.parse(
        await artifacts.readText(
          failed.evidenceDigest ?? fail("Missing failure evidence."),
          1_000_000
        )
      ) as unknown
    );
    expect(evidence.value).toMatchObject({
      phase: "subject",
      status: "failed",
      reasonCode: "subject-rejected",
      reportedUsage: failedUsage,
      accountedUsage: failedUsage
    });
    expect(harness.executeGrader).not.toHaveBeenCalled();
  });

  it("never re-executes a dangling scope and mutates the journal only after confirmed inactivity", async () => {
    const job = testFactoryEvalProductionJob();
    const jobDocument = documents.evalProductionJob(job);
    const executionId = "20000000-0000-4000-8000-000000000100";
    const repository = new MemoryProductions(danglingSnapshot(jobDocument, executionId));
    const harness = successfulHarness();
    const state = vi.fn(() => Promise.resolve<"active" | "inactive">("active"));
    const service = new FactoryEvalProductionService({
      runnerId: job.runnerId,
      productions: repository,
      artifacts: new MemoryArtifacts(job),
      executables: executableResolver(job),
      harness,
      recovery: { state },
      documents,
      now: () => "2026-09-01T10:30:00.000Z",
      createId: idGenerator(500)
    });

    await expect(service.produce(job, jobDocument.digest)).rejects.toThrow(
      /recovery cannot mutate/u
    );
    expect(repository.snapshot?.events.at(-1)?.event.kind).toBe("subject-started");
    expect(harness.executeSubject).not.toHaveBeenCalled();

    state.mockResolvedValue("inactive");
    await expect(service.produce(job, jobDocument.digest)).resolves.toMatchObject({
      state: "failed",
      reasonCode: "interrupted-execution"
    });
    expect(repository.snapshot?.events.at(-1)?.event.kind).toBe("failed");
    expect(harness.executeSubject).not.toHaveBeenCalled();
  });

  it("leaves a launched checkpoint nonterminal when cleanup is uncertain", async () => {
    const job = testFactoryEvalProductionJob();
    const repository = new MemoryProductions();
    const harness = successfulHarness();
    harness.executeSubject.mockRejectedValueOnce(
      new FactoryEvalProcessCleanupUncertainError("cleanup uncertain")
    );
    const state = vi.fn(() => Promise.resolve<"active" | "inactive">("active"));
    const service = new FactoryEvalProductionService({
      runnerId: job.runnerId,
      productions: repository,
      artifacts: new MemoryArtifacts(job),
      executables: executableResolver(job),
      harness,
      recovery: { state },
      documents,
      now: () => "2026-09-01T10:30:00.000Z",
      createId: idGenerator(600)
    });
    const digest = documents.evalProductionJob(job).digest;

    await expect(service.produce(job, digest)).rejects.toThrow(/cleanup uncertain/u);
    expect(repository.snapshot?.events.at(-1)?.event.kind).toBe("subject-started");
    await expect(service.produce(job, digest)).rejects.toThrow(/recovery cannot mutate/u);
    expect(harness.executeSubject).toHaveBeenCalledTimes(1);

    state.mockResolvedValue("inactive");
    await expect(service.produce(job, digest)).resolves.toMatchObject({
      state: "failed",
      reasonCode: "interrupted-execution"
    });
    expect(harness.executeSubject).toHaveBeenCalledTimes(1);
  });

  it("rechecks the immutable deadline before every harness invocation", async () => {
    const job = testFactoryEvalProductionJob();
    const implementation = successfulHarness();
    let allowInvocations = true;
    const executeSubject = vi.fn(
      async (input: Parameters<FactoryEvalHarnessExecutor["executeSubject"]>[0]) => {
        const output = await implementation.executeSubject(input);
        if (input.request.candidateRole === "baseline") allowInvocations = false;
        return output;
      }
    );
    const harness = { executeSubject, executeGrader: implementation.executeGrader };
    const service = new FactoryEvalProductionService({
      runnerId: job.runnerId,
      productions: new MemoryProductions(),
      artifacts: new MemoryArtifacts(job),
      executables: executableResolver(job),
      harness,
      recovery: { state: () => Promise.resolve("inactive") },
      documents,
      now: () => (allowInvocations ? "2026-09-01T10:30:00.000Z" : "2026-09-01T12:00:01.000Z"),
      createId: idGenerator(700)
    });

    await expect(
      service.produce(job, documents.evalProductionJob(job).digest)
    ).resolves.toMatchObject({ state: "failed", reasonCode: "deadline-expired" });
    expect(harness.executeSubject).toHaveBeenCalledTimes(1);
    expect(harness.executeGrader).not.toHaveBeenCalled();
  });
});

class MemoryProductions implements FactoryEvalProductionRepository {
  public snapshot: FactoryEvalProductionSnapshot | null;

  public constructor(snapshot: FactoryEvalProductionSnapshot | null = null) {
    this.snapshot = snapshot;
  }

  public register(
    job: CanonicalFactoryDocument<FactoryEvalProductionJob>,
    event: CanonicalFactoryDocument<FactoryEvalProductionEvent>
  ): Promise<FactoryEvalProductionSnapshot> {
    if (this.snapshot !== null) throw new Error("Duplicate job.");
    this.snapshot = {
      job: job.value,
      jobDigest: job.digest,
      events: [{ event: event.value, eventDigest: event.digest }]
    };
    return Promise.resolve(this.snapshot);
  }

  public append(
    event: CanonicalFactoryDocument<FactoryEvalProductionEvent>
  ): Promise<FactoryEvalProductionSnapshot> {
    if (this.snapshot === null) throw new Error("Missing job.");
    this.snapshot = {
      ...this.snapshot,
      events: [...this.snapshot.events, { event: event.value, eventDigest: event.digest }]
    };
    return Promise.resolve(this.snapshot);
  }

  public findByJobId(jobId: string): Promise<FactoryEvalProductionSnapshot | null> {
    return Promise.resolve(this.snapshot?.job.jobId === jobId ? this.snapshot : null);
  }

  public close(): void {
    // The in-memory test repository owns no external resource.
  }
}

class MemoryArtifacts implements FactoryArtifactStore {
  readonly #values = new Map<Sha256Digest, Uint8Array>();

  public constructor(job: FactoryEvalProductionJob) {
    for (const fixture of job.caseBank.cases.map(({ fixture }) => fixture)) {
      this.#values.set(fixture.digest, new TextEncoder().encode("fixture!"));
    }
  }

  public put(content: Uint8Array) {
    const copy = Uint8Array.from(content);
    const digest = digestBytes(copy);
    this.#values.set(digest, copy);
    return Promise.resolve({ digest, sizeBytes: copy.byteLength });
  }

  public putText(content: string) {
    return this.put(new TextEncoder().encode(content));
  }

  public read(digest: Sha256Digest, maximumBytes: number): Promise<Uint8Array> {
    const value = this.#values.get(digest);
    if (value === undefined) throw new Error(`Missing artifact ${digest}.`);
    if (value.byteLength > maximumBytes) throw new Error("Artifact too large.");
    return Promise.resolve(Uint8Array.from(value));
  }

  public async readText(digest: Sha256Digest, maximumBytes: number): Promise<string> {
    return new TextDecoder().decode(await this.read(digest, maximumBytes));
  }
}

function successfulHarness(): FactoryEvalHarnessExecutor & {
  readonly executeSubject: ReturnType<typeof vi.fn>;
  readonly executeGrader: ReturnType<typeof vi.fn>;
} {
  const executeSubject = vi.fn(
    (input: Parameters<FactoryEvalHarnessExecutor["executeSubject"]>[0]) => {
      const response: FactoryEvalSubjectResponse = {
        schemaVersion: "agentlab.eval-subject-response.v1",
        status: "succeeded",
        usage: testFactoryEvalUsage(input.request.candidateRole === "baseline" ? 10 : 11),
        usageComplete: true,
        reasonCode: null
      };
      return Promise.resolve({
        status: "succeeded" as const,
        response,
        stdout: new TextEncoder().encode("{}"),
        stderr: new Uint8Array(),
        output: new TextEncoder().encode(`${input.request.candidateRole}-output`),
        trace: new TextEncoder().encode(`${input.request.candidateRole}-trace`),
        graderEvidence: null,
        startedAt: "2026-09-01T10:30:00.000Z",
        finishedAt: "2026-09-01T10:30:01.000Z",
        latencyMilliseconds: 1_000,
        isolation: testFactoryEvalIsolation(input.request.executionId),
        errorCode: null
      });
    }
  );
  const executeGrader = vi.fn((input: Parameters<FactoryEvalHarnessExecutor["executeGrader"]>[0]) =>
    Promise.resolve({
      status: "succeeded" as const,
      response: {
        schemaVersion: "agentlab.eval-grader-response.v1" as const,
        status: "succeeded" as const,
        baseline: passingGrade(),
        challenger: passingGrade(),
        usage: testFactoryEvalUsage(0),
        usageComplete: true as const,
        reasonCode: null
      },
      stdout: new TextEncoder().encode("{}"),
      stderr: new Uint8Array(),
      output: null,
      trace: null,
      graderEvidence: new TextEncoder().encode("grade"),
      startedAt: "2026-09-01T10:30:01.000Z",
      finishedAt: "2026-09-01T10:30:02.000Z",
      latencyMilliseconds: 1_000,
      isolation: testFactoryEvalIsolation(input.request.executionId),
      errorCode: null
    })
  );
  return { executeSubject, executeGrader };
}

function executableResolver(job: FactoryEvalProductionJob): FactoryEvalExecutableResolver {
  const entries: readonly (readonly [Sha256Digest, Sha256Digest])[] = [
    [job.baselineHarnessDigest, job.baselineHarness.executableDigest],
    [job.challengerHarnessDigest, job.challengerHarness.executableDigest],
    [job.graderDigest, job.grader.executableDigest]
  ];
  const bindings = new Map(
    entries.map(
      ([descriptorDigest, executableDigest]) =>
        [
          descriptorDigest,
          { descriptorDigest, executable: "/usr/bin/true", executableDigest, version: "1.0.0" }
        ] as const
    )
  );
  return { resolve: (digest) => Promise.resolve(bindings.get(digest) ?? null) };
}

function danglingSnapshot(
  job: CanonicalFactoryDocument<FactoryEvalProductionJob>,
  executionId: string
): FactoryEvalProductionSnapshot {
  const registered = documents.evalProductionEvent({
    ...eventBase(job.value, job.digest),
    eventId: "20000000-0000-4000-8000-000000000010",
    sequence: 1,
    previousEventDigest: null,
    kind: "registered",
    from: null,
    to: "ready",
    occurredAt: job.value.createdAt,
    reasonCode: "job-registered",
    detail: "Registered."
  });
  const started = documents.evalProductionEvent({
    ...eventBase(job.value, job.digest),
    eventId: "20000000-0000-4000-8000-000000000011",
    sequence: 2,
    previousEventDigest: registered.digest,
    kind: "subject-started",
    from: "ready",
    to: "subject-active",
    caseId: job.value.suite.caseIds[0],
    trial: 1,
    candidateRole: "baseline",
    executionId,
    occurredAt: "2026-09-01T10:10:00.000Z",
    reasonCode: "subject-started",
    detail: "Started."
  });
  return {
    job: job.value,
    jobDigest: job.digest,
    events: [
      { event: registered.value, eventDigest: registered.digest },
      { event: started.value, eventDigest: started.digest }
    ]
  };
}

function eventBase(job: FactoryEvalProductionJob, jobDigest: Sha256Digest) {
  return {
    schemaVersion: "agentlab.eval-production-event.v1" as const,
    jobId: job.jobId,
    jobDigest,
    caseId: null,
    trial: null,
    candidateRole: null,
    executionId: null,
    evidenceDigest: null,
    sampleDigest: null,
    evalRunDigest: null,
    evalRunArtifact: null,
    usage: null,
    correlationId: job.correlationId,
    actor: {
      kind: "control-plane" as const,
      role: "gate-runner" as const,
      id: "agentlab-eval-producer",
      sessionId: job.jobId
    }
  };
}

function passingGrade() {
  return {
    taskSuccess: true,
    safetyPass: true,
    criticalSafetyViolation: false,
    falsePositive: false
  };
}

function idGenerator(offset = 1): () => string {
  let next = offset;
  return () => `30000000-0000-4000-8000-${String(next++).padStart(12, "0")}`;
}

function digestBytes(value: Uint8Array): Sha256Digest {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function fail(message: string): never {
  throw new Error(message);
}
