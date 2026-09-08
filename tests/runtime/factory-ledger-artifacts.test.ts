import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  factoryLedgerArtifactRequestSchema,
  maximumLedgerArtifactBytes,
  type FactoryLedgerArtifactPolicy,
  type FactoryLedgerArtifactRequest,
  type FactoryLedgerReadPolicy
} from "@agentlab/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FactoryLedgerArtifacts } from "../../packages/runtime/src/application/factory-ledger-artifacts.js";
import { FileFactoryArtifactStore } from "../../packages/runtime/src/infrastructure/filesystem/file-factory-artifact-store.js";
import { NodeFactoryArtifactWireCodec } from "../../packages/runtime/src/infrastructure/filesystem/node-factory-artifact-wire-codec.js";
import {
  encodeCanonicalDocument,
  NodeFactoryDocumentCodec
} from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { SqliteFactoryExecutionRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-execution-repository.js";
import { SqliteFactoryLedgerArtifactRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-ledger-artifact-repository.js";
import { SqliteFactoryRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-repository.js";
import { latestSchemaVersion } from "../../packages/runtime/src/infrastructure/persistence/migrations.js";
import { testDigest } from "../helpers/factory.js";
import { ledgerArtifactSeed } from "../helpers/factory-ledger-artifacts.js";

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
const startedAt = "2026-09-08T12:00:00.000Z";

async function fixture(overrides: Partial<FactoryLedgerArtifactPolicy> = {}, count = 1) {
  const root = mkdtempSync(join(tmpdir(), "agentlab-ledger-artifacts-"));
  const path = join(root, "factory.sqlite");
  const tasks = new SqliteFactoryRepository(path);
  const executions = new SqliteFactoryExecutionRepository(path);
  const reservations = new SqliteFactoryLedgerArtifactRepository(path);
  cleanups.push(() => {
    reservations.close();
    executions.close();
    tasks.close();
    rmSync(root, { recursive: true, force: true });
  });
  const codec = new NodeFactoryDocumentCodec();
  const seeds = Array.from({ length: count }, () => ledgerArtifactSeed(startedAt));
  for (const seed of seeds) {
    const [initial, ...rest] = seed.taskEvents;
    await tasks.create(
      codec.taskContract(seed.contract),
      codec.taskEvent(initial),
      codec.evidenceBundle(seed.evidence)
    );
    for (const event of rest) await tasks.append(codec.taskEvent(event));
    const [registered, ...operations] = seed.executionEvents;
    await executions.register(
      codec.executionRun(seed.executionRun),
      codec.executionEvent(registered)
    );
    for (const event of operations) await executions.append(codec.executionEvent(event));
  }
  const grants = seeds.map((seed) => ({
    taskId: seed.contract.taskId,
    contractDigest: codec.taskContract(seed.contract).digest
  }));
  const peerPolicy: FactoryLedgerReadPolicy = {
    schemaVersion: "agentlab.ledger-read-policy.v1",
    expiresAt: "2026-09-08T13:00:00.000Z",
    principals: [
      { uid: 1001, id: "worker", role: "worker", tasks: grants },
      { uid: 1002, id: "broker", role: "broker", tasks: grants },
      { uid: 1003, id: "reviewer", role: "worker", tasks: grants },
      { uid: 1004, id: "gate", role: "worker", tasks: grants }
    ]
  };
  const policy: FactoryLedgerArtifactPolicy = {
    schemaVersion: "agentlab.ledger-artifact-policy.v1",
    expiresAt: peerPolicy.expiresAt,
    maximumArtifactBytes: 1024,
    maximumTaskBytes: 4096,
    maximumTaskArtifacts: 8,
    maximumTotalBytes: 8192,
    maximumTotalArtifacts: 16,
    principals: [
      { uid: 1001, id: "worker", kind: "implementer" },
      { uid: 1002, id: "broker", kind: "reader" },
      { uid: 1003, id: "reviewer", kind: "reviewer" },
      { uid: 1004, id: "gate", kind: "gate-observer" }
    ],
    ...overrides
  };
  const store = new FileFactoryArtifactStore(join(root, "artifacts"));
  const wire = new NodeFactoryArtifactWireCodec();
  const now = vi.fn(() => startedAt);
  const dependencies = {
    peerPolicy,
    peerPolicyDigest: encodeCanonicalDocument(peerPolicy).digest,
    policy,
    policyDigest: encodeCanonicalDocument(policy).digest,
    contexts: {
      task: (taskId: string) => tasks.findById(taskId),
      execution: (taskId: string) => executions.findByTaskId(taskId)
    },
    repository: reservations,
    artifacts: store,
    wire,
    encode: encodeCanonicalDocument,
    now
  };
  const service = new FactoryLedgerArtifacts(dependencies);
  const envelope = {
    schemaVersion: "agentlab.ledger-artifact-request.v1" as const,
    requestId: randomUUID(),
    peerPolicyDigest: dependencies.peerPolicyDigest,
    artifactPolicyDigest: dependencies.policyDigest
  };
  const request = (
    bytes: Uint8Array,
    index = 0
  ): Extract<FactoryLedgerArtifactRequest, { operation: "artifact.submit" }> => {
    const seed = seeds[index];
    if (!seed) throw new Error("Missing fixture task.");
    const event = seed.executionEvents.at(-1);
    if (event?.kind !== "operation-started") throw new Error("Missing fixture operation.");
    return {
      ...envelope,
      operation: "artifact.submit",
      contentBase64: wire.encodeBase64(bytes),
      upload: {
        taskId: seed.contract.taskId,
        contractDigest: codec.taskContract(seed.contract).digest,
        idempotencyKey: randomUUID(),
        expiresAt: "2026-09-08T12:01:00.000Z",
        expectedTaskEventDigest: codec.taskEvent(seed.taskEvents.at(-1)).digest,
        execution: {
          kind: "execution",
          runId: event.runId,
          runDigest: event.runDigest,
          eventDigest: codec.executionEvent(event).digest
        },
        attempt: event.attempt,
        operationId: event.operationId,
        artifact: {
          digest: wire.digest(bytes),
          sizeBytes: bytes.byteLength,
          mediaType: "application/octet-stream"
        }
      }
    };
  };
  return {
    root,
    path,
    tasks,
    executions,
    reservations,
    codec,
    seeds,
    store,
    wire,
    service,
    dependencies,
    envelope,
    request,
    now
  };
}

describe("ledger artifact handoff", () => {
  it("validates the full eight-MiB frame without recursive-pattern stack exhaustion", async () => {
    const f = await fixture();
    const bytes = Buffer.alloc(maximumLedgerArtifactBytes, 0xa7);
    const request = f.request(bytes);
    expect(factoryLedgerArtifactRequestSchema.safeParse(request).success).toBe(true);
    expect(Buffer.from(f.wire.decodeBase64(request.contentBase64)).equals(bytes)).toBe(true);
    expect(
      factoryLedgerArtifactRequestSchema.safeParse({
        ...request,
        contentBase64: `${request.contentBase64}!`
      }).success
    ).toBe(false);
  });

  it("upgrades schema 32 without changing existing task, execution, evidence or authority records", async () => {
    const f = await fixture();
    const seed = f.seeds[0];
    if (seed === undefined) throw new Error("Missing fixture task.");
    const taskId = seed.contract.taskId;
    const before = {
      task: await f.tasks.findById(taskId),
      execution: await f.executions.findByTaskId(taskId),
      evidence: await f.tasks.listEvidence(taskId),
      authority: await f.tasks.state()
    };
    const raw = new DatabaseSync(f.path);
    try {
      raw.exec("DROP TABLE factory_ledger_artifact_reservations; PRAGMA user_version = 32;");
    } finally {
      raw.close();
    }
    const upgraded = new SqliteFactoryLedgerArtifactRepository(f.path);
    try {
      expect({
        task: await f.tasks.findById(taskId),
        execution: await f.executions.findByTaskId(taskId),
        evidence: await f.tasks.listEvidence(taskId),
        authority: await f.tasks.state()
      }).toEqual(before);
      await expect(upgraded.find(1001, randomUUID())).resolves.toBeNull();
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

  it("reads artifacts referenced by existing canonical evidence only for the associated task", async () => {
    const f = await fixture({}, 2);
    const bytes = Buffer.from("existing evidence");
    const artifact = { ...(await f.store.put(bytes)), mediaType: "application/json" };
    const seed = f.seeds[0];
    if (seed === undefined) throw new Error("Missing fixture task.");
    const prior = f.codec.evidenceBundle(seed.evidence);
    const bundle = f.codec.evidenceBundle({
      ...seed.evidence,
      bundleId: randomUUID(),
      sequence: 2,
      previousBundleDigest: prior.digest,
      items: [{ ...seed.evidence.items[0], id: randomUUID(), artifact }]
    });
    await f.tasks.appendEvidence(bundle);
    const request = {
      ...f.envelope,
      operation: "artifact.read",
      taskId: seed.contract.taskId,
      contractDigest: f.codec.taskContract(seed.contract).digest,
      artifactDigest: artifact.digest
    };
    await expect(f.service.execute(1002, request)).resolves.toMatchObject({
      status: "artifact",
      contentBase64: f.wire.encodeBase64(bytes)
    });
    const other = f.seeds[1];
    if (other === undefined) throw new Error("Missing second fixture task.");
    await expect(
      f.service.execute(1002, {
        ...request,
        taskId: other.contract.taskId,
        contractDigest: f.codec.taskContract(other.contract).digest
      })
    ).resolves.toMatchObject({ status: "denied" });
  });

  it("transfers exact binary bytes to a task-authorized broker without advancing task, evidence, or authority", async () => {
    const f = await fixture();
    const bytes = Uint8Array.from([0, 255, 13, 10, 97, 0]);
    const request = f.request(bytes);
    const before = await f.tasks.findById(request.upload.taskId);
    const first = await f.service.execute(1001, request);
    expect(first).toMatchObject({ status: "reservation", stored: true });
    if (first.status !== "reservation") throw new Error("Expected reservation.");
    await expect(f.service.execute(1001, request)).resolves.toMatchObject({
      reservationDigest: first.reservationDigest
    });
    await expect(
      f.service.execute(1002, {
        ...f.envelope,
        operation: "artifact.read",
        taskId: request.upload.taskId,
        contractDigest: request.upload.contractDigest,
        artifactDigest: request.upload.artifact.digest
      })
    ).resolves.toMatchObject({
      status: "artifact",
      contentBase64: f.wire.encodeBase64(bytes),
      artifact: request.upload.artifact
    });
    expect(await f.tasks.findById(request.upload.taskId)).toEqual(before);
    expect(await f.tasks.listEvidence(request.upload.taskId)).toHaveLength(1);
    expect(await f.tasks.state()).toEqual({
      scheduler: false,
      prBroker: false,
      mergeBroker: false
    });
  });

  it("rejects role confusion, wrong pins, fake attempts and unassociated digest reads", async () => {
    const f = await fixture();
    const request = f.request(Buffer.from("claim"));
    const puts = vi.spyOn(f.store, "put");
    for (const uid of [1002, 1003, 1004, 1005])
      await expect(f.service.execute(uid, request)).resolves.toMatchObject({ status: "denied" });
    for (const input of [
      { ...request, actor: "gate-observer" },
      { ...request, artifactPolicyDigest: testDigest("a") },
      { ...request, peerPolicyDigest: testDigest("b") },
      { ...request, upload: { ...request.upload, attempt: 2 } },
      { ...request, upload: { ...request.upload, expectedTaskEventDigest: testDigest("d") } },
      { ...request, upload: { ...request.upload, operationId: randomUUID() } },
      {
        ...request,
        upload: {
          ...request.upload,
          execution: { ...request.upload.execution, eventDigest: testDigest("e") }
        }
      }
    ])
      await expect(f.service.execute(1001, input)).resolves.toMatchObject({ status: "denied" });
    await f.store.put(Buffer.from("unassociated"));
    await expect(
      f.service.execute(1002, {
        ...f.envelope,
        operation: "artifact.read",
        taskId: request.upload.taskId,
        contractDigest: request.upload.contractDigest,
        artifactDigest: f.wire.digest(Buffer.from("unassociated"))
      })
    ).resolves.toMatchObject({ status: "denied" });
    expect(puts).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed bytes, wrong digests, size mismatches, path fields and overlong deadlines", async () => {
    const f = await fixture();
    const request = f.request(Buffer.from("A"));
    for (const input of [
      { ...request, contentBase64: "Qf==" },
      { ...request, contentBase64: "../etc/passwd" },
      { ...request, path: "/tmp/target" },
      {
        ...request,
        upload: {
          ...request.upload,
          artifact: { ...request.upload.artifact, digest: testDigest("e") }
        }
      },
      {
        ...request,
        upload: { ...request.upload, artifact: { ...request.upload.artifact, sizeBytes: 2 } }
      },
      { ...request, upload: { ...request.upload, expiresAt: "2026-09-08T12:03:00.000Z" } }
    ])
      await expect(f.service.execute(1001, input)).resolves.toMatchObject({ status: "denied" });
    await expect(f.reservations.find(1001, request.upload.idempotencyKey)).resolves.toBeNull();
  });

  it("keeps a failed delivery charged and reconciles it by the same key", async () => {
    const f = await fixture({ maximumTaskArtifacts: 1 });
    const request = f.request(Buffer.from("content"));
    vi.spyOn(f.store, "put").mockRejectedValueOnce(new Error("injected disk failure"));
    await expect(f.service.execute(1001, request)).rejects.toThrow(/injected disk/u);
    const reservation = await f.reservations.find(1001, request.upload.idempotencyKey);
    if (!reservation) throw new Error("Expected held reservation.");
    const receipt = {
      ...f.envelope,
      operation: "artifact.receipt",
      taskId: request.upload.taskId,
      contractDigest: request.upload.contractDigest,
      idempotencyKey: request.upload.idempotencyKey,
      intentDigest: reservation.value.intentDigest
    };
    await expect(f.service.execute(1001, receipt)).resolves.toMatchObject({ stored: false });
    await expect(
      f.service.execute(1002, {
        ...f.envelope,
        operation: "artifact.read",
        taskId: request.upload.taskId,
        contractDigest: request.upload.contractDigest,
        artifactDigest: request.upload.artifact.digest
      })
    ).resolves.toMatchObject({ status: "denied" });
    await expect(f.service.execute(1001, f.request(Buffer.from("another")))).resolves.toMatchObject(
      { status: "denied" }
    );
    await expect(f.service.execute(1001, request)).resolves.toMatchObject({
      stored: true,
      reservationDigest: reservation.digest
    });
    await expect(f.service.execute(1001, receipt)).resolves.toMatchObject({
      stored: true,
      reservationDigest: reservation.digest
    });
  });

  it("reconciles delivery after a lost reply and after reopening the database and store", async () => {
    const f = await fixture();
    const request = f.request(Buffer.from("durable"));
    const originalPut = f.store.put.bind(f.store);
    vi.spyOn(f.store, "put").mockImplementationOnce(async (bytes) => {
      await originalPut(bytes);
      throw new Error("reply lost");
    });
    await expect(f.service.execute(1001, request)).rejects.toThrow(/reply lost/u);
    const reopened = new SqliteFactoryLedgerArtifactRepository(f.path);
    try {
      const reservation = await reopened.find(1001, request.upload.idempotencyKey);
      if (!reservation) throw new Error("Expected reservation.");
      const service = new FactoryLedgerArtifacts({
        ...f.dependencies,
        repository: reopened,
        artifacts: new FileFactoryArtifactStore(join(f.root, "artifacts"))
      });
      f.now.mockReturnValue("2026-09-08T12:02:00.000Z");
      await expect(service.execute(1001, request)).resolves.toMatchObject({ status: "denied" });
      await expect(
        service.execute(1001, {
          ...f.envelope,
          operation: "artifact.receipt",
          taskId: request.upload.taskId,
          contractDigest: request.upload.contractDigest,
          idempotencyKey: request.upload.idempotencyKey,
          intentDigest: reservation.value.intentDigest
        })
      ).resolves.toMatchObject({ stored: true });
    } finally {
      reopened.close();
    }
  });

  it("enforces cumulative byte quotas across tasks as well as per task", async () => {
    const f = await fixture(
      { maximumArtifactBytes: 4, maximumTaskBytes: 4, maximumTotalBytes: 6 },
      2
    );
    await expect(f.service.execute(1001, f.request(Buffer.from("1234")))).resolves.toMatchObject({
      stored: true
    });
    await expect(f.service.execute(1001, f.request(Buffer.from("x")))).resolves.toMatchObject({
      status: "denied"
    });
    await expect(f.service.execute(1001, f.request(Buffer.from("abc"), 1))).resolves.toMatchObject({
      status: "denied"
    });
    await expect(f.service.execute(1001, f.request(Buffer.from("ab"), 1))).resolves.toMatchObject({
      stored: true
    });
  });

  it("detects tampering and cannot rebind an existing reservation to different content", async () => {
    const f = await fixture();
    const request = f.request(Buffer.from("original"));
    await f.service.execute(1001, request);
    const changed = f.request(Buffer.from("changed!"));
    await expect(
      f.service.execute(1001, {
        ...changed,
        upload: { ...changed.upload, idempotencyKey: request.upload.idempotencyKey }
      })
    ).resolves.toMatchObject({ status: "denied" });
    const digest = request.upload.artifact.digest.slice(7);
    writeFileSync(join(f.root, "artifacts", "sha256", digest.slice(0, 2), digest), "tampered");
    await expect(
      f.service.execute(1002, {
        ...f.envelope,
        operation: "artifact.read",
        taskId: request.upload.taskId,
        contractDigest: request.upload.contractDigest,
        artifactDigest: request.upload.artifact.digest
      })
    ).rejects.toThrow(/digest verification/u);
    const raw = new DatabaseSync(f.path);
    try {
      expect(() => {
        raw.exec("DELETE FROM factory_ledger_artifact_reservations");
      }).toThrow(/immutable/u);
    } finally {
      raw.close();
    }
  });
});
