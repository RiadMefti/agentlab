import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GitFactoryRepositoryRevisionReader } from "../../packages/runtime/src/infrastructure/filesystem/git-factory-repository-revision.js";
import type {
  CommandRunner,
  RunOptions,
  RunResult
} from "../../packages/runtime/src/infrastructure/process/command-runner.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("GitFactoryRepositoryRevisionReader", () => {
  it("reads an exact commit only after verifying the canonical Git top level", async () => {
    const root = temporaryDirectory();
    const runner = new RevisionRunner(root, "a".repeat(40));
    const reader = new GitFactoryRepositoryRevisionReader(runner, {
      gitExecutable: "/usr/bin/git",
      flockExecutable: "/usr/bin/flock"
    });

    await expect(reader.currentRevision(root)).resolves.toBe("a".repeat(40));
    expect(runner.calls).toHaveLength(2);
    expect(runner.calls[0]?.args).toContain("--show-toplevel");
    expect(runner.calls[1]?.args).toContain("HEAD^{commit}");
    expect(runner.calls.every(({ options }) => options.cleanupProcessTree === true)).toBe(true);
    expect(
      runner.calls.every(({ options }) => options.environment?.GIT_TERMINAL_PROMPT === "0")
    ).toBe(true);
  });

  it("rejects symlinked roots, mismatched top levels, and malformed revisions", async () => {
    const root = temporaryDirectory();
    const link = `${root}-link`;
    temporaryRoots.push(link);
    symlinkSync(root, link, "dir");
    const reader = new GitFactoryRepositoryRevisionReader(
      new RevisionRunner(root, "a".repeat(40)),
      {
        gitExecutable: "/usr/bin/git",
        flockExecutable: "/usr/bin/flock"
      }
    );
    await expect(reader.currentRevision(link)).rejects.toThrow("canonical and symlink-free");

    const wrongRoot = new GitFactoryRepositoryRevisionReader(
      new RevisionRunner(join(root, "nested"), "a".repeat(40)),
      { gitExecutable: "/usr/bin/git", flockExecutable: "/usr/bin/flock" }
    );
    await expect(wrongRoot.currentRevision(root)).rejects.toThrow("Git top level");

    const malformed = new GitFactoryRepositoryRevisionReader(
      new RevisionRunner(root, "not-a-sha"),
      {
        gitExecutable: "/usr/bin/git",
        flockExecutable: "/usr/bin/flock"
      }
    );
    await expect(malformed.currentRevision(root)).rejects.toThrow();
  });
});

class RevisionRunner implements CommandRunner {
  public readonly calls: {
    readonly executable: string;
    readonly args: readonly string[];
    readonly options: RunOptions;
  }[] = [];

  public constructor(
    private readonly topLevel: string,
    private readonly revision: string
  ) {}

  public run(
    executable: string,
    args: readonly string[],
    options: RunOptions = {}
  ): Promise<RunResult> {
    this.calls.push({ executable, args, options });
    return Promise.resolve({
      stdout: args.includes("--show-toplevel") ? `${this.topLevel}\n` : `${this.revision}\n`,
      stderr: ""
    });
  }
}

function temporaryDirectory(): string {
  const root = mkdtempSync(join(tmpdir(), "agentlab-factory-revision-"));
  temporaryRoots.push(root);
  return root;
}
