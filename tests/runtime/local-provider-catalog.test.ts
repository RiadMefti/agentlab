import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  ProviderCapabilityDiscovery,
  ProviderDiscoveryContext
} from "../../packages/runtime/src/domain/provider-capability-discovery.js";
import type {
  CommandRunner,
  RunResult
} from "../../packages/runtime/src/infrastructure/process/command-runner.js";
import { NodeCommandRunner } from "../../packages/runtime/src/infrastructure/process/command-runner.js";
import {
  claudeAgentLauncher,
  codexAgentLauncher
} from "../../packages/runtime/src/infrastructure/providers/agent-launchers.js";
import { parseCodexModels } from "../../packages/runtime/src/infrastructure/providers/codex-capability-discovery.js";
import {
  LocalProviderCatalog,
  ProviderCapabilityCache,
  type ProviderBinaryLocator
} from "../../packages/runtime/src/infrastructure/providers/local-provider-catalog.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function discoveredModels() {
  return {
    defaultModel: "gpt-test",
    models: [
      {
        id: "gpt-test",
        label: "GPT Test",
        description: null,
        defaultReasoning: "high",
        reasoningOptions: [{ id: "high", label: "High" }]
      }
    ]
  };
}

function discovery(
  discover: ProviderCapabilityDiscovery["discover"] = vi.fn(() =>
    Promise.resolve(discoveredModels())
  )
): ProviderCapabilityDiscovery {
  return { id: "codex", discover };
}

function locator(candidates: readonly string[] = ["/opt/codex"]): ProviderBinaryLocator {
  return { candidates: vi.fn(() => Promise.resolve(candidates)) };
}

function versionRunner(version = "codex-cli 1.2.3") {
  return {
    run: vi.fn(() => Promise.resolve({ stdout: `${version}\n`, stderr: "" }))
  };
}

describe("LocalProviderCatalog", () => {
  it("allows default executable discovery to finish legitimately after two seconds", async () => {
    vi.useFakeTimers();
    const delayedLocator: ProviderBinaryLocator = {
      candidates: () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve(["/opt/codex"]);
          }, 2_100);
        })
    };
    const catalog = new LocalProviderCatalog(
      [codexAgentLauncher],
      [discovery()],
      delayedLocator,
      versionRunner(),
      { workspace: "/work/project" }
    );

    const listed = catalog.list();
    await vi.advanceTimersByTimeAsync(2_100);
    await expect(listed).resolves.toEqual([
      expect.objectContaining({ id: "codex", available: true, source: "live" })
    ]);
  });

  it("reports a bounded unavailable result when default executable discovery never resolves", async () => {
    vi.useFakeTimers();
    const stalledLocator: ProviderBinaryLocator = {
      candidates: () => new Promise<readonly string[]>(() => undefined)
    };
    const catalog = new LocalProviderCatalog(
      [codexAgentLauncher],
      [discovery()],
      stalledLocator,
      versionRunner(),
      { workspace: "/work/project" }
    );

    const listed = catalog.list();
    await vi.advanceTimersByTimeAsync(4_250);
    await expect(listed).resolves.toEqual([
      expect.objectContaining({
        available: false,
        source: "unavailable",
        reason: "Codex executable discovery timed out."
      })
    ]);
  });

  it("uses the catalog ceiling when a fake version runner ignores its command timeout", async () => {
    const stalledRunner: CommandRunner = {
      run: () => new Promise<RunResult>(() => undefined)
    };
    const catalog = new LocalProviderCatalog(
      [codexAgentLauncher],
      [discovery()],
      locator(),
      stalledRunner,
      { workspace: "/work/project", versionTimeoutMs: 10, catalogTimeoutMs: 30 }
    );

    await expect(catalog.list()).resolves.toEqual([
      expect.objectContaining({
        available: false,
        source: "unavailable",
        reason: "Codex provider catalog timed out."
      })
    ]);
  });

  it("degrades one stalled provider without hanging catalog aggregation", async () => {
    const stalledClaude: ProviderCapabilityDiscovery = {
      id: "claude",
      discover: () => new Promise(() => undefined)
    };
    const catalog = new LocalProviderCatalog(
      [codexAgentLauncher, claudeAgentLauncher],
      [discovery(), stalledClaude],
      locator(),
      versionRunner(),
      { workspace: "/work/project", discoveryTimeoutMs: 10, catalogTimeoutMs: 100 }
    );

    await expect(catalog.list()).resolves.toEqual([
      expect.objectContaining({ id: "codex", available: true, source: "live" }),
      expect.objectContaining({
        id: "claude",
        available: true,
        source: "fallback",
        reason: "Model discovery failed: Claude model catalog timed out."
      })
    ]);
  });

  it("caps candidate probing before a large locator result can amplify latency", async () => {
    const runner: CommandRunner = {
      run: vi.fn(() => Promise.reject(new Error("bad executable")))
    };
    const catalog = new LocalProviderCatalog(
      [codexAgentLauncher],
      [discovery()],
      locator(Array.from({ length: 20 }, (_value, index) => `/opt/codex-${String(index)}`)),
      runner,
      { workspace: "/work/project", maxCandidates: 3 }
    );

    await expect(catalog.list()).resolves.toEqual([
      expect.objectContaining({ available: false, source: "unavailable" })
    ]);
    expect(runner.run).toHaveBeenCalledTimes(3);
  });

  it("reports and resolves an installed CLI while caching its exact capabilities", async () => {
    const runner = versionRunner();
    const discoverModels = vi.fn(() => Promise.resolve(discoveredModels()));
    const modelDiscovery = discovery(discoverModels);
    const catalog = new LocalProviderCatalog(
      [codexAgentLauncher],
      [modelDiscovery],
      locator(),
      runner,
      { workspace: "/work/project", cacheDurationMs: 5_000, now: () => 100 }
    );

    await expect(catalog.list()).resolves.toEqual([
      expect.objectContaining({
        id: "codex",
        available: true,
        version: "codex-cli 1.2.3",
        source: "live",
        defaultModel: "gpt-test"
      })
    ]);
    await expect(catalog.resolve("codex")).resolves.toMatchObject({
      executable: "/opt/codex",
      version: "codex-cli 1.2.3",
      launcher: codexAgentLauncher,
      capability: { source: "cache" }
    });
    expect(runner.run).toHaveBeenCalledTimes(1);
    expect(runner.run).toHaveBeenCalledWith(
      "/opt/codex",
      ["--version"],
      expect.objectContaining({ cleanupProcessTree: true })
    );
    expect(discoverModels).toHaveBeenCalledTimes(1);
  });

  it("reports a missing CLI without failing the provider list", async () => {
    const runner: CommandRunner = {
      run(): Promise<RunResult> {
        throw new Error("Version probing should not run without a candidate.");
      }
    };
    const catalog = new LocalProviderCatalog(
      [codexAgentLauncher],
      [discovery()],
      locator([]),
      runner,
      { workspace: "/work/project" }
    );

    await expect(catalog.list()).resolves.toEqual([
      expect.objectContaining({
        id: "codex",
        available: false,
        version: null,
        source: "unavailable",
        reason: "Executable not found."
      })
    ]);
    await expect(catalog.resolve("codex")).resolves.toBeNull();
  });

  it("does not create a version-ambiguous cache entry", async () => {
    const catalog = new LocalProviderCatalog(
      [codexAgentLauncher],
      [discovery()],
      locator(),
      versionRunner(""),
      { workspace: "/work/project" }
    );

    await expect(catalog.list()).resolves.toEqual([
      expect.objectContaining({
        available: false,
        source: "unavailable",
        reason: "Version probe returned no version."
      })
    ]);
  });

  it("cleans an ignored-TERM version process tree after a timeout", async () => {
    const fixture = createIgnoredTermVersionFixture("version-timeout-", 'wait "$child_pid"');
    const catalog = new LocalProviderCatalog(
      [codexAgentLauncher],
      [discovery()],
      locator([fixture.executable]),
      new NodeCommandRunner({ gracefulShutdownMs: 25, forcedShutdownMs: 1_000 }),
      { workspace: fixture.root, versionTimeoutMs: 250 }
    );

    await expect(catalog.list()).resolves.toEqual([
      expect.objectContaining({
        available: false,
        source: "unavailable",
        reason: expect.stringContaining("timed out after 250 milliseconds")
      })
    ]);
    expectProcessGone(readPid(fixture.leaderPidPath));
    expectProcessGone(readPid(fixture.childPidPath));
  });

  it("cleans lingering version-probe descendants before rejecting malformed output", async () => {
    const fixture = createIgnoredTermVersionFixture("version-malformed-", "printf '%s\\n' '   '");
    const catalog = new LocalProviderCatalog(
      [codexAgentLauncher],
      [discovery()],
      locator([fixture.executable]),
      new NodeCommandRunner({ gracefulShutdownMs: 25, forcedShutdownMs: 1_000 }),
      { workspace: fixture.root, versionTimeoutMs: 1_000 }
    );

    await expect(catalog.list()).resolves.toEqual([
      expect.objectContaining({
        available: false,
        source: "unavailable",
        reason: "Version probe returned no version."
      })
    ]);
    expectProcessGone(readPid(fixture.leaderPidPath));
    expectProcessGone(readPid(fixture.childPidPath));
  });

  it("deduplicates concurrent probes", async () => {
    let release!: (value: ReturnType<typeof discoveredModels>) => void;
    const discover = vi.fn(
      () =>
        new Promise<ReturnType<typeof discoveredModels>>((resolve) => {
          release = resolve;
        })
    );
    const runner = versionRunner();
    const catalog = new LocalProviderCatalog(
      [codexAgentLauncher],
      [discovery(discover)],
      locator(),
      runner,
      { workspace: "/work/project" }
    );

    const listed = catalog.list();
    const resolved = catalog.resolve("codex");
    await vi.waitFor(() => {
      expect(discover).toHaveBeenCalledTimes(1);
    });
    release(discoveredModels());
    await Promise.all([listed, resolved]);
    expect(runner.run).toHaveBeenCalledTimes(1);
  });

  it("uses an exact-version last-known-good catalog after a failed refresh", async () => {
    let now = 0;
    const discover = vi
      .fn<ProviderCapabilityDiscovery["discover"]>()
      .mockResolvedValueOnce(discoveredModels())
      .mockRejectedValueOnce(new Error("catalog timeout"));
    const catalog = new LocalProviderCatalog(
      [codexAgentLauncher],
      [discovery(discover)],
      locator(),
      versionRunner(),
      { workspace: "/work/project", cacheDurationMs: 5, now: () => now }
    );

    await expect(catalog.list()).resolves.toEqual([
      expect.objectContaining({
        source: "live",
        models: [expect.objectContaining({ id: "gpt-test" })]
      })
    ]);
    now = 10;
    await expect(catalog.list()).resolves.toEqual([
      expect.objectContaining({
        source: "stale",
        reason: "Using last known models: catalog timeout",
        models: [expect.objectContaining({ id: "gpt-test" })]
      })
    ]);
  });

  it("fails closed instead of reusing stale capabilities for a spaced ultra default", async () => {
    let now = 0;
    const discover = vi
      .fn<ProviderCapabilityDiscovery["discover"]>()
      .mockResolvedValueOnce(discoveredModels())
      .mockImplementationOnce(() =>
        Promise.resolve(
          parseCodexModels([
            {
              model: "gpt-spaced-ultra",
              displayName: "GPT Spaced Ultra",
              description: "Unsafe implicit default",
              hidden: false,
              supportedReasoningEfforts: [
                { reasoningEffort: " high ", description: "High" },
                { reasoningEffort: " ultra ", description: "Automatic delegation" }
              ],
              defaultReasoningEffort: " ultra ",
              isDefault: true
            }
          ])
        )
      );
    const catalog = new LocalProviderCatalog(
      [codexAgentLauncher],
      [discovery(discover)],
      locator(),
      versionRunner(),
      { workspace: "/work/project", cacheDurationMs: 5, now: () => now }
    );

    await expect(catalog.list()).resolves.toEqual([
      expect.objectContaining({ source: "live", available: true })
    ]);
    now = 10;
    await expect(catalog.list()).resolves.toEqual([
      expect.objectContaining({
        source: "unavailable",
        available: false,
        reason: expect.stringContaining("defaults to ultra")
      })
    ]);
    await expect(catalog.resolve("codex")).resolves.toBeNull();
  });

  it("does not reuse stale capabilities across CLI versions", async () => {
    let now = 0;
    let version = "codex-cli 1";
    const runner: CommandRunner = {
      run: vi.fn(() => Promise.resolve({ stdout: version, stderr: "" }))
    };
    const discover = vi
      .fn<ProviderCapabilityDiscovery["discover"]>()
      .mockResolvedValueOnce(discoveredModels())
      .mockRejectedValueOnce(new Error("new catalog unavailable"));
    const catalog = new LocalProviderCatalog(
      [codexAgentLauncher],
      [discovery(discover)],
      locator(),
      runner,
      { workspace: "/work/project", cacheDurationMs: 5, now: () => now }
    );

    await catalog.list();
    now = 10;
    version = "codex-cli 2";
    await expect(catalog.list()).resolves.toEqual([
      expect.objectContaining({ source: "fallback", version: "codex-cli 2", models: [] })
    ]);
  });

  it("does not collide long version identities that share a truncated display prefix", async () => {
    let now = 0;
    const sharedPrefix = `codex-cli ${"v".repeat(220)}`;
    let version = `${sharedPrefix}-one`;
    const runner: CommandRunner = {
      run: vi.fn(() => Promise.resolve({ stdout: version, stderr: "" }))
    };
    const discover = vi
      .fn<ProviderCapabilityDiscovery["discover"]>()
      .mockResolvedValueOnce(discoveredModels())
      .mockRejectedValueOnce(new Error("second version unavailable"));
    const catalog = new LocalProviderCatalog(
      [codexAgentLauncher],
      [discovery(discover)],
      locator(),
      runner,
      { workspace: "/work/project", cacheDurationMs: 5, now: () => now }
    );

    const first = await catalog.list();
    expect(first[0]).toMatchObject({ source: "live" });
    const displayedVersion = first[0]?.version;
    now = 10;
    version = `${sharedPrefix}-two`;
    await expect(catalog.list()).resolves.toEqual([
      expect.objectContaining({
        source: "fallback",
        version: displayedVersion,
        models: []
      })
    ]);
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it("keys a shared cache by workspace", async () => {
    const cache = new ProviderCapabilityCache();
    const discover = vi.fn((context: ProviderDiscoveryContext) => {
      const models = discoveredModels();
      const model = models.models[0];
      if (model === undefined) throw new Error("Test model fixture is empty.");
      return Promise.resolve({
        ...models,
        models: [{ ...model, description: context.workspace }]
      });
    });
    const shared = {
      cache,
      cacheDurationMs: 5_000,
      now: () => 100
    };
    const first = new LocalProviderCatalog(
      [codexAgentLauncher],
      [discovery(discover)],
      locator(),
      versionRunner(),
      { ...shared, workspace: "/work/one" }
    );
    const second = new LocalProviderCatalog(
      [codexAgentLauncher],
      [discovery(discover)],
      locator(),
      versionRunner(),
      { ...shared, workspace: "/work/two" }
    );

    await Promise.all([first.list(), second.list()]);
    expect(discover).toHaveBeenCalledTimes(2);
    expect(discover.mock.calls.map(([context]) => context.workspace).sort()).toEqual([
      "/work/one",
      "/work/two"
    ]);
  });
});

interface IgnoredTermVersionFixture {
  readonly root: string;
  readonly executable: string;
  readonly leaderPidPath: string;
  readonly childPidPath: string;
}

function createIgnoredTermVersionFixture(prefix: string, body: string): IgnoredTermVersionFixture {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  const executable = join(root, "provider");
  const leaderPidPath = join(root, "leader-pid");
  const childPidPath = join(root, "child-pid");
  writeFileSync(
    executable,
    `#!/bin/sh
printf '%s' "$$" > '${leaderPidPath}'
trap '' TERM
sleep 1000 >/dev/null 2>&1 &
child_pid=$!
printf '%s' "$child_pid" > '${childPidPath}'
${body}
`
  );
  chmodSync(executable, 0o755);
  return { root, executable, leaderPidPath, childPidPath };
}

function readPid(path: string): number {
  const pid = Number(readFileSync(path, "utf8"));
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("Invalid fixture process ID.");
  return pid;
}

function expectProcessGone(pid: number): void {
  try {
    process.kill(pid, 0);
  } catch (error: unknown) {
    expect(error).toMatchObject({ code: "ESRCH" });
    return;
  }
  throw new Error(`Fixture process ${String(pid)} is still running.`);
}
