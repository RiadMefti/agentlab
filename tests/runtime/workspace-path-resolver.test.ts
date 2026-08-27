import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stat } from "node:fs/promises";

import { afterEach, describe, expect, it } from "vitest";

import { LocalWorkspacePathResolver } from "../../packages/runtime/src/infrastructure/filesystem/local-workspace-path-resolver.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agentlab-project-path-"));
  temporaryRoots.push(root);
  return root;
}

describe("LocalWorkspacePathResolver", () => {
  it("returns an actionable bounded failure when path resolution stalls", async () => {
    const resolver = new LocalWorkspacePathResolver("/work", "/home/test", {
      timeoutMs: 10,
      filesystem: {
        realpath: () => new Promise<string>(() => undefined),
        stat
      }
    });

    await expect(resolver.resolve("project")).rejects.toThrow(
      "Folder path resolution timed out. Check that the filesystem is responsive."
    );
  });

  it("bounds folder metadata lookup after canonicalization succeeds", async () => {
    const resolver = new LocalWorkspacePathResolver("/work", "/home/test", {
      timeoutMs: 10,
      filesystem: {
        realpath: () => Promise.resolve("/work/project"),
        stat: () => new Promise(() => undefined)
      }
    });

    await expect(resolver.resolve("project")).rejects.toThrow(
      "Folder metadata lookup timed out. Check that the filesystem is responsive."
    );
  });

  it("accepts an arbitrary absolute folder and preserves spaces in its canonical path", async () => {
    const root = temporaryRoot();
    const folder = join(root, "projects anywhere", "my app");
    mkdirSync(folder, { recursive: true });

    await expect(new LocalWorkspacePathResolver(root, root).resolve(folder)).resolves.toEqual({
      path: folder,
      suggestedName: "my app"
    });
  });

  it("supports relative and home-relative paths and resolves symlinks", async () => {
    const root = temporaryRoot();
    const folder = join(root, "real-project");
    const link = join(root, "linked-project");
    mkdirSync(folder);
    symlinkSync(folder, link, "dir");
    const resolver = new LocalWorkspacePathResolver(root, root);

    await expect(resolver.resolve("linked-project")).resolves.toMatchObject({ path: folder });
    await expect(resolver.resolve("~/linked-project")).resolves.toMatchObject({ path: folder });
  });

  it("rejects files and missing folders with actionable messages", async () => {
    const root = temporaryRoot();
    const file = join(root, "notes.txt");
    writeFileSync(file, "not a project folder");
    const resolver = new LocalWorkspacePathResolver(root, root);

    await expect(resolver.resolve(file)).rejects.toThrow("not a folder");
    await expect(resolver.resolve(join(root, "missing"))).rejects.toThrow("existing folder");
  });
});
