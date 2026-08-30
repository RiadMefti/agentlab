import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { RuntimeResourceOwner } from "../../packages/runtime/src/application/runtime-resource-owner.js";
import { GitFactoryWorkspaceManager } from "../../packages/runtime/src/infrastructure/filesystem/git-factory-workspace.js";
import { NodeCommandRunner } from "../../packages/runtime/src/infrastructure/process/command-runner.js";

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const gitExecutable = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("GitFactoryWorkspaceManager", () => {
  it("rejects a filesystem root before creating worktrees", () => {
    expect(() => workspaceManager("/")).toThrow(/dedicated non-root path/u);
  });

  it("requires an absolute trusted Git executable", () => {
    expect(
      () =>
        new GitFactoryWorkspaceManager(new NodeCommandRunner(), {
          root: "/tmp/agentlab-factory-test",
          gitExecutable: "git",
          createId: () => "00000000-0000-4000-8000-000000000001"
        })
    ).toThrow(/absolute safe path/u);
  });

  it("captures a bounded binary patch from an exact detached base and cleans only its worktree", async () => {
    const fixture = repositoryFixture();
    const owner = new RuntimeResourceOwner();
    const manager = workspaceManager(fixture.factoryRoot, owner);
    const workspace = await manager.create({
      taskId: TASK_ID,
      attempt: 1,
      repositoryRoot: fixture.repository,
      baseRevision: fixture.baseRevision
    });

    writeFileSync(join(workspace.root, "tracked.txt"), "changed\n", "utf8");
    writeFileSync(join(workspace.root, "new.txt"), "new\n", "utf8");
    writeFileSync(join(workspace.root, "binary.bin"), Buffer.from([0, 1, 2, 3]));

    const proposal = await manager.collect(workspace, {
      maximumChangedFiles: 10,
      maximumChangedLines: 20,
      maximumPatchBytes: 1_000_000
    });

    expect(proposal.changeSet).toMatchObject({
      baseRevision: fixture.baseRevision,
      headRevision: null,
      changedFiles: 3,
      changedLines: 3,
      binaryPaths: ["binary.bin"]
    });
    expect(proposal.changeSet.changedPaths).toEqual(["binary.bin", "new.txt", "tracked.txt"]);
    expect(proposal.patch).toContain("GIT binary patch");
    expect(proposal.patch).toContain("diff --git a/tracked.txt b/tracked.txt");

    await workspace.closeAndWait();
    expect(existsSync(workspace.root)).toBe(false);
    expect(git(fixture.repository, ["worktree", "list", "--porcelain"])).not.toContain(
      workspace.root
    );
    await expect(owner.closeAll()).resolves.toBeUndefined();
  });

  it("rejects worker commits and changed-file budget overruns", async () => {
    const fixture = repositoryFixture();
    const manager = workspaceManager(fixture.factoryRoot);
    const workspace = await manager.create({
      taskId: TASK_ID,
      attempt: 1,
      repositoryRoot: fixture.repository,
      baseRevision: fixture.baseRevision
    });
    try {
      writeFileSync(join(workspace.root, "tracked.txt"), "changed\n", "utf8");
      writeFileSync(join(workspace.root, "new.txt"), "new\n", "utf8");
      await expect(
        manager.collect(workspace, {
          maximumChangedFiles: 1,
          maximumChangedLines: 20,
          maximumPatchBytes: 1_000_000
        })
      ).rejects.toThrow(/changed-file budget/u);

      git(workspace.root, ["add", "tracked.txt"]);
      git(workspace.root, ["commit", "-m", "worker commit"]);
      await expect(
        manager.collect(workspace, {
          maximumChangedFiles: 10,
          maximumChangedLines: 20,
          maximumPatchBytes: 1_000_000
        })
      ).rejects.toThrow(/may not commit/u);
    } finally {
      await workspace.closeAndWait();
    }
  });

  it("replays an exact bounded proposal into a fresh repair worktree", async () => {
    const fixture = repositoryFixture();
    const manager = workspaceManager(fixture.factoryRoot);
    const implementation = await manager.create({
      taskId: TASK_ID,
      attempt: 1,
      repositoryRoot: fixture.repository,
      baseRevision: fixture.baseRevision
    });
    writeFileSync(join(implementation.root, "tracked.txt"), "repaired later\n", "utf8");
    const first = await manager.collect(implementation, {
      maximumChangedFiles: 2,
      maximumChangedLines: 10,
      maximumPatchBytes: 100_000
    });
    await implementation.closeAndWait();

    const repair = await manager.create({
      taskId: TASK_ID,
      attempt: 2,
      repositoryRoot: fixture.repository,
      baseRevision: fixture.baseRevision
    });
    try {
      await manager.apply(repair, first.patch, 100_000);
      const replayed = await manager.collect(repair, {
        maximumChangedFiles: 2,
        maximumChangedLines: 10,
        maximumPatchBytes: 100_000
      });
      expect(replayed).toEqual(first);
      await expect(manager.apply(repair, first.patch, 1)).rejects.toThrow(/apply budget/u);
    } finally {
      await repair.closeAndWait();
    }
  });

  it("rejects repository-defined filters before checkout or staging can execute them", async () => {
    const fixture = repositoryFixture({ attributes: "*.txt filter=evil\n" });
    git(fixture.repository, ["config", "filter.evil.smudge", "false"]);
    git(fixture.repository, ["config", "filter.evil.clean", "false"]);
    const manager = workspaceManager(fixture.factoryRoot);

    await expect(
      manager.create({
        taskId: TASK_ID,
        attempt: 1,
        repositoryRoot: fixture.repository,
        baseRevision: fixture.baseRevision
      })
    ).rejects.toThrow(/reject Git clean\/smudge filters/u);
    expect(git(fixture.repository, ["worktree", "list", "--porcelain"])).not.toContain(
      fixture.factoryRoot
    );

    const cleanFixture = repositoryFixture();
    const cleanManager = workspaceManager(cleanFixture.factoryRoot);
    const workspace = await cleanManager.create({
      taskId: TASK_ID,
      attempt: 1,
      repositoryRoot: cleanFixture.repository,
      baseRevision: cleanFixture.baseRevision
    });
    try {
      writeFileSync(join(workspace.root, ".gitattributes"), "*.txt filter=evil\n", "utf8");
      writeFileSync(join(workspace.root, "tracked.txt"), "changed\n", "utf8");
      await expect(
        cleanManager.collect(workspace, {
          maximumChangedFiles: 10,
          maximumChangedLines: 20,
          maximumPatchBytes: 1_000_000
        })
      ).rejects.toThrow(/reject Git clean\/smudge filters/u);
    } finally {
      await workspace.closeAndWait();
    }
  });

  it("refuses cleanup after the owned path is replaced by a symbolic link", async () => {
    const fixture = repositoryFixture();
    const manager = workspaceManager(fixture.factoryRoot);
    const workspace = await manager.create({
      taskId: TASK_ID,
      attempt: 1,
      repositoryRoot: fixture.repository,
      baseRevision: fixture.baseRevision
    });
    const outside = join(fixture.root, "outside");
    writeFileSync(outside, "preserve", "utf8");
    rmSync(workspace.root, { force: true, recursive: true });
    symlinkSync(outside, workspace.root);

    await expect(workspace.closeAndWait()).rejects.toThrow(/symbolic-link worktree/u);
    expect(existsSync(outside)).toBe(true);
  });
});

function workspaceManager(root: string, owner?: RuntimeResourceOwner): GitFactoryWorkspaceManager {
  let next = 1;
  return new GitFactoryWorkspaceManager(new NodeCommandRunner(), {
    root,
    gitExecutable,
    createId: () => `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`,
    ...(owner === undefined ? {} : { resourceOwner: owner })
  });
}

function repositoryFixture(options: { readonly attributes?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "agentlab-git-workspace-"));
  temporaryRoots.push(root);
  const repository = join(root, "repository");
  const factoryRoot = join(root, "factory");
  git(root, ["init", "--initial-branch=main", repository]);
  git(repository, ["config", "user.name", "AgentLab Test"]);
  git(repository, ["config", "user.email", "agentlab@example.invalid"]);
  writeFileSync(join(repository, "tracked.txt"), "original\n", "utf8");
  if (options.attributes !== undefined) {
    writeFileSync(join(repository, ".gitattributes"), options.attributes, "utf8");
  }
  git(repository, ["add", "."]);
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
