import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { FactoryPreparationRecoveryInput } from "../../packages/runtime/src/domain/factory-preparation-recovery.js";
import { factoryWorkspaceTarget } from "../../packages/runtime/src/infrastructure/filesystem/factory-workspace-paths.js";
import { GitFactoryWorkspaceManager } from "../../packages/runtime/src/infrastructure/filesystem/git-factory-workspace.js";
import type {
  CommandRunner,
  RunOptions,
  RunResult
} from "../../packages/runtime/src/infrastructure/process/command-runner.js";
import { NodeCommandRunner } from "../../packages/runtime/src/infrastructure/process/command-runner.js";
import { factorySystemdScopeName } from "../../packages/runtime/src/infrastructure/process/systemd-user-manager.js";
import { LocalFactoryPreparationRecovery } from "../../packages/runtime/src/infrastructure/recovery/local-factory-preparation-recovery.js";

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const EXECUTION_ID = "22222222-2222-4222-8222-222222222222";
const gitExecutable = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
const flockExecutable = execFileSync("which", ["flock"], { encoding: "utf8" }).trim();
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("LocalFactoryPreparationRecovery", () => {
  it("removes only the exact journal-bound worktree after repeated inactive scope proof", async () => {
    const fixture = repositoryFixture();
    const runner = new RecoveryCommandRunner(["inactive", "inactive", "inactive"]);
    const manager = workspaceManager(fixture.factoryRoot, runner);
    const workspace = await manager.create({
      taskId: TASK_ID,
      attempt: 1,
      repositoryRoot: fixture.repository,
      baseRevision: fixture.baseRevision,
      workspaceId: EXECUTION_ID
    });
    writeFileSync(join(workspace.root, "tracked.txt"), "uncommitted agent output\n", "utf8");

    try {
      await expect(recovery(fixture, runner).reconcile(recoveryInput(fixture))).resolves.toEqual({
        status: "inactive"
      });
      expect(existsSync(workspace.root)).toBe(false);
      expect(git(fixture.repository, ["worktree", "list", "--porcelain"])).not.toContain(
        workspace.root
      );
      expect(runner.systemctlCalls).toHaveLength(3);
      expect(runner.systemctlCalls[0]).toContain(factorySystemdScopeName(EXECUTION_ID));
    } finally {
      await workspace.closeAndWait();
    }
  });

  it("preserves the workspace when the exact systemd scope is active or unobservable", async () => {
    for (const scope of ["active", "error", "malformed", "unexpected-load"] as const) {
      const fixture = repositoryFixture();
      const runner = new RecoveryCommandRunner([scope]);
      const manager = workspaceManager(fixture.factoryRoot, runner);
      const workspace = await manager.create({
        taskId: TASK_ID,
        attempt: 1,
        repositoryRoot: fixture.repository,
        baseRevision: fixture.baseRevision,
        workspaceId: EXECUTION_ID
      });
      try {
        await expect(recovery(fixture, runner).reconcile(recoveryInput(fixture))).resolves.toEqual({
          status: "uncertain",
          reasonCode:
            scope === "active"
              ? "preparation-process-not-inactive"
              : "preparation-process-state-uncertain"
        });
        expect(existsSync(workspace.root)).toBe(true);
      } finally {
        await workspace.closeAndWait();
      }
    }
  });

  it("does not clean when the scope becomes active immediately before removal", async () => {
    const fixture = repositoryFixture();
    const runner = new RecoveryCommandRunner(["inactive", "active"]);
    const manager = workspaceManager(fixture.factoryRoot, runner);
    const workspace = await manager.create({
      taskId: TASK_ID,
      attempt: 1,
      repositoryRoot: fixture.repository,
      baseRevision: fixture.baseRevision,
      workspaceId: EXECUTION_ID
    });
    try {
      await expect(recovery(fixture, runner).reconcile(recoveryInput(fixture))).resolves.toEqual({
        status: "uncertain",
        reasonCode: "preparation-process-not-inactive"
      });
      expect(existsSync(workspace.root)).toBe(true);
      expect(runner.systemctlCalls).toHaveLength(2);
    } finally {
      await workspace.closeAndWait();
    }
  });

  it("preserves the workspace while an exact worktree operation lock is unavailable", async () => {
    const fixture = repositoryFixture();
    const runner = new RecoveryCommandRunner(["inactive"]);
    const manager = workspaceManager(fixture.factoryRoot, runner);
    const workspace = await manager.create({
      taskId: TASK_ID,
      attempt: 1,
      repositoryRoot: fixture.repository,
      baseRevision: fixture.baseRevision,
      workspaceId: EXECUTION_ID
    });
    const lockHolder = spawn(
      flockExecutable,
      [
        "--exclusive",
        "--no-fork",
        "--",
        join(fixture.factoryRoot, TASK_ID),
        process.execPath,
        "-e",
        "process.stdout.write('locked\\n'); setInterval(() => {}, 1_000);"
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    await once(lockHolder.stdout, "data");
    try {
      await expect(recovery(fixture, runner).reconcile(recoveryInput(fixture))).resolves.toEqual({
        status: "uncertain",
        reasonCode: "preparation-workspace-operation-uncertain"
      });
      expect(existsSync(workspace.root)).toBe(true);
    } finally {
      const closed = once(lockHolder, "close");
      lockHolder.kill("SIGTERM");
      await closed;
      await workspace.closeAndWait();
    }
  });

  it("refuses an exact target replaced by a symbolic link", async () => {
    const fixture = repositoryFixture();
    const runner = new RecoveryCommandRunner(["inactive"]);
    const target = factoryWorkspaceTarget(fixture.factoryRoot, {
      taskId: TASK_ID,
      attempt: 1,
      workspaceId: EXECUTION_ID
    });
    const outside = join(fixture.root, "outside");
    mkdirSync(join(fixture.factoryRoot, TASK_ID), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(outside, "preserve.txt"), "preserve\n", "utf8");
    symlinkSync(outside, target, "dir");

    await expect(recovery(fixture, runner).reconcile(recoveryInput(fixture))).resolves.toEqual({
      status: "uncertain",
      reasonCode: "preparation-workspace-identity-uncertain"
    });
    expect(existsSync(join(outside, "preserve.txt"))).toBe(true);
  });

  it("cleans an exact partially-created unregistered directory and verifies absence", async () => {
    const fixture = repositoryFixture();
    const runner = new RecoveryCommandRunner(["inactive", "inactive", "inactive"]);
    const target = factoryWorkspaceTarget(fixture.factoryRoot, {
      taskId: TASK_ID,
      attempt: 1,
      workspaceId: EXECUTION_ID
    });
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "partial"), "partial\n", "utf8");

    await expect(recovery(fixture, runner).reconcile(recoveryInput(fixture))).resolves.toEqual({
      status: "inactive"
    });
    expect(existsSync(target)).toBe(false);
  });

  it("reconciles exact stale Git metadata when the worktree directory is already absent", async () => {
    const fixture = repositoryFixture();
    const runner = new RecoveryCommandRunner(["inactive", "inactive", "inactive"]);
    const manager = workspaceManager(fixture.factoryRoot, runner);
    const workspace = await manager.create({
      taskId: TASK_ID,
      attempt: 1,
      repositoryRoot: fixture.repository,
      baseRevision: fixture.baseRevision,
      workspaceId: EXECUTION_ID
    });
    renameSync(workspace.root, join(fixture.root, "orphaned-worktree-contents"));

    try {
      await expect(recovery(fixture, runner).reconcile(recoveryInput(fixture))).resolves.toEqual({
        status: "inactive"
      });
      expect(git(fixture.repository, ["worktree", "list", "--porcelain"])).not.toContain(
        workspace.root
      );
    } finally {
      await workspace.closeAndWait();
    }
  });

  it("fails closed when the repository base cannot be proven", async () => {
    const fixture = repositoryFixture();
    const runner = new RecoveryCommandRunner(["inactive"]);
    await expect(
      recovery(fixture, runner).reconcile({
        ...recoveryInput(fixture),
        baseRevision: "f".repeat(40)
      })
    ).resolves.toEqual({
      status: "uncertain",
      reasonCode: "preparation-repository-identity-uncertain"
    });
  });
});

type ScopeResponse = "active" | "error" | "inactive" | "malformed" | "unexpected-load";

class RecoveryCommandRunner implements CommandRunner {
  readonly #node = new NodeCommandRunner();
  readonly #scopeResponses: ScopeResponse[];
  public readonly systemctlCalls: string[][] = [];

  public constructor(scopeResponses: readonly ScopeResponse[]) {
    this.#scopeResponses = [...scopeResponses];
  }

  public run(
    executable: string,
    args: readonly string[],
    options?: RunOptions
  ): Promise<RunResult> {
    if (executable !== "/usr/bin/systemctl") {
      return this.#node.run(executable, args, options);
    }
    this.systemctlCalls.push([...args]);
    const response = this.#scopeResponses.shift() ?? "inactive";
    if (response === "error") return Promise.reject(new Error("user manager unavailable"));
    if (response === "malformed") return Promise.resolve({ stdout: "invalid\n", stderr: "" });
    if (response === "unexpected-load") {
      return Promise.resolve({
        stdout: "LoadState=error\nActiveState=inactive\nSubState=dead\n",
        stderr: ""
      });
    }
    return Promise.resolve({
      stdout:
        response === "inactive"
          ? "LoadState=not-found\nActiveState=inactive\nSubState=dead\n"
          : "LoadState=loaded\nActiveState=active\nSubState=running\n",
      stderr: ""
    });
  }
}

function recovery(
  fixture: ReturnType<typeof repositoryFixture>,
  runner: CommandRunner
): LocalFactoryPreparationRecovery {
  return new LocalFactoryPreparationRecovery(runner, {
    root: fixture.factoryRoot,
    gitExecutable,
    flockExecutable,
    systemctlExecutable: "/usr/bin/systemctl",
    hostEnvironment: {
      XDG_RUNTIME_DIR: "/run/user/1000",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus"
    }
  });
}

function workspaceManager(root: string, runner: CommandRunner): GitFactoryWorkspaceManager {
  return new GitFactoryWorkspaceManager(runner, {
    root,
    gitExecutable,
    flockExecutable,
    createId: () => "33333333-3333-4333-8333-333333333333"
  });
}

function recoveryInput(
  fixture: ReturnType<typeof repositoryFixture>
): FactoryPreparationRecoveryInput {
  return {
    taskId: TASK_ID,
    executionId: EXECUTION_ID,
    phase: "qualify",
    attempt: 1,
    repositoryRoot: fixture.repository,
    baseRevision: fixture.baseRevision
  };
}

function repositoryFixture() {
  const root = mkdtempSync(join(tmpdir(), "agentlab-preparation-recovery-"));
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
