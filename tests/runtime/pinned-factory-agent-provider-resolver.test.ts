import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { PinnedFactoryAgentProviderResolver } from "../../packages/runtime/src/infrastructure/providers/pinned-factory-agent-provider-resolver.js";
import type {
  CommandRunner,
  RunOptions,
  RunResult
} from "../../packages/runtime/src/infrastructure/process/command-runner.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("PinnedFactoryAgentProviderResolver", () => {
  it("resolves one exact canonical binary through a scrubbed version probe", async () => {
    const root = temporaryRoot();
    const executable = executableFile(root, "codex");
    const runner = new VersionRunner("mise warning\ncodex-cli 1.2.3\n");
    const resolver = new PinnedFactoryAgentProviderResolver(runner, {
      bindings: [providerBinding(executable)]
    });

    await expect(resolver.resolve("codex", root)).resolves.toEqual({
      executable,
      version: "codex-cli 1.2.3"
    });
    expect(runner.calls).toEqual([
      expect.objectContaining({
        executable,
        args: ["--version"],
        options: expect.objectContaining({
          cwd: root,
          cleanupProcessTree: true,
          environment: {
            CI: "true",
            LC_ALL: "C",
            NO_COLOR: "1",
            PATH: "/usr/local/bin:/usr/bin:/bin",
            TERM: "dumb"
          }
        })
      })
    ]);
    const environment = runner.calls[0]?.options.environment ?? {};
    expect(environment).not.toHaveProperty("GH_TOKEN");
    expect(environment).not.toHaveProperty("GITHUB_TOKEN");
    expect(environment).not.toHaveProperty("NPM_TOKEN");
  });

  it("returns null without probing an unconfigured provider", async () => {
    const root = temporaryRoot();
    const runner = new VersionRunner("codex-cli 1.2.3\n");
    const resolver = new PinnedFactoryAgentProviderResolver(runner, {
      bindings: [providerBinding(executableFile(root, "codex"))]
    });

    await expect(resolver.resolve("claude", root)).resolves.toBeNull();
    await expect(resolver.resolve("opencode", root)).resolves.toBeNull();
    expect(runner.calls).toEqual([]);
  });

  it("rejects version drift and symbolic executable or workspace aliases", async () => {
    const root = temporaryRoot();
    const executable = executableFile(root, "codex");
    const resolver = new PinnedFactoryAgentProviderResolver(new VersionRunner("codex-cli 9.9.9"), {
      bindings: [providerBinding(executable)]
    });
    await expect(resolver.resolve("codex", root)).rejects.toThrow("does not match");

    writeFileSync(executable, "#!/bin/sh\n# replaced\n", { encoding: "utf8", mode: 0o700 });
    const changedExecutable = new PinnedFactoryAgentProviderResolver(
      new VersionRunner("codex-cli 1.2.3"),
      { bindings: [providerBinding(executable)] }
    );
    await expect(changedExecutable.resolve("codex", root)).rejects.toThrow(
      "executable digest does not match"
    );
    writeFileSync(executable, "#!/bin/sh\n", { encoding: "utf8", mode: 0o700 });

    const executableAlias = join(root, "codex-alias");
    symlinkSync(executable, executableAlias);
    const aliasedExecutable = new PinnedFactoryAgentProviderResolver(
      new VersionRunner("codex-cli 1.2.3"),
      { bindings: [providerBinding(executableAlias)] }
    );
    await expect(aliasedExecutable.resolve("codex", root)).rejects.toThrow("symlink-free");

    const workspaceAlias = `${root}-alias`;
    temporaryRoots.push(workspaceAlias);
    symlinkSync(root, workspaceAlias, "dir");
    const aliasedWorkspace = new PinnedFactoryAgentProviderResolver(
      new VersionRunner("codex-cli 1.2.3"),
      { bindings: [providerBinding(executable)] }
    );
    await expect(aliasedWorkspace.resolve("codex", workspaceAlias)).rejects.toThrow("canonical");
  });

  it("rejects duplicate, unsupported, and unsafe bindings or timeouts", () => {
    const root = temporaryRoot();
    const executable = executableFile(root, "codex");
    expect(
      () =>
        new PinnedFactoryAgentProviderResolver(new VersionRunner(""), {
          bindings: [
            { ...providerBinding(executable), version: "1" },
            { ...providerBinding(executable), version: "1" }
          ]
        })
    ).toThrow("unique provider IDs");
    expect(
      () =>
        new PinnedFactoryAgentProviderResolver(new VersionRunner(""), {
          bindings: [{ ...providerBinding(executable), provider: "opencode", version: "1" }]
        } as never)
    ).toThrow();
    expect(
      () =>
        new PinnedFactoryAgentProviderResolver(new VersionRunner(""), {
          bindings: [{ ...providerBinding(executable), version: "1" }],
          versionTimeoutMs: 0
        })
    ).toThrow("bounded positive integer");
  });
});

class VersionRunner implements CommandRunner {
  public readonly calls: {
    readonly executable: string;
    readonly args: readonly string[];
    readonly options: RunOptions;
  }[] = [];

  public constructor(private readonly output: string) {}

  public run(
    executable: string,
    args: readonly string[],
    options: RunOptions = {}
  ): Promise<RunResult> {
    this.calls.push({ executable, args, options });
    return Promise.resolve({ stdout: this.output, stderr: "" });
  }
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agentlab-pinned-provider-"));
  temporaryRoots.push(root);
  return root;
}

function executableFile(root: string, name: string): string {
  const path = join(root, name);
  writeFileSync(path, "#!/bin/sh\n", { encoding: "utf8", mode: 0o700 });
  chmodSync(path, 0o700);
  return path;
}

function providerBinding(executable: string) {
  return {
    provider: "codex" as const,
    executable,
    executableDigest: `sha256:${createHash("sha256").update("#!/bin/sh\n").digest("hex")}` as const,
    version: "codex-cli 1.2.3"
  };
}
