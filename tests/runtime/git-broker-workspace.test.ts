import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GitBrokerWorkspace } from "../../packages/runtime/src/infrastructure/github/git-broker-workspace.js";
import { NodeCommandRunner } from "../../packages/runtime/src/infrastructure/process/command-runner.js";

const temporaryRoots: string[] = [];
const gitExecutable = execFileSync("which", ["git"], { encoding: "utf8" }).trim();

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("GitBrokerWorkspace", () => {
  it("rebuilds an exact one-commit proposal from authorized patch bytes", async () => {
    const fixture = repositoryFixture();
    writeFileSync(join(fixture.repository, "tracked.txt"), "changed\n", "utf8");
    const patch = git(fixture.repository, ["diff", "--binary", "--full-index", "--no-ext-diff"]);
    const workspace = brokerWorkspace(fixture.factoryRoot);

    const prepared = await workspace.prepare({
      repositoryRoot: fixture.repository,
      baseRevision: fixture.baseRevision,
      patch,
      patchMaximumBytes: 100_000,
      expectedChangeSet: {
        baseRevision: fixture.baseRevision,
        headRevision: null,
        changedPaths: ["tracked.txt"],
        binaryPaths: [],
        changedFiles: 1,
        changedLines: 2
      },
      title: "test: broker exact patch",
      timestamp: "2026-08-30T12:00:00.000Z"
    });

    expect(prepared.headRevision).toMatch(/^[0-9a-f]{40}$/u);
    expect(git(prepared.root, ["rev-parse", "HEAD^"]).trim()).toBe(fixture.baseRevision);
    expect(git(prepared.root, ["show", "HEAD:tracked.txt"])).toBe("changed\n");

    const ownedPath = prepared.root;
    await prepared.close();
    expect(existsSync(ownedPath)).toBe(false);
  });

  it("fails closed when the independently observed change set differs", async () => {
    const fixture = repositoryFixture();
    writeFileSync(join(fixture.repository, "tracked.txt"), "changed\n", "utf8");
    const patch = git(fixture.repository, ["diff", "--binary", "--full-index", "--no-ext-diff"]);

    await expect(
      brokerWorkspace(fixture.factoryRoot).prepare({
        repositoryRoot: fixture.repository,
        baseRevision: fixture.baseRevision,
        patch,
        patchMaximumBytes: 100_000,
        expectedChangeSet: {
          baseRevision: fixture.baseRevision,
          headRevision: null,
          changedPaths: ["tracked.txt"],
          binaryPaths: [],
          changedFiles: 1,
          changedLines: 1
        },
        title: "test: mismatched inventory",
        timestamp: "2026-08-30T12:00:00.000Z"
      })
    ).rejects.toThrow(/does not match the authorized change set/u);
  });

  it("rejects a broad filesystem root", () => {
    expect(() => brokerWorkspace("/")).toThrow(/safe absolute non-root path/u);
  });
});

function brokerWorkspace(root: string): GitBrokerWorkspace {
  return new GitBrokerWorkspace(new NodeCommandRunner(), {
    root,
    gitExecutable,
    authorName: "AgentLab Test Broker",
    authorEmail: "agentlab@example.invalid"
  });
}

function repositoryFixture() {
  const root = mkdtempSync(join(tmpdir(), "agentlab-git-broker-"));
  temporaryRoots.push(root);
  const repository = join(root, "repository");
  const factoryRoot = join(root, "factory");
  git(root, ["init", "--initial-branch=main", repository]);
  git(repository, ["config", "user.name", "AgentLab Test"]);
  git(repository, ["config", "user.email", "agentlab@example.invalid"]);
  writeFileSync(join(repository, "tracked.txt"), "original\n", "utf8");
  git(repository, ["add", "tracked.txt"]);
  git(repository, ["commit", "-m", "initial"]);
  return {
    root,
    repository,
    factoryRoot,
    baseRevision: git(repository, ["rev-parse", "HEAD"]).trim()
  };
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync(gitExecutable, [...args], {
    cwd,
    encoding: "utf8",
    env: {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      PATH: process.env.PATH
    }
  });
}
