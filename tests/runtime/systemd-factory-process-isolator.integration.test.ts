import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { NodeCommandRunner } from "../../packages/runtime/src/infrastructure/process/command-runner.js";
import { LocalFactoryWorkerHostInspector } from "../../packages/runtime/src/infrastructure/process/local-factory-worker-host-inspector.js";
import { SystemdFactoryProcessIsolator } from "../../packages/runtime/src/infrastructure/process/systemd-factory-process-isolator.js";

const runLive = process.platform === "linux" && process.env.AGENTLAB_RUN_FACTORY_SANDBOX === "1";

describe.runIf(runLive)("SystemdFactoryProcessIsolator integration", () => {
  it("proves the credentialless worker toolchain and exact user-manager identity", async () => {
    const runner = new NodeCommandRunner();
    const ownedRoot = realpathSync(mkdtempSync(join(tmpdir(), "agentlab-live-worker-host-")));
    const artifactRoot = join(ownedRoot, "artifacts");
    const workspaceRoot = join(ownedRoot, "worktrees");
    mkdirSync(artifactRoot, { mode: 0o700 });
    mkdirSync(workspaceRoot, { mode: 0o700 });
    const environment = {
      CI: "true",
      LC_ALL: "C",
      NO_COLOR: "1",
      PATH: "/usr/local/bin:/usr/bin:/bin",
      TERM: "dumb"
    };
    const version = (
      await runner.run("/usr/bin/systemd-run", ["--version"], {
        timeoutMs: 5_000,
        cleanupProcessTree: true,
        maxBufferBytes: 32 * 1_024,
        environment
      })
    ).stdout.split(/\r?\n/u)[0];
    if (version === undefined || version.length === 0) {
      throw new Error("The live systemd executable returned no version identity.");
    }
    try {
      const inspector = new LocalFactoryWorkerHostInspector(runner, {
        workingDirectory: realpathSync(process.cwd()),
        artifactRoot,
        workspaceRoot,
        gitExecutable: "/usr/bin/git",
        flockExecutable: "/usr/bin/flock",
        systemdRunExecutable: "/usr/bin/systemd-run",
        systemdControlExecutable: "/usr/bin/systemctl",
        environmentExecutable: "/usr/bin/env",
        systemdVersion: version,
        bubblewrapExecutable: "/usr/bin/bwrap",
        runtimeRoots: [dirname(dirname(realpathSync(process.execPath)))],
        gates: [
          {
            id: "format",
            evidenceKind: "test",
            command: { executable: realpathSync(process.execPath), args: [] },
            timeoutMs: 5_000,
            maximumOutputBytes: 4_096
          }
        ],
        configuredProviders: ["codex"],
        providers: {
          resolve: () =>
            Promise.resolve({
              executable: realpathSync(process.execPath),
              version: process.version
            })
        },
        hostEnvironment: process.env
      });

      await expect(inspector.inspect()).resolves.toEqual({ status: "ready", reasonCodes: [] });
    } finally {
      rmSync(ownedRoot, { force: true, recursive: true });
    }
  });

  it("places the live process tree under the exact cgroup ceilings", async () => {
    const limits = {
      maxProcesses: 7,
      maxMemoryBytes: 512 * 1_024 * 1_024,
      cpuQuotaPercent: 50
    } as const;
    const isolator = liveIsolator();
    const isolated = await isolator.isolate({
      command: { executable: process.execPath, args: ["-e", cgroupProbe] },
      isolationId: "88888888-8888-4888-8888-888888888888",
      limits
    });
    const output = await new NodeCommandRunner().run(
      isolated.command.executable,
      isolated.command.args,
      {
        timeoutMs: 10_000,
        cleanupProcessTree: true,
        maxBufferBytes: 16_384,
        environment: { ...process.env, ...isolated.controllerEnvironment }
      }
    );
    const observed = JSON.parse(output.stdout) as {
      readonly memory: string;
      readonly processes: string;
      readonly cpu: string;
      readonly xdgRuntimeDirectory: string | null;
      readonly dbusSessionBusAddress: string | null;
    };
    expect(observed.memory).toBe(String(limits.maxMemoryBytes));
    expect(observed.processes).toBe(String(limits.maxProcesses));
    const [quotaText, periodText] = observed.cpu.split(" ");
    if (quotaText === undefined || periodText === undefined) {
      throw new Error("Kernel CPU quota did not contain quota and period values.");
    }
    const quota = Number(quotaText);
    const period = Number(periodText);
    expect(quota).toBeGreaterThan(0);
    expect(period).toBeGreaterThan(0);
    expect((quota / period) * 100).toBe(limits.cpuQuotaPercent);
    expect(observed.xdgRuntimeDirectory).toBeNull();
    expect(observed.dbusSessionBusAddress).toBeNull();
  });

  it("kills a workload that exceeds its memory cgroup", async () => {
    const isolator = liveIsolator();
    const isolated = await isolator.isolate({
      command: { executable: process.execPath, args: ["-e", memoryPressureProbe] },
      isolationId: "99999999-9999-4999-8999-999999999999",
      limits: {
        maxProcesses: 7,
        maxMemoryBytes: 128 * 1_024 * 1_024,
        cpuQuotaPercent: 100
      }
    });
    await expect(
      new NodeCommandRunner().run(isolated.command.executable, isolated.command.args, {
        timeoutMs: 15_000,
        cleanupProcessTree: true,
        maxBufferBytes: 16_384,
        environment: { ...process.env, ...isolated.controllerEnvironment }
      })
    ).rejects.toThrow();
  });
});

function liveIsolator(): SystemdFactoryProcessIsolator {
  const version = readFileSync("/proc/sys/kernel/osrelease", "utf8").trim();
  return new SystemdFactoryProcessIsolator({
    executable: "/usr/bin/systemd-run",
    environmentExecutable: "/usr/bin/env",
    version: `systemd-cgroup2/${version}`,
    hostEnvironment: process.env
  });
}

const cgroupProbe = String.raw`
const fs = require("node:fs");
const path = require("node:path");
const row = fs.readFileSync("/proc/self/cgroup", "utf8").split("\n").find((line) => line.startsWith("0::"));
if (row === undefined) process.exit(91);
const root = path.join("/sys/fs/cgroup", row.slice(3));
process.stdout.write(JSON.stringify({
  memory: fs.readFileSync(path.join(root, "memory.max"), "utf8").trim(),
  processes: fs.readFileSync(path.join(root, "pids.max"), "utf8").trim(),
  cpu: fs.readFileSync(path.join(root, "cpu.max"), "utf8").trim(),
  xdgRuntimeDirectory: process.env.XDG_RUNTIME_DIR ?? null,
  dbusSessionBusAddress: process.env.DBUS_SESSION_BUS_ADDRESS ?? null
}));
`;

const memoryPressureProbe = String.raw`
const blocks = [];
for (;;) {
  const block = Buffer.alloc(16 * 1024 * 1024, 1);
  blocks.push(block);
}
`;
