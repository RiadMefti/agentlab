import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  FactoryLedgerArtifactPolicy,
  FactoryLedgerOperationPolicy,
  FactoryLedgerReadPolicy
} from "@agentlab/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FactoryLedgerArtifacts } from "../../packages/runtime/src/application/factory-ledger-artifacts.js";
import { FactoryLedgerOperationQueue } from "../../packages/runtime/src/application/factory-ledger-operation-queue.js";
import { FileFactoryArtifactStore } from "../../packages/runtime/src/infrastructure/filesystem/file-factory-artifact-store.js";
import { NodeFactoryArtifactWireCodec } from "../../packages/runtime/src/infrastructure/filesystem/node-factory-artifact-wire-codec.js";
import {
  encodeCanonicalDocument,
  NodeFactoryDocumentCodec
} from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { latestSchemaVersion } from "../../packages/runtime/src/infrastructure/persistence/migrations.js";
import { SqliteFactoryExecutionRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-execution-repository.js";
import { SqliteFactoryLedgerArtifactRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-ledger-artifact-repository.js";
import { SqliteFactoryLedgerOperationQueue } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-ledger-operation-queue.js";
import { SqliteFactoryRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-repository.js";
import { testDigest } from "../helpers/factory.js";
import {
  ledgerOperationResult,
  ledgerOperationSeed
} from "../helpers/factory-ledger-operations.js";

const createdAt = "2026-09-08T12:00:00.000Z";
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

async function fixture(overrides: Partial<FactoryLedgerOperationPolicy> = {}, count = 1) {
  const root = mkdtempSync(join(tmpdir(), "agentlab-operation-queue-"));
  const path = join(root, "ledger.sqlite");
  const tasks = new SqliteFactoryRepository(path);
  const executions = new SqliteFactoryExecutionRepository(path);
  const reservations = new SqliteFactoryLedgerArtifactRepository(path);
  const repository = new SqliteFactoryLedgerOperationQueue(path);
  cleanups.push(() => {
    repository.close();
    reservations.close();
    executions.close();
    tasks.close();
    rmSync(root, { recursive: true, force: true });
  });
  const codec = new NodeFactoryDocumentCodec();
  const seeds = Array.from({ length: count }, () => ledgerOperationSeed(createdAt));
  for (const seed of seeds) {
    await tasks.create(
      codec.taskContract(seed.contract),
      codec.taskEvent(seed.taskEvents[0]),
      codec.evidenceBundle(seed.evidence)
    );
    for (const event of seed.taskEvents.slice(1)) await tasks.append(codec.taskEvent(event));
    await executions.register(
      codec.executionRun(seed.executionRun),
      codec.executionEvent(seed.executionEvents[0])
    );
    for (const event of seed.executionEvents.slice(1))
      await executions.append(codec.executionEvent(event));
  }
  const seed = seeds[0];
  if (seed === undefined) throw new Error("Missing seed.");
  const peerPolicy: FactoryLedgerReadPolicy = {
    schemaVersion: "agentlab.ledger-read-policy.v1",
    expiresAt: "2026-09-08T13:00:00.000Z",
    principals: [
      {
        uid: 1001,
        id: "worker",
        role: "worker",
        tasks: seeds.map(({ job }) => ({
          taskId: job.value.taskId,
          contractDigest: job.value.contractDigest
        }))
      },
      { uid: 1002, id: "broker", role: "broker", tasks: [] }
    ]
  };
  const policy: FactoryLedgerOperationPolicy = {
    schemaVersion: "agentlab.ledger-operation-policy.v1",
    expiresAt: peerPolicy.expiresAt,
    maximumTaskJobs: 10,
    maximumTotalJobs: 20,
    maximumStoredJobBytes: 1_048_576,
    principals: [
      { uid: 1001, id: "worker", kind: "implementer", workerPolicyDigest: testDigest("a") }
    ],
    ...overrides
  };
  const artifactPolicy: FactoryLedgerArtifactPolicy = {
    schemaVersion: "agentlab.ledger-artifact-policy.v1",
    expiresAt: peerPolicy.expiresAt,
    maximumArtifactBytes: 65536,
    maximumTaskBytes: 262144,
    maximumTaskArtifacts: 10,
    maximumTotalBytes: 524288,
    maximumTotalArtifacts: 20,
    principals: [{ uid: 1001, id: "worker", kind: "implementer" }]
  };
  const wire = new NodeFactoryArtifactWireCodec();
  const now = vi.fn(() => createdAt);
  const dependencies = {
    peerPolicy,
    peerPolicyDigest: encodeCanonicalDocument(peerPolicy).digest,
    policy,
    policyDigest: encodeCanonicalDocument(policy).digest,
    artifactPolicy,
    artifactPolicyDigest: encodeCanonicalDocument(artifactPolicy).digest,
    contexts: {
      task: (taskId: string) => tasks.findById(taskId),
      execution: (taskId: string) => executions.findByTaskId(taskId)
    },
    repository,
    artifactReservations: reservations,
    artifacts: new FileFactoryArtifactStore(join(root, "artifacts")),
    wire,
    encode: encodeCanonicalDocument,
    now
  };
  const queue = new FactoryLedgerOperationQueue(dependencies);
  const artifacts = new FactoryLedgerArtifacts({
    ...dependencies,
    policy: artifactPolicy,
    policyDigest: encodeCanonicalDocument(artifactPolicy).digest,
    repository: reservations
  });
  const envelope = {
    schemaVersion: "agentlab.ledger-operation-request.v1",
    requestId: randomUUID(),
    peerPolicyDigest: dependencies.peerPolicyDigest,
    operationPolicyDigest: dependencies.policyDigest,
    taskId: seed.job.value.taskId,
    contractDigest: seed.job.value.contractDigest
  };
  const claim = {
    ...envelope,
    operation: "operation.claim",
    jobId: seed.job.value.jobId,
    jobDigest: seed.job.digest,
    invocationId: randomUUID()
  };
  const upload = async (json: string) => {
    const bytes = Buffer.from(json);
    const result = await artifacts.execute(1001, {
      schemaVersion: "agentlab.ledger-artifact-request.v1",
      requestId: randomUUID(),
      peerPolicyDigest: dependencies.peerPolicyDigest,
      artifactPolicyDigest: encodeCanonicalDocument(artifactPolicy).digest,
      operation: "artifact.submit",
      contentBase64: wire.encodeBase64(bytes),
      upload: {
        taskId: seed.job.value.taskId,
        contractDigest: seed.job.value.contractDigest,
        idempotencyKey: randomUUID(),
        expiresAt: seed.job.value.expiresAt,
        expectedTaskEventDigest: seed.job.value.expectedTaskEventDigest,
        execution: seed.job.value.execution,
        attempt: 1,
        operationId: seed.job.value.jobId,
        artifact: {
          digest: wire.digest(bytes),
          sizeBytes: bytes.byteLength,
          mediaType: "application/vnd.agentlab.ledger-operation-result+json"
        }
      }
    });
    if (result.status !== "reservation") throw new Error("Fixture upload denied.");
    return result;
  };
  const report = async (json = ledgerOperationResult(seed.job, now()).json) => {
    const uploaded = await upload(json);
    const snapshot = await repository.find(seed.job.value.jobId);
    return {
      ...envelope,
      operation: "operation.report",
      jobId: seed.job.value.jobId,
      jobDigest: seed.job.digest,
      claimDigest: snapshot?.claim?.digest,
      artifactReservationKey: uploaded.reservation.intent.upload.idempotencyKey,
      artifactReservationDigest: uploaded.reservationDigest
    };
  };
  return {
    root,
    path,
    tasks,
    executions,
    reservations,
    repository,
    codec,
    seeds,
    seed,
    queue,
    dependencies,
    envelope,
    claim,
    upload,
    report,
    now
  };
}

describe("durable ledger operation queue", () => {
  it("claims once, accepts an uploaded result receipt and leaves task/evidence/authority unchanged", async () => {
    const f = await fixture();
    const before = await f.tasks.findById(f.seed.job.value.taskId);
    await f.queue.enqueue(f.seed.job);
    await expect(
      f.queue.execute(1001, { ...f.envelope, operation: "operation.next" })
    ).resolves.toMatchObject({ status: "job", newlyClaimed: false, claim: null });
    await expect(f.queue.execute(1001, f.claim)).resolves.toMatchObject({ newlyClaimed: true });
    await expect(f.queue.execute(1001, f.claim)).resolves.toMatchObject({ newlyClaimed: false });
    const request = await f.report();
    const first = await f.queue.execute(1001, request);
    expect(first).toMatchObject({
      status: "job",
      newlyClaimed: false,
      receipt: { claimDigest: request.claimDigest }
    });
    await expect(f.queue.execute(1001, request)).resolves.toEqual(first);
    await expect(
      f.queue.execute(1001, { ...f.envelope, operation: "operation.next" })
    ).resolves.toMatchObject({ status: "empty" });
    expect(await f.tasks.findById(f.seed.job.value.taskId)).toEqual(before);
    expect(await f.tasks.listEvidence(f.seed.job.value.taskId)).toHaveLength(1);
    expect(await f.tasks.state()).toEqual({
      scheduler: false,
      prBroker: false,
      mergeBroker: false
    });
  });

  it("denies other UIDs, stale pins, caller enqueue and changed operation identities", async () => {
    const f = await fixture();
    await f.queue.enqueue(f.seed.job);
    for (const uid of [1002, 1003])
      await expect(f.queue.execute(uid, f.claim)).resolves.toMatchObject({ status: "denied" });
    for (const input of [
      { ...f.claim, operation: "operation.enqueue", job: f.seed.job.value },
      { ...f.claim, actor: "gate-observer" },
      { ...f.claim, operationPolicyDigest: testDigest("0") },
      { ...f.claim, jobDigest: testDigest("1") },
      { ...f.claim, contractDigest: testDigest("2") }
    ])
      await expect(f.queue.execute(1001, input)).resolves.toMatchObject({ status: "denied" });
    await expect(
      f.queue.enqueue(
        encodeCanonicalDocument({ ...f.seed.job.value, workerPolicyDigest: testDigest("0") })
      )
    ).rejects.toThrow(/assigned/u);
    expect((await f.repository.find(f.seed.job.value.jobId))?.claim).toBeNull();
  });

  it("keeps lost claims consumed across reopening and expiry and blocks another invocation or job", async () => {
    const f = await fixture({}, 2);
    for (const seed of f.seeds) await f.queue.enqueue(seed.job);
    await f.queue.execute(1001, f.claim);
    const reopened = new SqliteFactoryLedgerOperationQueue(f.path);
    try {
      const queue = new FactoryLedgerOperationQueue({ ...f.dependencies, repository: reopened });
      await expect(
        queue.execute(1001, { ...f.claim, invocationId: randomUUID() })
      ).resolves.toMatchObject({ status: "denied" });
      const second = f.seeds[1];
      if (!second) throw new Error("Missing second seed.");
      expect(() =>
        reopened.claim(second.job.value.jobId, second.job.digest, 1001, randomUUID(), f.now)
      ).toThrow(/unresolved/u);
      f.now.mockReturnValue("2026-09-08T12:03:00.000Z");
      await expect(queue.execute(1001, f.claim)).resolves.toMatchObject({
        status: "job",
        newlyClaimed: false
      });
      await expect(
        queue.execute(1001, { ...f.claim, invocationId: randomUUID() })
      ).resolves.toMatchObject({ status: "denied" });
    } finally {
      reopened.close();
    }
  });

  it("skips expired pending candidates instead of hiding a later eligible job", async () => {
    const f = await fixture({}, 2);
    const first = f.seeds[0];
    const second = f.seeds[1];
    if (first === undefined || second === undefined) throw new Error("Missing queue seeds.");
    if (first.job.value.kind !== "agent") throw new Error("Expected an agent fixture job.");
    const expired = encodeCanonicalDocument({
      ...first.job.value,
      expiresAt: "2026-09-08T12:00:50.000Z"
    });
    await f.queue.enqueue(expired);
    const previous = first.executionEvents.at(-1);
    if (previous?.kind !== "operation-started") throw new Error("Missing first operation event.");
    const request = f.codec.agentRunRequest({
      ...first.job.value.request,
      executionId: randomUUID()
    });
    const finished = f.codec.executionEvent({
      ...previous,
      eventId: randomUUID(),
      sequence: previous.sequence + 1,
      previousEventDigest: f.codec.executionEvent(previous).digest,
      kind: "operation-finished",
      from: "operation-active",
      to: "workspace-active",
      result: "failed",
      recordDigest: testDigest("b"),
      reasonCode: "execution-operation-finished"
    });
    const started = f.codec.executionEvent({
      ...previous,
      eventId: randomUUID(),
      sequence: finished.value.sequence + 1,
      previousEventDigest: finished.digest,
      kind: "operation-started",
      from: "workspace-active",
      to: "operation-active",
      operationId: request.value.executionId,
      requestDigest: request.digest,
      reasonCode: "implementer-operation-started"
    });
    await f.executions.append(finished);
    await f.executions.append(started);
    const replacement = encodeCanonicalDocument({
      ...second.job.value,
      jobId: request.value.executionId,
      taskId: first.job.value.taskId,
      contractDigest: first.job.value.contractDigest,
      expectedTaskEventDigest: first.job.value.expectedTaskEventDigest,
      logicalWorkspaceId: first.job.value.logicalWorkspaceId,
      execution: {
        kind: "execution" as const,
        runId: first.job.value.execution.runId,
        runDigest: first.job.value.execution.runDigest,
        eventDigest: started.digest
      },
      request: request.value,
      repository: first.job.value.repository
    });
    await f.queue.enqueue(replacement);
    f.now.mockReturnValue("2026-09-08T12:01:00.000Z");
    await expect(
      f.queue.execute(1001, {
        ...f.envelope,
        taskId: first.job.value.taskId,
        contractDigest: first.job.value.contractDigest,
        operation: "operation.next"
      })
    ).resolves.toMatchObject({ status: "job", job: { jobId: replacement.value.jobId } });
  });

  it("rejects a job whose result cannot fit the currently pinned artifact policy", async () => {
    const f = await fixture();
    const incompatible = encodeCanonicalDocument({
      ...f.seed.job.value,
      limits: { ...f.seed.job.value.limits, maximumResultBytes: 65_537 }
    });
    await expect(f.queue.enqueue(incompatible)).rejects.toThrow(/assigned/u);
  });

  it("rejects a job that outlives the pinned artifact policy", async () => {
    const f = await fixture();
    const artifactPolicy = {
      ...f.dependencies.artifactPolicy,
      expiresAt: "2026-09-08T12:01:00.000Z"
    };
    const queue = new FactoryLedgerOperationQueue({
      ...f.dependencies,
      artifactPolicy,
      artifactPolicyDigest: encodeCanonicalDocument(artifactPolicy).digest
    });
    await expect(queue.enqueue(f.seed.job)).rejects.toThrow(/assigned/u);
  });

  it("retains a result receipt after a lost reply, rejects conflicting results and permits expired reconciliation", async () => {
    const f = await fixture();
    await f.queue.enqueue(f.seed.job);
    await f.queue.execute(1001, f.claim);
    const request = await f.report();
    const original = f.repository.report.bind(f.repository);
    vi.spyOn(f.repository, "report").mockImplementationOnce(async (...args) => {
      await original(...args);
      throw new Error("reply lost");
    });
    await expect(f.queue.execute(1001, request)).rejects.toThrow(/reply lost/u);
    const reopened = new SqliteFactoryLedgerOperationQueue(f.path);
    try {
      const queue = new FactoryLedgerOperationQueue({ ...f.dependencies, repository: reopened });
      const conflicting = await f.report();
      await expect(queue.execute(1001, conflicting)).resolves.toMatchObject({ status: "denied" });
      f.now.mockReturnValue("2026-09-08T12:03:00.000Z");
      await expect(queue.execute(1001, request)).resolves.toMatchObject({
        status: "job",
        receipt: { artifactReservationDigest: request.artifactReservationDigest }
      });
    } finally {
      reopened.close();
    }
  });

  it("denies malformed or unrelated uploaded reports without shutting down the queue", async () => {
    const f = await fixture();
    await f.queue.enqueue(f.seed.job);
    await f.queue.execute(1001, f.claim);
    for (const json of [
      "not json",
      JSON.stringify({ approved: true }),
      ledgerOperationResult({ ...f.seed.job, digest: testDigest("0") }, createdAt).json
    ])
      await expect(f.queue.execute(1001, await f.report(json))).resolves.toMatchObject({
        status: "denied"
      });
    await expect(f.queue.execute(1001, await f.report())).resolves.toMatchObject({
      status: "job",
      receipt: { jobId: f.seed.job.value.jobId }
    });
  });

  it("does not accept an unconfirmed process-cleanup result or release the worker claim", async () => {
    const f = await fixture({}, 2);
    const first = f.seeds[0];
    const second = f.seeds[1];
    if (first === undefined || second === undefined) throw new Error("Missing queue seeds.");
    await f.queue.enqueue(first.job);
    await f.queue.enqueue(second.job);
    await f.queue.execute(1001, f.claim);
    const valid = JSON.parse(ledgerOperationResult(first.job, f.now()).json) as Record<
      string,
      unknown
    >;
    const output = valid.output as Record<string, unknown>;
    const cleanupFailure = encodeCanonicalDocument({
      ...valid,
      output: {
        ...output,
        status: "failed",
        exitCode: null,
        finalOutput: null,
        usageComplete: false,
        errorCode: "process-cleanup-failed"
      }
    });
    await expect(f.queue.execute(1001, await f.report(cleanupFailure.json))).resolves.toMatchObject(
      {
        status: "denied"
      }
    );
    await expect(
      f.queue.execute(1001, {
        ...f.claim,
        taskId: second.job.value.taskId,
        contractDigest: second.job.value.contractDigest,
        jobId: second.job.value.jobId,
        jobDigest: second.job.digest,
        invocationId: randomUUID()
      })
    ).resolves.toMatchObject({ status: "denied" });
    expect((await f.repository.find(first.job.value.jobId))?.receipt).toBeNull();
  });

  it("atomically denies a claim when the task moves after application validation", async () => {
    const f = await fixture();
    await f.queue.enqueue(f.seed.job);
    const original = f.repository.claim.bind(f.repository);
    vi.spyOn(f.repository, "claim").mockImplementationOnce(async (...args) => {
      const previous = f.seed.taskEvents.at(-1);
      if (!previous) throw new Error("Missing event.");
      await f.tasks.append(
        f.codec.taskEvent({
          ...previous,
          eventId: randomUUID(),
          sequence: previous.sequence + 1,
          previousEventDigest: f.codec.taskEvent(previous).digest,
          from: previous.to,
          to: "verifying"
        })
      );
      return original(...args);
    });
    await expect(f.queue.execute(1001, f.claim)).resolves.toMatchObject({ status: "denied" });
    expect((await f.repository.find(f.seed.job.value.jobId))?.claim).toBeNull();
  });

  it("reserves cumulative job count and bytes and does not charge identical enqueue replay twice", async () => {
    const f = await fixture({ maximumTaskJobs: 1, maximumTotalJobs: 1 }, 2);
    await f.queue.enqueue(f.seed.job);
    await f.queue.enqueue(f.seed.job);
    const second = f.seeds[1];
    if (!second) throw new Error("Missing second seed.");
    await expect(f.queue.enqueue(second.job)).rejects.toThrow(/quota/u);
    const tiny = await fixture({ maximumStoredJobBytes: 10 });
    await expect(tiny.queue.enqueue(tiny.seed.job)).rejects.toThrow(/quota/u);
    expect(await tiny.repository.find(tiny.seed.job.value.jobId)).toBeNull();
  });

  it("rolls back failed claim insertion and preserves immutable claim and receipt tables", async () => {
    const f = await fixture();
    await f.queue.enqueue(f.seed.job);
    const raw = new DatabaseSync(f.path);
    try {
      raw.exec(
        "CREATE TRIGGER injected_claim_failure BEFORE INSERT ON factory_ledger_operation_claims BEGIN SELECT RAISE(ABORT, 'injected failure'); END;"
      );
      await expect(f.queue.execute(1001, f.claim)).rejects.toThrow(/injected/u);
      expect((await f.repository.find(f.seed.job.value.jobId))?.claim).toBeNull();
      raw.exec("DROP TRIGGER injected_claim_failure;");
      await f.queue.execute(1001, f.claim);
      expect(() => {
        raw.exec("DELETE FROM factory_ledger_operation_claims");
      }).toThrow(/immutable/u);
      await f.queue.execute(1001, await f.report());
      expect(() => {
        raw.exec("DELETE FROM factory_ledger_operation_receipts");
      }).toThrow(/immutable/u);
      expect(() => {
        raw.exec("UPDATE factory_ledger_operations SET job_digest = 'tampered'");
      }).toThrow(/immutable/u);
      raw.exec(
        "DROP TRIGGER factory_ledger_operation_claims_no_update; UPDATE factory_ledger_operation_claims SET claim_digest = 'tampered';"
      );
      expect(() => f.repository.find(f.seed.job.value.jobId)).toThrow(/projection/u);
    } finally {
      raw.close();
    }
  });

  it("upgrades schema 33 while preserving all existing task and execution coordinates", async () => {
    const f = await fixture();
    const before = await f.tasks.findById(f.seed.job.value.taskId);
    const execution = await f.executions.findByTaskId(f.seed.job.value.taskId);
    const raw = new DatabaseSync(f.path);
    try {
      raw.exec(
        "DROP TABLE factory_ledger_operation_receipts; DROP TABLE factory_ledger_operation_claims; DROP TABLE factory_ledger_operations; PRAGMA user_version = 33;"
      );
    } finally {
      raw.close();
    }
    const upgraded = new SqliteFactoryLedgerOperationQueue(f.path);
    try {
      expect(await f.tasks.findById(f.seed.job.value.taskId)).toEqual(before);
      expect(await f.executions.findByTaskId(f.seed.job.value.taskId)).toEqual(execution);
      const check = new DatabaseSync(f.path);
      try {
        expect(check.prepare("PRAGMA user_version").get()).toMatchObject({
          user_version: latestSchemaVersion
        });
        expect(check.prepare("PRAGMA quick_check").get()).toMatchObject({ quick_check: "ok" });
      } finally {
        check.close();
      }
    } finally {
      upgraded.close();
    }
  });
});
