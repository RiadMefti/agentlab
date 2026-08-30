import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileFactoryArtifactStore } from "../../packages/runtime/src/infrastructure/filesystem/file-factory-artifact-store.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("FileFactoryArtifactStore", () => {
  it("rejects a filesystem root before changing its permissions", () => {
    expect(() => new FileFactoryArtifactStore("/")).toThrow(/dedicated non-root path/u);
  });

  it("atomically publishes owner-only content and verifies every read", async () => {
    const root = temporaryRoot("agentlab-artifacts-");
    const store = new FileFactoryArtifactStore(root);
    const content = Buffer.from("durable evidence", "utf8");

    const [first, second] = await Promise.all([store.put(content), store.put(content)]);

    expect(first).toEqual(second);
    expect(Buffer.from(await store.read(first.digest, 1_024)).toString("utf8")).toBe(
      "durable evidence"
    );
    const target = artifactPath(root, first.digest);
    expect(readFileSync(target)).toEqual(content);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(target).mode & 0o777).toBe(0o600);
  });

  it("reopens an existing content-addressed store after restart", async () => {
    const root = temporaryRoot("agentlab-artifact-restart-");
    const stored = await new FileFactoryArtifactStore(root).putText("restart-safe evidence");
    const reopened = new FileFactoryArtifactStore(root);

    await expect(reopened.readText(stored.digest, 1_024)).resolves.toBe("restart-safe evidence");
    await expect(reopened.putText("restart-safe evidence")).resolves.toEqual(stored);
  });

  it("rejects oversize writes and corrupted existing content", async () => {
    const root = temporaryRoot("agentlab-artifact-corruption-");
    const store = new FileFactoryArtifactStore(root, { maximumArtifactBytes: 8 });
    await expect(store.put(Buffer.from("too many bytes", "utf8"))).rejects.toThrow(/store limit/u);

    const content = Buffer.from("evidence", "utf8");
    const stored = await store.put(content);
    writeFileSync(artifactPath(root, stored.digest), Buffer.from("tampered", "utf8"));

    await expect(store.read(stored.digest, 8)).rejects.toThrow(/digest verification/u);
    await expect(store.put(content)).rejects.toThrow(/conflicting content/u);
  });

  it("rejects symbolic-link aliases and artifact targets", async () => {
    const parent = temporaryRoot("agentlab-artifact-links-");
    const realRoot = join(parent, "real");
    const aliasRoot = join(parent, "alias");
    mkdirSync(realRoot);
    chmodSync(realRoot, 0o755);
    symlinkSync(realRoot, aliasRoot);

    const aliased = new FileFactoryArtifactStore(aliasRoot);
    await expect(aliased.put(Buffer.from("blocked", "utf8"))).rejects.toThrow(
      /symbolic-link alias/u
    );
    expect(statSync(realRoot).mode & 0o777).toBe(0o755);

    const safeRoot = join(parent, "safe");
    const content = Buffer.from("linked", "utf8");
    const digest = digestOf(content);
    const target = artifactPath(safeRoot, digest);
    mkdirSync(join(safeRoot, "sha256", digest.slice(7, 9)), { recursive: true });
    const outside = join(parent, "outside");
    writeFileSync(outside, content);
    symlinkSync(outside, target);

    const store = new FileFactoryArtifactStore(safeRoot);
    await expect(store.put(content)).rejects.toThrow();
    await expect(store.read(digest, 1_024)).rejects.toThrow();
  });
});

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function digestOf(content: Uint8Array): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function artifactPath(root: string, digest: string): string {
  const hexadecimal = digest.slice(7);
  return join(root, "sha256", hexadecimal.slice(0, 2), hexadecimal);
}
