import { describe, expect, it } from "vitest";

import type { CommandRunner } from "../../packages/runtime/src/infrastructure/process/command-runner.js";
import { factorySystemdScopeName } from "../../packages/runtime/src/infrastructure/process/systemd-user-manager.js";
import { LocalFactoryWorkspaceRecovery } from "../../packages/runtime/src/infrastructure/recovery/local-factory-workspace-recovery.js";

const OPERATION_ONE = "11111111-1111-4111-8111-111111111111";
const OPERATION_TWO = "22222222-2222-4222-8222-222222222222";

describe("LocalFactoryWorkspaceRecovery", () => {
  it("checks every exact journal-owned scope and preserves resources when any is active", async () => {
    const runner = new ScopeRunner(OPERATION_TWO);
    const recovery = workspaceRecovery(runner);

    await expect(
      recovery.reconcile({
        ...recoveryInput(),
        processExecutionIds: [OPERATION_ONE, OPERATION_TWO]
      })
    ).resolves.toEqual({ status: "uncertain", reasonCode: "process-not-inactive" });
    expect(runner.scopeNames).toEqual([
      factorySystemdScopeName(OPERATION_ONE),
      factorySystemdScopeName(OPERATION_TWO)
    ]);
  });

  it("rejects duplicate process coordinates before consulting the host", async () => {
    const runner = new ScopeRunner(null);
    await expect(
      workspaceRecovery(runner).reconcile({
        ...recoveryInput(),
        processExecutionIds: [OPERATION_ONE, OPERATION_ONE]
      })
    ).rejects.toThrow(/must be unique/u);
    expect(runner.scopeNames).toEqual([]);
  });
});

class ScopeRunner implements CommandRunner {
  public readonly scopeNames: string[] = [];

  public constructor(private readonly activeId: string | null) {}

  public run(_executable: string, args: readonly string[]) {
    const scopeName = args[2];
    if (scopeName === undefined) return Promise.reject(new Error("missing scope"));
    this.scopeNames.push(scopeName);
    const active = this.activeId !== null && scopeName === factorySystemdScopeName(this.activeId);
    return Promise.resolve({
      stdout: active
        ? "LoadState=loaded\nActiveState=active\nSubState=running\n"
        : "LoadState=not-found\nActiveState=inactive\nSubState=dead\n",
      stderr: ""
    });
  }
}

function workspaceRecovery(runner: CommandRunner) {
  return new LocalFactoryWorkspaceRecovery(runner, {
    root: "/var/tmp/agentlab-factory-test",
    gitExecutable: "/usr/bin/git",
    flockExecutable: "/usr/bin/flock",
    systemctlExecutable: "/usr/bin/systemctl",
    hostEnvironment: {
      XDG_RUNTIME_DIR: "/run/user/1000",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus"
    }
  });
}

function recoveryInput() {
  return {
    taskId: "33333333-3333-4333-8333-333333333333",
    workspaceId: "44444444-4444-4444-8444-444444444444",
    attempt: 1,
    repositoryRoot: "/does/not/exist",
    baseRevision: "a".repeat(40)
  };
}
