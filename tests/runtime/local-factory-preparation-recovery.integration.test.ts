import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { GitFactoryWorkspaceManager } from "../../packages/runtime/src/infrastructure/filesystem/git-factory-workspace.js";
import { NodeCommandRunner } from "../../packages/runtime/src/infrastructure/process/command-runner.js";
import { LocalFactoryPreparationRecovery } from "../../packages/runtime/src/infrastructure/recovery/local-factory-preparation-recovery.js";

const runLive = process.platform === "linux" && process.env.AGENTLAB_RUN_FACTORY_SANDBOX === "1";
const TASK_ID = "66666666-6666-4666-8666-666666666666";
const EXECUTION_ID = "77777777-7777-4777-8777-777777777777";
const gitExecutable = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
const flockExecutable = execFileSync("which", ["flock"], { encoding: "utf8" }).trim();
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe.runIf(runLive)("LocalFactoryPreparationRecovery integration", () => {
  it("reconciles an exact worktree through the live systemd user manager", async () => {
    const fixture = repositoryFixture();
    const runner = new NodeCommandRunner();
    const manager = new GitFactoryWorkspaceManager(runner, {
      root: fixture.factoryRoot,
      gitExecutable,
      flockExecutable,
      createId: () => EXECUTION_ID
    });
    const workspace = await manager.create({
      taskId: TASK_ID,
      attempt: 1,
      repositoryRoot: fixture.repository,
      baseRevision: fixture.baseRevision,
      workspaceId: EXECUTION_ID
    });
    writeFileSync(join(workspace.root, "tracked.txt"), "uncommitted agent output\n", "utf8");

    try {
      const recovery = new LocalFactoryPreparationRecovery(runner, {
        root: fixture.factoryRoot,
        gitExecutable,
        flockExecutable,
        systemctlExecutable: "/usr/bin/systemctl",
        hostEnvironment: process.env
      });
      await expect(
        recovery.reconcile({
          taskId: TASK_ID,
          executionId: EXECUTION_ID,
          phase: "qualify",
          attempt: 1,
          repositoryRoot: fixture.repository,
          baseRevision: fixture.baseRevision
        })
      ).resolves.toEqual({ status: "inactive" });
      expect(existsSync(workspace.root)).toBe(false);
      expect(git(fixture.repository, ["worktree", "list", "--porcelain"])).not.toContain(
        workspace.root
      );
    } finally {
      await workspace.closeAndWait();
    }
  });
});

function repositoryFixture() {
  const root = mkdtempSync(join(tmpdir(), "agentlab-live-preparation-recovery-"));
  temporaryRoots.push(root);
  const repository = join(root, "repository");
  const factoryRoot = join(root, "factory");
  git(root, ["init", "--initial-branch=main", repository]);
  git(repository, ["config", "user.name", "AgentLab Test"]);
  git(repository, ["config", "user.email", "agentlab@example.invalid"]);
  writeFileSync(join(repository, "tracked.txt"), "original\n", "utf8");
  git(repository, ["add", "."]);
  git(repository, ["commit", "-m", "initial"]);
  return {
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
