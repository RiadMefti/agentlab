import { spawnSync } from "node:child_process";
import { chmodSync, chownSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256DigestSchema } from "@agentlab/contracts";

import { FileFactoryArtifactStore } from "../../packages/runtime/dist/infrastructure/filesystem/file-factory-artifact-store.js";
import { openSqliteDatabase } from "../../packages/runtime/dist/infrastructure/persistence/sqlite-database.js";
import { acquireSqliteWriterLease } from "../../packages/runtime/dist/infrastructure/persistence/sqlite-writer-lease.js";

// Load the real adapters before dropping privileges. All writes remain in a fresh fixture root.
const mappings = readFileSync("/proc/self/uid_map", "utf8")
  .trim()
  .split("\n")
  .map((line) => {
    const fields = line.trim().split(/\s+/u);
    return { inner: Number(fields[0]), outer: Number(fields[1]), count: Number(fields[2]) };
  });
if (
  process.getuid?.() !== 0 ||
  !mappings.some(({ inner, outer, count }) => inner === 0 && outer > 0 && count === 1) ||
  !mappings.some(({ inner, outer, count }) => inner === 1 && outer > 0 && count >= 2)
) {
  throw new Error(
    "This proof requires an unprivileged root-mapped namespace with subordinate IDs."
  );
}

const action = process.argv[2];
if (action === undefined) {
  const root = mkdtempSync(join(tmpdir(), "agentlab-role-storage-proof-"));
  chownSync(root, 0, 1);
  chmodSync(root, 0o770);
  const invoke = (mode: string, ...args: readonly string[]): unknown => {
    const result = spawnSync(
      process.execPath,
      [fileURLToPath(import.meta.url), mode, root, ...args],
      {
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 1_048_576,
        env: { PATH: "/usr/bin:/bin", NODE_NO_WARNINGS: "1" }
      }
    );
    if (result.error || result.status !== 0) {
      throw new Error(`Storage proof ${mode} failed: ${result.stderr}`, { cause: result.error });
    }
    return JSON.parse(result.stdout) as unknown;
  };
  try {
    const producer = invoke("produce");
    if (typeof producer !== "object" || producer === null || !("artifactDigest" in producer)) {
      throw new Error("Storage proof did not return its artifact identity.");
    }
    const artifactDigest = sha256DigestSchema.parse(producer.artifactDigest);
    const separated = invoke("consume", artifactDigest);
    // Only the disposable fixture changes mode: test why a shared-mode workaround is insufficient.
    chmodSync(join(root, "factory.sqlite"), 0o660);
    chmodSync(join(root, "factory.sqlite.agentlab-writer-lock.sqlite"), 0o660);
    const relaxedDatabaseModes = invoke("consume", artifactDigest);
    process.stdout.write(JSON.stringify({ producer, separated, relaxedDatabaseModes }) + "\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
} else {
  const root = process.argv[3];
  if (
    !["produce", "consume"].includes(action) ||
    typeof root !== "string" ||
    !/^\/tmp\/agentlab-role-storage-proof-[A-Za-z0-9]+$/u.test(root)
  ) {
    throw new Error("Unexpected storage proof action or fixture root.");
  }
  if (
    process.setgroups === undefined ||
    process.setgid === undefined ||
    process.setuid === undefined
  ) {
    throw new Error("Storage proof requires POSIX identity switching.");
  }
  process.setgroups([]);
  process.setgid(1);
  process.setuid(action === "produce" ? 1 : 2);
  const databasePath = join(root, "factory.sqlite");
  const artifactRoot = join(root, "artifacts");
  if (action === "produce") {
    const lease = acquireSqliteWriterLease(databasePath);
    const database = openSqliteDatabase(databasePath);
    let artifact;
    try {
      artifact = await new FileFactoryArtifactStore(artifactRoot).putText("handoff evidence");
    } finally {
      database.close();
      lease.close();
    }
    process.stdout.write(
      JSON.stringify({
        userId: process.getuid(),
        groupId: process.getgid?.(),
        databaseMode: (statSync(databasePath).mode & 0o777).toString(8),
        leaseMode: (statSync(databasePath + ".agentlab-writer-lock.sqlite").mode & 0o777).toString(
          8
        ),
        artifactRootMode: (statSync(artifactRoot).mode & 0o777).toString(8),
        artifactDigest: artifact.digest
      }) + "\n"
    );
  } else {
    const results: Record<string, unknown> = {
      userId: process.getuid(),
      groupId: process.getgid?.()
    };
    const artifactDigest = sha256DigestSchema.parse(process.argv[4]);
    const operations: readonly (readonly [string, () => unknown])[] = [
      [
        "lease",
        () => {
          acquireSqliteWriterLease(databasePath).close();
        }
      ],
      [
        "database",
        () => {
          openSqliteDatabase(databasePath).close();
        }
      ],
      ["artifact", () => new FileFactoryArtifactStore(artifactRoot).readText(artifactDigest, 1_024)]
    ];
    for (const [name, operation] of operations) {
      try {
        await operation();
        results[name] = { accessible: true };
      } catch (error: unknown) {
        results[name] = {
          accessible: false,
          name: error instanceof Error ? error.name : "UnknownError",
          code: typeof error === "object" && error !== null && "code" in error ? error.code : null
        };
      }
    }
    process.stdout.write(JSON.stringify(results) + "\n");
  }
}
