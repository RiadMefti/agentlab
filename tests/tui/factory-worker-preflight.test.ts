import type {
  FactoryWorkerPreflight,
  LocalFactoryWorkerConfig,
  LocalFactoryWorkerRuntime
} from "@agentlab/runtime/factory-worker";
import { describe, expect, it, vi } from "vitest";

import {
  runFactoryWorkerPreflight,
  type FactoryWorkerPreflightRunnerDependencies
} from "../../apps/tui/src/run-factory-worker-preflight.js";

const configPath = "/private/agentlab/worker.json";
const policyBundleDigest = `sha256:${"c".repeat(64)}` as const;

describe("factory worker preflight CLI runner", () => {
  it("rejects a non-canonical config path before loading worker configuration", async () => {
    const loadConfig = vi.fn(() => Promise.resolve(config()));
    const createRuntime = vi.fn(() =>
      workerRuntime(Promise.resolve(report("ready", true, true, true, [], ["codex"])), () =>
        Promise.resolve()
      )
    );

    await expect(
      runFactoryWorkerPreflight("worker.json", {
        loadConfig,
        createRuntime,
        write: vi.fn()
      })
    ).rejects.toThrow(/normalized absolute config path/u);
    expect(loadConfig).not.toHaveBeenCalled();
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it("prints one deterministic credentialless readiness record after clean shutdown", async () => {
    const writes: string[] = [];
    const events: string[] = [];
    const dependencies = runnerDependencies(
      report("ready", true, true, true, [], ["codex", "claude"]),
      () => Promise.resolve(events.push("closed")).then(() => undefined),
      (message) => {
        events.push("written");
        writes.push(message);
      }
    );

    await expect(runFactoryWorkerPreflight(configPath, dependencies)).resolves.toBe(0);

    expect(events).toEqual(["closed", "written"]);
    expect(JSON.parse(writes[0] ?? "")).toEqual({
      schemaVersion: "agentlab.worker-preflight.v1",
      status: "ready",
      policyBundleDigest,
      schedulerEnabled: true,
      costPolicyConfigured: true,
      hostReady: true,
      configuredProviders: ["claude", "codex"],
      gateIds: ["architecture", "build", "format", "lint", "secret-scan", "test", "typecheck"],
      reasonCodes: []
    });
  });

  it("returns a distinct blocked status without invoking worker operations", async () => {
    const writes: string[] = [];
    const runtime = workerRuntime(
      Promise.resolve(
        report(
          "blocked",
          false,
          false,
          false,
          ["scheduler-disabled", "cost-policy-unconfigured", "provider-codex-unavailable"],
          ["codex"]
        )
      ),
      vi.fn(() => Promise.resolve())
    );
    const advancePreparation = vi.spyOn(runtime.commands, "advancePreparation");

    await expect(
      runFactoryWorkerPreflight(configPath, {
        loadConfig: () => Promise.resolve(config()),
        createRuntime: () => runtime,
        write: (message) => writes.push(message)
      })
    ).resolves.toBe(2);

    expect(advancePreparation).not.toHaveBeenCalled();
    expect(JSON.parse(writes[0] ?? "")).toMatchObject({
      status: "blocked",
      reasonCodes: ["cost-policy-unconfigured", "provider-codex-unavailable", "scheduler-disabled"]
    });
  });

  it("closes on inspection failure and suppresses output when cleanup also fails", async () => {
    const inspectionFailure = new Error("inspection failed");
    const cleanupFailure = new Error("cleanup failed");
    const writes: string[] = [];
    const runtime = workerRuntime(
      Promise.reject(inspectionFailure),
      vi.fn(() => Promise.reject(cleanupFailure))
    );

    await expect(
      runFactoryWorkerPreflight(configPath, {
        loadConfig: () => Promise.resolve(config()),
        createRuntime: () => runtime,
        write: (message) => writes.push(message)
      })
    ).rejects.toEqual(
      expect.objectContaining({
        name: "AggregateError",
        errors: [inspectionFailure, cleanupFailure]
      })
    );
    expect(writes).toEqual([]);
  });
});

function runnerDependencies(
  preflight: FactoryWorkerPreflight,
  close: () => Promise<void>,
  write: (message: string) => void
): FactoryWorkerPreflightRunnerDependencies {
  return {
    loadConfig: vi.fn(() => Promise.resolve(config())),
    createRuntime: vi.fn(() => workerRuntime(Promise.resolve(preflight), close)),
    write
  };
}

function workerRuntime(
  preflight: Promise<FactoryWorkerPreflight>,
  close: () => Promise<void>
): LocalFactoryWorkerRuntime {
  const noResult = () => Promise.resolve(undefined as never);
  return {
    commands: {
      preflight: () => preflight,
      advancePreparation: noResult,
      recoverPreparation: noResult,
      materializePreparation: noResult,
      admitExecution: noResult,
      execute: noResult,
      recoverExecution: noResult,
      runTask: noResult
    },
    close
  };
}

function report(
  status: "ready" | "blocked",
  schedulerEnabled: boolean,
  costPolicyConfigured: boolean,
  hostReady: boolean,
  reasonCodes: readonly string[],
  configuredProviders: readonly ("codex" | "claude")[]
): FactoryWorkerPreflight {
  return {
    schemaVersion: "agentlab.worker-preflight.v1",
    status,
    policyBundleDigest,
    schedulerEnabled,
    costPolicyConfigured,
    hostReady,
    configuredProviders,
    gateIds: ["format", "architecture", "typecheck", "lint", "test", "build", "secret-scan"],
    reasonCodes
  };
}

function config(): LocalFactoryWorkerConfig {
  return {
    schemaVersion: "agentlab.local-factory-worker.v1",
    databasePath: "/private/agentlab/agentlab.sqlite",
    artifactRoot: "/private/agentlab/artifacts",
    workspaceRoot: "/private/agentlab/worktrees",
    costPolicyPath: "/private/agentlab/cost-policy.json",
    gitExecutable: "/usr/bin/git",
    flockExecutable: "/usr/bin/flock",
    systemd: {
      runExecutable: "/usr/bin/systemd-run",
      controlExecutable: "/usr/bin/systemctl",
      environmentExecutable: "/usr/bin/env",
      version: "systemd 261"
    },
    sandbox: { bubblewrapExecutable: "/usr/bin/bwrap", runtimeRoots: ["/usr"] },
    providers: [
      {
        provider: "codex",
        executable: "/usr/bin/codex",
        executableDigest: `sha256:${"d".repeat(64)}`,
        version: "codex 1.0.0"
      }
    ],
    gates: gateIds().map((id) => ({
      id,
      evidenceKind: id === "build" ? "build" : id === "secret-scan" ? "security" : "test",
      command: { executable: "/usr/bin/npm", args: ["run", id] },
      timeoutMs: 60_000,
      maximumOutputBytes: 1_024
    })),
    costPolicy: {
      schemaVersion: "agentlab.cost-policy.v1",
      id: "agentlab/test-costs",
      version: "1.0.0",
      rules: []
    }
  };
}

function gateIds() {
  return ["format", "architecture", "typecheck", "lint", "test", "build", "secret-scan"] as const;
}
