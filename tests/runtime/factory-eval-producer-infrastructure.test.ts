import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { Sha256Digest } from "@agentlab/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { PinnedFactoryEvalExecutableResolver } from "../../packages/runtime/src/infrastructure/filesystem/pinned-factory-eval-executable-resolver.js";
import { pinnedLocalExecutableDigest } from "../../packages/runtime/src/infrastructure/filesystem/pinned-local-executable.js";
import { BubblewrapFactoryEvalSandbox } from "../../packages/runtime/src/infrastructure/process/bubblewrap-factory-eval-sandbox.js";
import type {
  CommandRunner,
  RunOptions,
  RunResult
} from "../../packages/runtime/src/infrastructure/process/command-runner.js";
import { SystemdFactoryEvalProcessRecovery } from "../../packages/runtime/src/infrastructure/process/systemd-factory-eval-process-recovery.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("factory eval producer infrastructure", () => {
  it("constructs an empty-home, no-network sandbox with one writable mount", async () => {
    const workspace = temporaryRoot();
    const runtimeRoot = dirname(dirname(process.execPath));
    const sandbox = new BubblewrapFactoryEvalSandbox({
      executable: "/usr/bin/bwrap",
      runtimeRoots: [runtimeRoot]
    });

    const command = await sandbox.wrap(
      { executable: process.execPath, args: ["subject"] },
      workspace
    );

    expect(command.executable).toBe("/usr/bin/bwrap");
    expect(command.args).toEqual(expect.arrayContaining(["--unshare-all", "--clearenv"]));
    expect(command.args).toEqual(
      expect.arrayContaining(["--bind", workspace, "/workspace", "--setenv", "HOME", "/tmp/home"])
    );
    expect(command.args).not.toContain("/home");
    expect(command.args.slice(-2)).toEqual(["/runtime/0/bin/node", "subject"]);
    expect(command.args.filter((argument) => argument === "--bind")).toHaveLength(1);

    const overlapping = new BubblewrapFactoryEvalSandbox({
      executable: "/usr/bin/bwrap",
      runtimeRoots: [dirname(workspace)]
    });
    await expect(
      overlapping.wrap({ executable: "/usr/bin/true", args: [] }, workspace)
    ).rejects.toThrow(/must not contain/u);
  });

  it("re-hashes every configured executable and rejects identity drift", async () => {
    const executable = realpathSync("/usr/bin/true");
    const actualDigest = await pinnedLocalExecutableDigest(executable, "test eval executable");
    const descriptorDigest = digest("descriptor");
    const binding = {
      descriptorDigest,
      executable,
      executableDigest: actualDigest,
      version: "coreutils"
    };
    const resolver = new PinnedFactoryEvalExecutableResolver([binding]);

    await expect(resolver.resolve(descriptorDigest)).resolves.toEqual(binding);
    await expect(resolver.resolve(digest("missing"))).resolves.toBeNull();
    await expect(
      new PinnedFactoryEvalExecutableResolver([
        { ...binding, executableDigest: digest("substituted") }
      ]).resolve(descriptorDigest)
    ).rejects.toThrow(/changed after review/u);
  });

  it("treats only an exact inactive/dead scope as safe crash recovery", async () => {
    const executionId = "60000000-0000-4000-8000-000000000001";
    const inactive = new RecordingRunner("LoadState=loaded\nActiveState=inactive\nSubState=dead\n");
    const active = new RecordingRunner("LoadState=loaded\nActiveState=active\nSubState=running\n");
    const malformed = new RecordingRunner("garbled\n");

    await expect(recovery(inactive).state(executionId)).resolves.toBe("inactive");
    await expect(recovery(active).state(executionId)).resolves.toBe("active");
    await expect(recovery(malformed).state(executionId)).resolves.toBe("uncertain");
    expect(inactive.calls[0]?.args).toEqual([
      "--user",
      "show",
      "agentlab-factory-60000000000040008000000000000001.scope",
      "--property=LoadState",
      "--property=ActiveState",
      "--property=SubState",
      "--no-pager"
    ]);
  });
});

class RecordingRunner implements CommandRunner {
  public readonly calls: {
    readonly executable: string;
    readonly args: readonly string[];
    readonly options: RunOptions;
  }[] = [];

  public constructor(private readonly stdout: string) {}

  public run(
    executable: string,
    args: readonly string[],
    options: RunOptions = {}
  ): Promise<RunResult> {
    this.calls.push({ executable, args, options });
    return Promise.resolve({ stdout: this.stdout, stderr: "" });
  }
}

function recovery(runner: CommandRunner): SystemdFactoryEvalProcessRecovery {
  return new SystemdFactoryEvalProcessRecovery(runner, {
    executable: "/usr/bin/systemctl",
    hostEnvironment: {
      XDG_RUNTIME_DIR: "/run/user/1000",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus"
    }
  });
}

function temporaryRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "agentlab-eval-sandbox-")));
  roots.push(root);
  return root;
}

function digest(value: string): Sha256Digest {
  return `sha256:${Buffer.from(value).toString("hex").padEnd(64, "0").slice(0, 64)}`;
}
