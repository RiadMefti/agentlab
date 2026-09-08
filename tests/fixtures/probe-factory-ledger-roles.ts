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
  immutableTaskContractSchema,
  sha256DigestSchema,
  taskEventSchema
} from "@agentlab/contracts";
import { createLocalFactoryLedger } from "@agentlab/runtime/factory-ledger";
import { createLocalFactoryLedgerClient } from "@agentlab/runtime/factory-ledger-client";
import { z } from "zod";

import { pinnedLocalExecutableDigest } from "../../packages/runtime/dist/infrastructure/filesystem/pinned-local-executable.js";
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
  !mappings.some(([inner, outer, count]) => inner === 1 && (outer ?? 0) > 0 && (count ?? 0) >= 4)
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
  policyDigest: sha256DigestSchema
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
    for (const uid of [2, 3, 4]) {
      const child = spawnSync(
        process.execPath,
        [fileURLToPath(import.meta.url), "client", root, String(uid), JSON.stringify(ready)],
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
    process.stdout.write(JSON.stringify({ ownerUid: 1, clients: results }) + "\n");
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
    !["owner", "client"].includes(mode)
  )
    throw new Error("Unexpected ledger proof arguments.");
  const uid = mode === "owner" ? 1 : Number(process.argv[4]);
  if (![1, 2, 3, 4].includes(uid) || !process.setgroups || !process.setgid || !process.setuid)
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
    maximumBytes: 131_072,
    timeoutMs: 1000
  };
  if (mode === "owner") {
    const rawSeed = process.env.AGENTLAB_LEDGER_PROOF_SEED ?? "";
    if (rawSeed.length < 2 || rawSeed.length > 131_072) throw new Error("Invalid proof seed size.");
    const seed = z
      .strictObject({
        contract: immutableTaskContractSchema,
        event: taskEventSchema,
        evidence: evidenceBundleSchema
      })
      .parse(JSON.parse(rawSeed) as unknown);
    const documents = new NodeFactoryDocumentCodec();
    const contract = documents.taskContract(seed.contract);
    const repository = new SqliteFactoryRepository(databasePath);
    try {
      await repository.create(
        contract,
        documents.taskEvent(seed.event),
        documents.evidenceBundle(seed.evidence)
      );
    } finally {
      repository.close();
    }
    const runtime = await createLocalFactoryLedger({
      schemaVersion: "agentlab.local-factory-ledger.v1",
      databasePath,
      transport,
      policy: {
        schemaVersion: "agentlab.ledger-read-policy.v1",
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
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
          }
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
      policyDigest: runtime.policyDigest
    });
    await Promise.race([stop, runtime.stopped]);
    await runtime.close();
    process.disconnect();
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
      taskRead = task.contractDigest === ready.contractDigest && task.sequence === 1;
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
        directDatabaseDenied,
        directLeaseDenied
      }) + "\n"
    );
  }
}
