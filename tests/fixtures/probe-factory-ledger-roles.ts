import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  chownSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  evidenceBundleSchema,
  factoryExecutionRunSchema,
  factoryExecutionEventSchema,
  factoryLedgerArtifactExecutionSchema,
  immutableTaskContractSchema,
  maximumLedgerArtifactBytes,
  sha256DigestSchema,
  taskEventSchema
} from "@agentlab/contracts";
import { createLocalFactoryLedger } from "@agentlab/runtime/factory-ledger";
import { createLocalFactoryLedgerClient } from "@agentlab/runtime/factory-ledger-client";
import { createLocalFactoryLedgerOperator } from "@agentlab/runtime/factory-ledger-operator";
import { createLocalFactoryLedgerArtifacts } from "@agentlab/runtime/factory-ledger-artifacts";
import { z } from "zod";

import { pinnedLocalExecutableDigest } from "../../packages/runtime/dist/infrastructure/filesystem/pinned-local-executable.js";
import { FileFactoryArtifactStore } from "../../packages/runtime/dist/infrastructure/filesystem/file-factory-artifact-store.js";
import { SqliteFactoryExecutionRepository } from "../../packages/runtime/dist/infrastructure/persistence/sqlite-factory-execution-repository.js";
import { NodeFactoryDocumentCodec } from "../../packages/runtime/dist/infrastructure/persistence/canonical-factory-documents.js";
import { openSqliteDatabase } from "../../packages/runtime/dist/infrastructure/persistence/sqlite-database.js";
import { SqliteFactoryRepository } from "../../packages/runtime/dist/infrastructure/persistence/sqlite-factory-repository.js";
import { acquireSqliteWriterLease } from "../../packages/runtime/dist/infrastructure/persistence/sqlite-writer-lease.js";
import { requestLinuxLedgerPeer } from "../../packages/runtime/dist/infrastructure/process/linux-ledger-peer-transport.js";

// Import actual built adapters before dropping credentials; never run this proof as host root.
const mappings = readFileSync("/proc/self/uid_map", "utf8")
  .trim()
  .split("\n")
  .map((line) => line.trim().split(/\s+/u).map(Number));
if (
  process.getuid?.() !== 0 ||
  !mappings.some(([inner, outer, count]) => inner === 0 && (outer ?? 0) > 0 && count === 1) ||
  !mappings.some(([inner, outer, count]) => inner === 1 && (outer ?? 0) > 0 && (count ?? 0) >= 5)
) {
  throw new Error(
    "Ledger proof requires an unprivileged root-mapped namespace with subordinate IDs."
  );
}

function stopOwnedProcessGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGTERM");
  } catch (error: unknown) {
    if (!(
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ESRCH"
    )) {
      throw new Error("Failed to stop the test-owned ledger process group.", { cause: error });
    }
  }
}

const readySchema = z.strictObject({
  taskId: z.uuid(),
  contractDigest: sha256DigestSchema,
  policyDigest: sha256DigestSchema,
  authorityPolicyDigest: sha256DigestSchema,
  artifactPolicyDigest: sha256DigestSchema,
  taskSequence: z.number().int().positive(),
  taskEventDigest: sha256DigestSchema,
  execution: factoryLedgerArtifactExecutionSchema,
  operationId: z.uuid()
});
const mode = process.argv[2];
if (mode === undefined) {
  const root = mkdtempSync(join(tmpdir(), "agentlab-ledger-role-proof-"));
  chmodSync(root, 0o755);
  mkdirSync(join(root, "owner"), { mode: 0o755 });
  chownSync(join(root, "owner"), 1, 1);
  // Host root is unmapped in this namespace. Pin a private, namespace-root-owned interpreter copy.
  copyFileSync(realpathSync("/usr/bin/python3"), join(root, "python"));
  chownSync(join(root, "python"), 0, 0);
  chmodSync(join(root, "python"), 0o755);
  const owner = spawn(process.execPath, [fileURLToPath(import.meta.url), "owner", root], {
    detached: true,
    stdio: ["ignore", "ignore", "pipe", "ipc"],
    env: {
      PATH: "/usr/bin:/bin",
      NODE_NO_WARNINGS: "1",
      AGENTLAB_LEDGER_PROOF_SEED: process.env.AGENTLAB_LEDGER_PROOF_SEED ?? ""
    }
  });
  let diagnostics = "";
  owner.stderr?.on("data", (bytes: Buffer) => {
    diagnostics = (diagnostics + bytes.toString("utf8")).slice(-4096);
  });
  const closed = new Promise<number | null>((resolve) => {
    owner.once("exit", resolve);
  });
  try {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ready = await new Promise<z.infer<typeof readySchema>>((resolve, reject) => {
      timer = setTimeout(() => {
        reject(new Error("Ledger owner startup deadline."));
      }, 10_000);
      owner.once("error", reject);
      owner.once("exit", () => {
        reject(new Error(`Ledger owner exited before readiness: ${diagnostics}`));
      });
      owner.once("message", (value: unknown) => {
        try {
          resolve(readySchema.parse(value));
        } catch (error: unknown) {
          reject(new Error("Invalid ledger readiness response.", { cause: error }));
        }
      });
    }).finally(() => {
      clearTimeout(timer);
    });
    const results: unknown[] = [];
    for (const uid of [2, 3, 4, 5]) {
      const child = spawnSync(
        process.execPath,
        [
          fileURLToPath(import.meta.url),
          uid === 5 ? "operator" : "client",
          root,
          String(uid),
          JSON.stringify(ready)
        ],
        {
          encoding: "utf8",
          timeout: 10_000,
          killSignal: "SIGKILL",
          maxBuffer: 1_048_576,
          env: { PATH: "/usr/bin:/bin", NODE_NO_WARNINGS: "1" }
        }
      );
      if (child.error || child.status !== 0)
        throw new Error(`Ledger client proof failed: ${child.stderr}`, { cause: child.error });
      results.push(JSON.parse(child.stdout) as unknown);
    }
    owner.send("close");
    if ((await closed) !== 0) throw new Error(`Ledger owner shutdown failed: ${diagnostics}`);
    process.stdout.write(
      JSON.stringify({ ownerUid: 1, clients: results.slice(0, 3), operator: results[3] }) + "\n"
    );
  } finally {
    if (owner.pid !== undefined) {
      stopOwnedProcessGroup(owner.pid);
    }
    await closed;
    rmSync(root, { recursive: true, force: true });
  }
} else {
  const root = process.argv[3];
  if (
    typeof root !== "string" ||
    !/^\/tmp\/agentlab-ledger-role-proof-[A-Za-z0-9]+$/u.test(root) ||
    !["owner", "client", "operator"].includes(mode)
  )
    throw new Error("Unexpected ledger proof arguments.");
  const uid = mode === "owner" ? 1 : Number(process.argv[4]);
  if (![1, 2, 3, 4, 5].includes(uid) || !process.setgroups || !process.setgid || !process.setuid)
    throw new Error("Invalid proof identity.");
  process.setgroups([]);
  process.setgid(uid);
  process.setuid(uid);
  const databasePath = join(root, "owner", "factory.sqlite");
  const pythonPath = join(root, "python");
  const transport = {
    pythonPath,
    pythonDigest: await pinnedLocalExecutableDigest(pythonPath, "Proof interpreter"),
    socketPath: join(root, "owner", "ledger.sock"),
    maximumBytes: 16_777_216,
    timeoutMs: 3000
  };
  if (mode === "owner") {
    const rawSeed = process.env.AGENTLAB_LEDGER_PROOF_SEED ?? "";
    if (rawSeed.length < 2 || rawSeed.length > 131_072) throw new Error("Invalid proof seed size.");
    const seed = z
      .strictObject({
        contract: immutableTaskContractSchema,
        taskEvents: z.array(taskEventSchema).min(1),
        evidence: evidenceBundleSchema,
        executionRun: factoryExecutionRunSchema,
        executionEvents: z.array(factoryExecutionEventSchema).min(1)
      })
      .parse(JSON.parse(rawSeed) as unknown);
    const documents = new NodeFactoryDocumentCodec();
    const contract = documents.taskContract(seed.contract);
    const repository = new SqliteFactoryRepository(databasePath);
    try {
      await repository.create(
        contract,
        documents.taskEvent(seed.taskEvents[0]),
        documents.evidenceBundle(seed.evidence)
      );
      for (const event of seed.taskEvents.slice(1))
        await repository.append(documents.taskEvent(event));
    } finally {
      repository.close();
    }
    const executions = new SqliteFactoryExecutionRepository(databasePath);
    try {
      await executions.register(
        documents.executionRun(seed.executionRun),
        documents.executionEvent(seed.executionEvents[0])
      );
      for (const event of seed.executionEvents.slice(1))
        await executions.append(documents.executionEvent(event));
    } finally {
      executions.close();
    }
    const taskEvent = documents.taskEvent(seed.taskEvents.at(-1));
    const operation = documents.executionEvent(seed.executionEvents.at(-1));
    if (operation.value.kind !== "operation-started")
      throw new Error("Fixture operation is inactive.");
    mkdirSync(join(root, "owner", "artifacts"), { mode: 0o700 });
    const policyExpiresAt = new Date(Date.now() + 60_000).toISOString();
    const runtime = await createLocalFactoryLedger({
      schemaVersion: "agentlab.local-factory-ledger.v3",
      databasePath,
      transport,
      artifacts: {
        root: join(root, "owner", "artifacts"),
        policy: {
          schemaVersion: "agentlab.ledger-artifact-policy.v1",
          expiresAt: policyExpiresAt,
          maximumArtifactBytes: maximumLedgerArtifactBytes,
          maximumTaskBytes: maximumLedgerArtifactBytes,
          maximumTaskArtifacts: 8,
          maximumTotalBytes: maximumLedgerArtifactBytes * 2,
          maximumTotalArtifacts: 16,
          principals: [
            { uid: 2, id: "worker", kind: "implementer" },
            { uid: 3, id: "broker", kind: "reader" }
          ]
        }
      },
      authorityPolicy: {
        schemaVersion: "agentlab.ledger-authority-policy.v1",
        expiresAt: policyExpiresAt,
        grants: [
          { uid: 5, id: "maintainer", controls: [{ control: "scheduler", allowEnable: true }] }
        ]
      },
      policy: {
        schemaVersion: "agentlab.ledger-read-policy.v1",
        expiresAt: policyExpiresAt,
        principals: [
          {
            uid: 2,
            id: "worker",
            role: "worker",
            tasks: [{ taskId: contract.value.taskId, contractDigest: contract.digest }]
          },
          {
            uid: 3,
            id: "broker",
            role: "broker",
            tasks: [{ taskId: contract.value.taskId, contractDigest: contract.digest }]
          },
          { uid: 5, id: "maintainer", role: "operator", tasks: [] }
        ]
      }
    });
    const stop = new Promise<void>((resolve) => {
      process.on("message", (value: unknown) => {
        if (value === "close") resolve();
      });
    });
    process.send?.({
      taskId: contract.value.taskId,
      contractDigest: contract.digest,
      policyDigest: runtime.policyDigest,
      authorityPolicyDigest: runtime.authorityPolicyDigest,
      artifactPolicyDigest: runtime.artifactPolicyDigest,
      taskSequence: taskEvent.value.sequence,
      taskEventDigest: taskEvent.digest,
      execution: {
        kind: "execution",
        runId: operation.value.runId,
        runDigest: operation.value.runDigest,
        eventDigest: operation.digest
      },
      operationId: operation.value.operationId
    });
    await Promise.race([stop, runtime.stopped]);
    await runtime.close();
    process.disconnect();
  } else if (mode === "operator") {
    const ready = readySchema.parse(JSON.parse(process.argv[5] ?? "null") as unknown);
    const operator = createLocalFactoryLedgerOperator({
      transport,
      serverUid: 1,
      operatorId: "maintainer",
      peerPolicyDigest: ready.policyDigest,
      authorityPolicyDigest: ready.authorityPolicyDigest
    });
    const before = await operator.inspect();
    const command = {
      idempotencyKey: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      control: "scheduler" as const,
      enabled: true,
      expectedEnabled: before.scheduler.enabled,
      expectedEventDigest: before.scheduler.eventDigest,
      confirmation: "enable-scheduler" as const,
      reason: "Disposable cross-account authority proof."
    };
    const first = await operator.change(command);
    const replay = await operator.change(command);
    const receipt = await operator.receipt(command.idempotencyKey, operator.intentDigest(command));
    await operator.change({
      ...command,
      idempotencyKey: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      expectedEnabled: true,
      expectedEventDigest: first.receipt.head.eventDigest,
      enabled: false,
      confirmation: "disable-scheduler"
    });
    await operator.change(command);
    const stale = await operator.change({
      ...command,
      idempotencyKey: "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
    });
    const after = await operator.inspect();
    let directDatabaseDenied = false;
    let directLeaseDenied = false;
    try {
      openSqliteDatabase(databasePath).close();
    } catch {
      directDatabaseDenied = true;
    }
    try {
      acquireSqliteWriterLease(databasePath).close();
    } catch {
      directLeaseDenied = true;
    }
    process.stdout.write(
      JSON.stringify({
        uid,
        applied: first.receipt.outcome === "applied",
        replayStable:
          first.receiptDigest === replay.receiptDigest &&
          first.receiptDigest === receipt.receiptDigest,
        lateReplayDidNotEnable: !after.scheduler.enabled,
        staleStateRejected: stale.receipt.outcome === "conflict",
        directDatabaseDenied,
        directLeaseDenied
      }) + "\n"
    );
  } else {
    const ready = readySchema.parse(JSON.parse(process.argv[5] ?? "null") as unknown);
    const client = createLocalFactoryLedgerClient({
      transport,
      serverUid: 1,
      peerPolicyDigest: ready.policyDigest
    });
    let taskRead = false;
    let authorityRead = false;
    try {
      const task = await client.readTask(ready.taskId, ready.contractDigest);
      taskRead =
        task.contractDigest === ready.contractDigest && task.sequence === ready.taskSequence;
      const authority = await client.readAuthority();
      authorityRead = !authority.scheduler && !authority.prBroker && !authority.mergeBroker;
    } catch {
      /* Unknown kernel UIDs must fail before any application dispatch. */
    }
    let forgedOperationDenied = false;
    try {
      const response = await requestLinuxLedgerPeer(
        { ...transport, serverUid: 1 },
        new TextEncoder().encode(
          JSON.stringify({
            schemaVersion: "agentlab.ledger-read-request.v1",
            requestId: "99999999-9999-4999-8999-999999999999",
            peerPolicyDigest: ready.policyDigest,
            operation: "authority.enable",
            actor: "operator",
            uid: 1
          })
        )
      );
      const result: unknown = JSON.parse(new TextDecoder().decode(response));
      forgedOperationDenied =
        typeof result === "object" &&
        result !== null &&
        "status" in result &&
        result.status === "denied";
    } catch {
      forgedOperationDenied = uid === 4;
    }
    let authorityChangeDenied = false;
    try {
      const operator = createLocalFactoryLedgerOperator({
        transport,
        serverUid: 1,
        operatorId: "maintainer",
        peerPolicyDigest: ready.policyDigest,
        authorityPolicyDigest: ready.authorityPolicyDigest
      });
      await operator.change({
        idempotencyKey: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        expiresAt: new Date(Date.now() + 30_000).toISOString(),
        control: "scheduler",
        expectedEnabled: false,
        expectedEventDigest: null,
        enabled: true,
        reason: "Attempting an operator-only command from an unauthorized UID.",
        confirmation: "enable-scheduler"
      });
    } catch {
      authorityChangeDenied = true;
    }
    const artifacts = createLocalFactoryLedgerArtifacts({
      transport,
      serverUid: 1,
      principalId: uid === 2 ? "worker" : uid === 3 ? "broker" : "stranger",
      principalKind: "implementer",
      peerPolicyDigest: ready.policyDigest,
      artifactPolicyDigest: ready.artifactPolicyDigest
    });
    const bytes = Buffer.alloc(maximumLedgerArtifactBytes, 0xa7);
    bytes.set([0, 255, 10, 97, 0, 13]);
    const artifact = artifacts.describe(bytes, "application/octet-stream");
    const upload = {
      taskId: ready.taskId,
      contractDigest: ready.contractDigest,
      idempotencyKey: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      expectedTaskEventDigest: ready.taskEventDigest,
      execution: ready.execution,
      attempt: 1,
      operationId: ready.operationId,
      artifact
    };
    let artifactSubmit = false;
    let artifactReplayStable = false;
    let artifactRead = false;
    let directArtifactDenied = false;
    try {
      const stored = await artifacts.submit(upload, bytes);
      artifactSubmit = stored.stored;
      const replay = await artifacts.submit(upload, bytes);
      const receipt = await artifacts.receipt(
        ready.taskId,
        ready.contractDigest,
        upload.idempotencyKey,
        artifacts.intentDigest(upload)
      );
      artifactReplayStable =
        replay.reservationDigest === stored.reservationDigest &&
        receipt.reservationDigest === stored.reservationDigest &&
        receipt.stored;
    } catch {
      /* Only the assigned worker may submit for this active operation. */
    }
    try {
      const copied = await artifacts.read(ready.taskId, ready.contractDigest, artifact.digest);
      artifactRead = Buffer.from(copied.bytes).equals(Buffer.from(bytes));
    } catch {
      /* An unknown peer must not read any artifact bytes. */
    }
    try {
      await new FileFactoryArtifactStore(join(root, "owner", "artifacts")).read(
        artifact.digest,
        bytes.byteLength
      );
    } catch {
      directArtifactDenied = true;
    }
    let directDatabaseDenied = false;
    let directLeaseDenied = false;
    try {
      openSqliteDatabase(databasePath).close();
    } catch {
      directDatabaseDenied = true;
    }
    try {
      acquireSqliteWriterLease(databasePath).close();
    } catch {
      directLeaseDenied = true;
    }
    process.stdout.write(
      JSON.stringify({
        uid,
        taskRead,
        authorityRead,
        forgedOperationDenied,
        authorityChangeDenied,
        artifactSubmit,
        artifactReplayStable,
        artifactRead,
        directArtifactDenied,
        directDatabaseDenied,
        directLeaseDenied
      }) + "\n"
    );
  }
}
