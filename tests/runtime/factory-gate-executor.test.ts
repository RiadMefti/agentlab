import { dirname, join } from "node:path";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import type { CommandSpec } from "../../packages/runtime/src/domain/command.js";
import type {
  FactoryGateSandbox,
  FactoryGateDefinition
} from "../../packages/runtime/src/domain/factory-gate.js";
import type { FactoryWorkspace } from "../../packages/runtime/src/domain/factory-workspace.js";
import type { FactoryProcessIsolator } from "../../packages/runtime/src/domain/factory-process-isolation.js";
import { BubblewrapFactoryGateSandbox } from "../../packages/runtime/src/infrastructure/process/bubblewrap-factory-gate-sandbox.js";
import type {
  CommandRunner,
  RunOptions,
  RunResult
} from "../../packages/runtime/src/infrastructure/process/command-runner.js";
import { LocalFactoryGateExecutor } from "../../packages/runtime/src/infrastructure/process/local-factory-gate-executor.js";
import { SystemdFactoryProcessIsolator } from "../../packages/runtime/src/infrastructure/process/systemd-factory-process-isolator.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("LocalFactoryGateExecutor", () => {
  it("runs only installed argument vectors through the mandatory sandbox", async () => {
    const runner = new FakeRunner({ stdout: "ok", stderr: "" });
    const executor = new LocalFactoryGateExecutor(
      [testGate],
      { wrap: () => Promise.resolve(wrappedCommand) },
      passthroughProcessIsolator,
      runner,
      timestamps()
    );

    await expect(executor.execute(gateInput("/work"))).resolves.toMatchObject({
      gateId: "test",
      result: "pass",
      command: wrappedCommand,
      stdout: "ok"
    });
    expect(runner.calls[0]).toMatchObject({
      executable: "/usr/bin/bwrap",
      args: ["--", "/runtime/0/bin/npm", "run", "test"],
      options: { cleanupProcessTree: true, maxCombinedBufferBytes: 1024 }
    });
    await expect(
      executor.execute({ ...gateInput("/work"), gateId: "not-installed" })
    ).rejects.toThrow(/not installed/u);
  });

  it("distinguishes a gate assertion failure from timeout and sandbox errors", async () => {
    const exit = commandError("exit", 2);
    const failed = new LocalFactoryGateExecutor(
      [testGate],
      passthroughSandbox,
      passthroughProcessIsolator,
      new FakeRunner(exit),
      timestamps()
    );
    await expect(failed.execute(gateInput("/work"))).resolves.toMatchObject({
      result: "fail",
      exitCode: 2
    });

    const timeout = commandError("timeout", null);
    const timedOut = new LocalFactoryGateExecutor(
      [testGate],
      passthroughSandbox,
      passthroughProcessIsolator,
      new FakeRunner(timeout),
      timestamps()
    );
    await expect(timedOut.execute(gateInput("/work"))).resolves.toMatchObject({
      result: "timed-out",
      exitCode: null
    });

    const sandboxFailure: FactoryGateSandbox = {
      wrap: () => Promise.reject(new Error("sandbox unavailable"))
    };
    const unavailable = new LocalFactoryGateExecutor(
      [testGate],
      sandboxFailure,
      passthroughProcessIsolator,
      new FakeRunner({ stdout: "", stderr: "" }),
      timestamps()
    );
    await expect(unavailable.execute(gateInput("/work"))).rejects.toThrow(/sandbox unavailable/u);
  });
});

describe("BubblewrapFactoryGateSandbox", () => {
  it("hides the host root, disables networking, and mounts dependencies read-only", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentlab-gate-sandbox-"));
    temporaryRoots.push(root);
    const workspace = fakeWorkspace(root);
    const nodeExecutable = process.execPath;
    const runtimeRoot = dirname(dirname(nodeExecutable));
    const sandbox = new BubblewrapFactoryGateSandbox({
      executable: "/usr/bin/bwrap",
      runtimeRoots: [runtimeRoot]
    });
    const command = await sandbox.wrap(
      { executable: join(runtimeRoot, "bin", "npm"), args: ["run", "test"] },
      workspace
    );

    expect(command.executable).toBe("/usr/bin/bwrap");
    expect(command.args).toEqual(expect.arrayContaining(["--unshare-all", "--clearenv"]));
    expect(command.args).toEqual(
      expect.arrayContaining([
        "--ro-bind",
        join(workspace.repositoryRoot, "node_modules"),
        "/workspace/node_modules"
      ])
    );
    expect(command.args).not.toContain("/home");
    expect(command.args.slice(-3)).toEqual(["/runtime/0/bin/npm", "run", "test"]);
  });

  it("rejects an agent-created node_modules symlink at the mount target", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentlab-gate-sandbox-"));
    temporaryRoots.push(root);
    symlinkSync("/tmp", join(root, "node_modules"));
    const runtimeRoot = dirname(dirname(process.execPath));
    const sandbox = new BubblewrapFactoryGateSandbox({
      executable: "/usr/bin/bwrap",
      runtimeRoots: [runtimeRoot]
    });
    await expect(
      sandbox.wrap({ executable: process.execPath, args: ["--version"] }, fakeWorkspace(root))
    ).rejects.toThrow(/real directory/u);
  });
});

describe("SystemdFactoryProcessIsolator", () => {
  it("wraps an argument vector in a bounded transient user scope", async () => {
    const isolator = new SystemdFactoryProcessIsolator({
      executable: "/usr/bin/systemd-run",
      environmentExecutable: "/usr/bin/env",
      version: "systemd 261",
      hostEnvironment: {
        XDG_RUNTIME_DIR: "/run/user/1000",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus"
      }
    });
    const result = await isolator.isolate({
      command: { executable: "/usr/bin/bwrap", args: ["--", "/usr/bin/true"] },
      isolationId: "77777777-7777-4777-8777-777777777777",
      limits: resourceLimits
    });

    expect(result.command.executable).toBe("/usr/bin/systemd-run");
    expect(result.command.args).toEqual(
      expect.arrayContaining([
        "--user",
        "--scope",
        "--property=Delegate=no",
        "--property=TasksMax=16",
        `--property=MemoryMax=${String(resourceLimits.maxMemoryBytes)}`,
        "--property=MemorySwapMax=0",
        "--property=CPUQuota=200%"
      ])
    );
    expect(result.command.args.slice(-7)).toEqual([
      "/usr/bin/env",
      "--unset=XDG_RUNTIME_DIR",
      "--unset=DBUS_SESSION_BUS_ADDRESS",
      "--",
      "/usr/bin/bwrap",
      "--",
      "/usr/bin/true"
    ]);
    expect(result.controllerEnvironment).toEqual({
      XDG_RUNTIME_DIR: "/run/user/1000",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus"
    });
    expect(result.isolation).toMatchObject({
      mechanism: { id: "linux/systemd-user-scope", version: "systemd 261" },
      limits: resourceLimits
    });
  });

  it("fails closed without a user-manager channel or an absolute command", async () => {
    expect(
      () =>
        new SystemdFactoryProcessIsolator({
          executable: "/usr/bin/systemd-run",
          environmentExecutable: "/usr/bin/env",
          version: "systemd 261",
          hostEnvironment: {}
        })
    ).toThrow(/XDG_RUNTIME_DIR/u);
    const isolator = new SystemdFactoryProcessIsolator({
      executable: "/usr/bin/systemd-run",
      environmentExecutable: "/usr/bin/env",
      version: "systemd 261",
      hostEnvironment: {
        XDG_RUNTIME_DIR: "/run/user/1000",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus"
      }
    });
    await expect(
      isolator.isolate({
        command: { executable: "node", args: [] },
        isolationId: "77777777-7777-4777-8777-777777777777",
        limits: resourceLimits
      })
    ).rejects.toThrow(/absolute executable/u);
  });
});

const testGate: FactoryGateDefinition = {
  id: "test",
  evidenceKind: "test",
  command: { executable: "/runtime/node/bin/npm", args: ["run", "test"] },
  timeoutMs: 60_000,
  maximumOutputBytes: 1024
};
const wrappedCommand: CommandSpec = {
  executable: "/usr/bin/bwrap",
  args: ["--", "/runtime/0/bin/npm", "run", "test"]
};
const passthroughSandbox: FactoryGateSandbox = {
  wrap: (command) => Promise.resolve(command)
};
const resourceLimits = {
  maxProcesses: 16,
  maxMemoryBytes: 2 * 1_024 * 1_024 * 1_024,
  cpuQuotaPercent: 200
} as const;
const passthroughProcessIsolator: FactoryProcessIsolator = {
  isolate: ({ command, isolationId, limits }) =>
    Promise.resolve({
      command,
      controllerEnvironment: {},
      isolation: {
        isolationId,
        mechanism: { id: "linux/systemd-user-scope", version: "test-systemd-1" },
        scopeName: `agentlab-factory-${isolationId.replaceAll("-", "")}.scope`,
        limits
      }
    })
};

class FakeRunner implements CommandRunner {
  public readonly calls: {
    readonly executable: string;
    readonly args: readonly string[];
    readonly options: RunOptions;
  }[] = [];

  public constructor(private readonly result: RunResult | Error) {}

  public run(executable: string, args: readonly string[], options: RunOptions = {}) {
    this.calls.push({ executable, args, options });
    return this.result instanceof Error
      ? Promise.reject(this.result)
      : Promise.resolve(this.result);
  }
}

function fakeWorkspace(root: string): FactoryWorkspace {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    taskId: "11111111-1111-4111-8111-111111111111",
    attempt: 1,
    repositoryRoot: process.cwd(),
    root,
    baseRevision: "a".repeat(40),
    closeAndWait: () => Promise.resolve()
  };
}

function timestamps() {
  const values = ["2026-08-30T12:00:00.000Z", "2026-08-30T12:00:01.000Z"];
  return {
    now: () => values.shift() ?? "2026-08-30T12:00:01.000Z",
    createId: () => "77777777-7777-4777-8777-777777777777"
  };
}

function gateInput(root: string) {
  return { gateId: "test", workspace: fakeWorkspace(root), resourceLimits };
}

function commandError(kind: "exit" | "timeout", exitCode: number | null): Error {
  return Object.assign(new Error(kind), {
    commandFailureKind: kind,
    exitCode,
    signal: null,
    stdout: "partial",
    stderr: "failure"
  });
}
