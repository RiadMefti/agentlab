import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LocalFactoryWorkerHostInspector } from "../../packages/runtime/src/infrastructure/process/local-factory-worker-host-inspector.js";
import { PinnedFactoryAgentProviderResolver } from "../../packages/runtime/src/infrastructure/providers/pinned-factory-agent-provider-resolver.js";
import type {
  CommandRunner,
  RunOptions,
  RunResult
} from "../../packages/runtime/src/infrastructure/process/command-runner.js";

const executableContent = "#!/bin/sh\n";
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("LocalFactoryWorkerHostInspector", () => {
  it("probes exact local tools and providers without ambient credentials", async () => {
    const fixture = hostFixture();

    await expect(fixture.inspector.inspect()).resolves.toEqual({
      status: "ready",
      reasonCodes: []
    });
    expect(fixture.runner.calls).toHaveLength(8);
    for (const call of fixture.runner.calls) {
      expect(call.args).toEqual(
        call.args[0] === "--user"
          ? ["--user", "show", "--property=Version", "--value"]
          : ["--version"]
      );
      expect(call.options).toMatchObject({
        cwd: fixture.root,
        cleanupProcessTree: true,
        environment: {
          CI: "true",
          LC_ALL: "C",
          NO_COLOR: "1",
          PATH: "/usr/local/bin:/usr/bin:/bin",
          TERM: "dumb"
        }
      });
      expect(call.options.environment).not.toHaveProperty("GH_TOKEN");
      expect(call.options.environment).not.toHaveProperty("GITHUB_TOKEN");
      expect(call.options.environment).not.toHaveProperty("NPM_TOKEN");
    }
    expect(
      fixture.runner.calls.find(({ args }) => args[0] === "--user")?.options.environment
    ).toMatchObject({
      XDG_RUNTIME_DIR: "/run/user/1000",
      DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus"
    });
  });

  it("reports provider digest drift and non-canonical runtime roots without throwing", async () => {
    const fixture = hostFixture();
    writeFileSync(fixture.executable, "#!/bin/sh\n# changed\n", { mode: 0o700 });
    const runtimeAlias = join(fixture.root, "runtime-alias");
    symlinkSync(fixture.runtimeRoot, runtimeAlias, "dir");
    fixture.replaceRuntimeRoot(runtimeAlias);

    await expect(fixture.inspector.inspect()).resolves.toEqual({
      status: "blocked",
      reasonCodes: ["provider-codex-unavailable", "runtime-root-0-unavailable"]
    });
  });

  it("fails closed when either systemd executable has another identity", async () => {
    const fixture = hostFixture({ systemdVersion: "systemd 999" });

    await expect(fixture.inspector.inspect()).resolves.toEqual({
      status: "blocked",
      reasonCodes: [
        "systemctl-identity-unverified",
        "systemd-run-identity-unverified",
        "systemd-user-manager-identity-unverified"
      ]
    });
  });

  it("fails closed when a worker-owned root is accessible by another user", async () => {
    const fixture = hostFixture();
    chmodSync(fixture.artifactRoot, 0o750);

    await expect(fixture.inspector.inspect()).resolves.toEqual({
      status: "blocked",
      reasonCodes: ["artifact-root-unavailable"]
    });
  });
});

class VersionRunner implements CommandRunner {
  public readonly calls: {
    readonly executable: string;
    readonly args: readonly string[];
    readonly options: RunOptions;
  }[] = [];

  public run(
    executable: string,
    args: readonly string[],
    options: RunOptions = {}
  ): Promise<RunResult> {
    this.calls.push({ executable, args, options });
    return Promise.resolve({
      stdout: args[0] === "--user" ? "261\n" : "systemd 261\n",
      stderr: ""
    });
  }
}

function hostFixture(options: { readonly systemdVersion?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "agentlab-worker-host-"));
  temporaryRoots.push(root);
  const executable = join(root, "tool");
  writeFileSync(executable, executableContent, { mode: 0o700 });
  chmodSync(executable, 0o700);
  const runtimeRoot = join(root, "runtime");
  mkdirSync(runtimeRoot, { mode: 0o700 });
  const artifactRoot = join(root, "artifacts");
  const workspaceRoot = join(root, "worktrees");
  mkdirSync(artifactRoot, { mode: 0o700 });
  mkdirSync(workspaceRoot, { mode: 0o700 });
  const runner = new VersionRunner();
  const providers = new PinnedFactoryAgentProviderResolver(runner, {
    bindings: [
      {
        provider: "codex",
        executable,
        executableDigest: `sha256:${createHash("sha256").update(executableContent).digest("hex")}`,
        version: "systemd 261"
      }
    ]
  });
  let inspector = createInspector(runtimeRoot);
  return {
    root,
    executable,
    runtimeRoot,
    artifactRoot,
    runner,
    get inspector() {
      return inspector;
    },
    replaceRuntimeRoot(path: string) {
      inspector = createInspector(path);
    }
  };

  function createInspector(runtimePath: string) {
    return new LocalFactoryWorkerHostInspector(runner, {
      workingDirectory: root,
      artifactRoot,
      workspaceRoot,
      gitExecutable: executable,
      flockExecutable: executable,
      systemdRunExecutable: executable,
      systemdControlExecutable: executable,
      environmentExecutable: executable,
      systemdVersion: options.systemdVersion ?? "systemd 261",
      bubblewrapExecutable: executable,
      runtimeRoots: [runtimePath],
      gates: [
        {
          id: "format",
          evidenceKind: "test",
          command: { executable, args: [] },
          timeoutMs: 1_000,
          maximumOutputBytes: 1_024
        }
      ],
      configuredProviders: ["codex"],
      providers,
      hostEnvironment: {
        XDG_RUNTIME_DIR: "/run/user/1000",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus"
      }
    });
  }
}
