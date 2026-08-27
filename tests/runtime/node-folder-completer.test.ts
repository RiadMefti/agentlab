import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  collectFolderEntries,
  NodeFolderCompleter
} from "../../packages/runtime/src/infrastructure/filesystem/node-folder-completer.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe("NodeFolderCompleter", () => {
  it("preserves absolute, relative, home, and literal-space display forms", async () => {
    const root = await temporaryDirectory();
    const home = join(root, "home");
    const cwd = join(root, "cwd");
    await mkdir(join(home, "Projects", "home folder"), { recursive: true });
    await mkdir(join(cwd, "relative folder"), { recursive: true });
    const completer = new NodeFolderCompleter(cwd, home);

    await expect(completer.complete({ path: "relative ", limit: 6 })).resolves.toContainEqual({
      value: "relative folder/",
      label: "relative folder/",
      symlink: false
    });
    await expect(
      completer.complete({ path: "~/Projects/home ", limit: 6 })
    ).resolves.toContainEqual({
      value: "~/Projects/home folder/",
      label: "~/Projects/home folder/",
      symlink: false
    });
    await expect(
      completer.complete({ path: `${home}/Projects/home `, limit: 6 })
    ).resolves.toContainEqual({
      value: `${home}/Projects/home folder/`,
      label: `${home}/Projects/home folder/`,
      symlink: false
    });
  });

  it("labels directory symlinks and excludes broken and file-targeting symlinks", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, "target"));
    await writeFile(join(root, "file"), "content");
    await symlink(join(root, "target"), join(root, "directory-link"));
    await symlink(join(root, "file"), join(root, "file-link"));
    await symlink(join(root, "missing"), join(root, "broken-link"));
    const completer = new NodeFolderCompleter(root, root);

    const result = await completer.complete({ path: "", limit: 6 });
    expect(result).toEqual([]);
    const links = await completer.complete({ path: "d", limit: 6 });
    expect(links).toContainEqual({
      value: "directory-link/",
      label: "directory-link/ →",
      symlink: true
    });
    expect(
      (await completer.complete({ path: "f", limit: 6 })).map(({ value }) => value)
    ).not.toContain("file-link/");
    expect(
      (await completer.complete({ path: "b", limit: 6 })).map(({ value }) => value)
    ).not.toContain("broken-link/");
  });

  it("does not cache a processing-budget-capped partial scan", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, "alpha"));
    let constrained = true;
    let tick = 0;
    const completer = new NodeFolderCompleter(root, root, () =>
      constrained ? (tick += 30) : 1_000
    );

    await completer.complete({ path: "a", limit: 6 });
    constrained = false;
    await mkdir(join(root, "after-budget"));

    await expect(completer.complete({ path: "after", limit: 6 })).resolves.toContainEqual({
      value: "after-budget/",
      label: "after-budget/",
      symlink: false
    });
  });

  it("bounds stalled directory opens and closes a handle that arrives after the deadline", async () => {
    let releaseOpen: (handle: {
      close(): Promise<void>;
      [Symbol.asyncIterator](): AsyncIterator<never>;
    }) => void = () => undefined;
    let closed = false;
    const pendingOpen = new Promise<{
      close(): Promise<void>;
      [Symbol.asyncIterator](): AsyncIterator<never>;
    }>((resolve) => {
      releaseOpen = resolve;
    });
    const completer = new NodeFolderCompleter("/work", "/home", Date.now, {
      operationTimeoutMs: 5,
      filesystem: {
        opendir: () => pendingOpen,
        stat: () => Promise.reject(new Error("not reached"))
      }
    });

    await expect(completer.complete({ path: "a", limit: 6 })).resolves.toEqual([]);
    releaseOpen({
      close() {
        closed = true;
        return Promise.resolve();
      },
      [Symbol.asyncIterator]() {
        return { next: () => Promise.resolve({ done: true, value: undefined }) };
      }
    });
    await expect.poll(() => closed).toBe(true);
  });

  it("bounds stalled iteration and symlink metadata without caching partial results", async () => {
    let scan = 0;
    const completer = new NodeFolderCompleter("/work", "/home", Date.now, {
      operationTimeoutMs: 5,
      filesystem: {
        opendir: () =>
          Promise.resolve({
            close: () => Promise.resolve(),
            [Symbol.asyncIterator]() {
              let step = 0;
              return {
                next: () => {
                  step += 1;
                  if (scan === 0 && step === 1) {
                    return Promise.resolve({
                      done: false as const,
                      value: entry("linked", false, true)
                    });
                  }
                  if (scan === 0)
                    return new Promise<IteratorResult<ReturnType<typeof entry>>>(() => undefined);
                  return Promise.resolve(
                    step === 1
                      ? { done: false as const, value: entry("later", true, false) }
                      : { done: true as const, value: undefined }
                  );
                }
              };
            }
          }),
        stat: () => new Promise(() => undefined)
      }
    });

    await expect(completer.complete({ path: "l", limit: 6 })).resolves.toEqual([]);
    scan += 1;
    await expect(completer.complete({ path: "l", limit: 6 })).resolves.toContainEqual({
      value: "later/",
      label: "later/",
      symlink: false
    });
  });

  it("matches case predictably while preserving the filesystem spelling", async () => {
    const root = await temporaryDirectory();
    await mkdir(join(root, "MixedCase"));
    const completer = new NodeFolderCompleter(root, root);

    await expect(completer.complete({ path: "mixed", limit: 6 })).resolves.toEqual([
      { value: "MixedCase/", label: "MixedCase/", symlink: false }
    ]);
  });

  it("keeps exactly 32 directories and promotes cache hits before eviction", async () => {
    const opens = new Map<string, number>();
    const completer = new NodeFolderCompleter("/work", "/home", () => 1_000, {
      filesystem: {
        opendir: (path) => {
          opens.set(path, (opens.get(path) ?? 0) + 1);
          return Promise.resolve(directoryHandle([entry("alpha", true, false)]));
        },
        stat: () => Promise.reject(new Error("not reached"))
      }
    });

    for (let index = 0; index < 32; index += 1) {
      await completer.complete({ path: `dir${String(index)}/a`, limit: 6 });
    }
    await completer.complete({ path: "dir0/a", limit: 6 });
    await completer.complete({ path: "dir32/a", limit: 6 });
    await completer.complete({ path: "dir1/a", limit: 6 });
    await completer.complete({ path: "dir0/a", limit: 6 });

    expect(opens.get("/work/dir0")).toBe(1);
    expect(opens.get("/work/dir1")).toBe(2);
  });

  it("stops before entries beyond the 4096-entry scan cap", async () => {
    async function* giantDirectory() {
      await Promise.resolve();
      for (let index = 0; index < 4_096; index += 1) {
        yield entry(`file-${String(index)}`, false, false);
      }
      yield entry("zz-after-cap", true, false);
    }

    const result = await collectFolderEntries(
      giantDirectory(),
      "/unused",
      () => 1_000,
      () => Promise.reject(new Error("No symlinks expected"))
    );
    expect(result.complete).toBe(false);
    expect(result.entries.map(({ name }) => name)).not.toContain("zz-after-cap");
  });
});

function entry(name: string, directory: boolean, symbolicLink: boolean) {
  return {
    name,
    isDirectory: () => directory,
    isSymbolicLink: () => symbolicLink
  };
}

function directoryHandle(entries: readonly ReturnType<typeof entry>[]) {
  return {
    close: () => Promise.resolve(),
    async *[Symbol.asyncIterator]() {
      await Promise.resolve();
      for (const value of entries) yield value;
    }
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "agentlab-completer-"));
  temporaryDirectories.push(directory);
  return directory;
}
