import { once } from "node:events";
import { linkSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import { prepareDatabaseTarget } from "../../packages/runtime/src/infrastructure/filesystem/database-target.js";
import { acquireSqliteWriterLease } from "../../packages/runtime/src/infrastructure/persistence/sqlite-writer-lease.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("SQLite writer lease", () => {
  it("canonicalizes relative and symlink spellings to one database identity", () => {
    const root = temporaryRoot();
    const realDirectory = join(root, "real");
    const alias = join(root, "alias");
    writeFileSync(join(root, "placeholder"), "");
    // prepareDatabaseTarget creates missing descendants after canonicalizing the existing ancestor.
    const realPath = prepareDatabaseTarget(join(realDirectory, "state.sqlite"));
    symlinkSync(realDirectory, alias, "dir");

    expect(prepareDatabaseTarget(join(alias, "state.sqlite"))).toBe(realPath);
    expect(prepareDatabaseTarget("state.sqlite", realDirectory)).toBe(realPath);

    const lease = acquireSqliteWriterLease(realPath, { contentionTimeoutMs: 20 });
    try {
      expect(() =>
        acquireSqliteWriterLease(join(alias, "state.sqlite"), { contentionTimeoutMs: 20 })
      ).toThrow("already owns");
    } finally {
      lease.close();
    }
  });

  it("rejects SQLite URIs, hard links, and ambiguous lock aliases before acquisition", () => {
    const root = temporaryRoot();
    const databasePath = join(root, "state.sqlite");
    const hardLink = join(root, "state-hardlink.sqlite");
    writeFileSync(databasePath, "");
    linkSync(databasePath, hardLink);

    expect(() => prepareDatabaseTarget("file:state.sqlite?mode=rwc", root)).toThrow("SQLite URI");
    expect(() => prepareDatabaseTarget(databasePath)).toThrow("Hard-linked database");

    const cleanDatabasePath = join(root, "clean.sqlite");
    const lockTarget = join(root, "foreign-lock.sqlite");
    writeFileSync(lockTarget, "");
    symlinkSync(lockTarget, `${cleanDatabasePath}.agentlab-writer-lock.sqlite`);
    expect(() => acquireSqliteWriterLease(cleanDatabasePath)).toThrow("unambiguous regular file");
  });

  it("enforces bounded exclusive ownership and releases it on close", () => {
    const databasePath = join(temporaryRoot(), "state.sqlite");
    const first = acquireSqliteWriterLease(databasePath, { contentionTimeoutMs: 20 });
    try {
      expect(() => acquireSqliteWriterLease(databasePath, { contentionTimeoutMs: 20 })).toThrow(
        "already owns"
      );
    } finally {
      first.close();
    }

    const next = acquireSqliteWriterLease(databasePath, { contentionTimeoutMs: 20 });
    next.close();
  });

  it("keeps in-memory runtimes isolated", () => {
    const first = acquireSqliteWriterLease(":memory:");
    const second = acquireSqliteWriterLease(":memory:");
    expect(first.databasePath).toBe(":memory:");
    expect(second.databasePath).toBe(":memory:");
    first.close();
    second.close();
  });

  it("lets the kernel release a crashed process lease without stale PID recovery", async () => {
    const databasePath = join(temporaryRoot(), "state.sqlite");
    prepareDatabaseTarget(databasePath);
    const fixture = new URL("../fixtures/hold-writer-lease.mjs", import.meta.url);
    const child = spawn(process.execPath, [fixture.pathname, databasePath], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.setEncoding("utf8");
    try {
      const [chunk] = (await once(child.stdout, "data")) as [string];
      expect(chunk).toContain("ready");
      expect(() => acquireSqliteWriterLease(databasePath, { contentionTimeoutMs: 20 })).toThrow(
        "already owns"
      );
    } finally {
      child.kill("SIGKILL");
      await once(child, "close");
    }

    const recovered = acquireSqliteWriterLease(databasePath, { contentionTimeoutMs: 50 });
    recovered.close();
  });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agentlab-lease-"));
  temporaryRoots.push(root);
  return root;
}
