import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { discoverAnthropicSdkVersionInBinary } from "../../scripts/binary-sbom-correspondence.js";
import { externalNativePackages, resolveBinaryTarget } from "../../scripts/build-binary.js";
import { createRuntimeSmokeSandbox } from "../../scripts/runtime-smoke-sandbox.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true }))
  );
});

describe("terminal binary target", () => {
  it("maps supported release platforms to their native OpenTUI package", () => {
    expect(resolveBinaryTarget("linux", "x64")).toEqual({
      artifactSuffix: "linux-x64",
      nativePackage: "@opentui/core-linux-x64"
    });
    expect(resolveBinaryTarget("darwin", "arm64")).toEqual({
      artifactSuffix: "mac-arm64",
      nativePackage: "@opentui/core-darwin-arm64"
    });
  });

  it("externalizes only native packages for other platforms", () => {
    const target = resolveBinaryTarget("linux", "arm64");
    expect(externalNativePackages(target)).not.toContain(target.nativePackage);
    expect(externalNativePackages(target)).toContain("@opentui/core-darwin-arm64");
  });

  it("rejects platforms without tmux support", () => {
    expect(() => resolveBinaryTarget("win32", "x64")).toThrow("Unsupported binary target");
  });

  it("isolates runtime smokes from operator data, credentials, and tmux", async () => {
    const sandbox = await createRuntimeSmokeSandbox("agentlab-binary-smoke-test-", {
      AGENTLAB_CACHE_PATH: "/operator/cache/agentlab",
      AGENTLAB_CODEX_BIN: "/operator/bin/codex",
      AGENTLAB_DATABASE_PATH: "/operator/data/agentlab.sqlite",
      HOME: "/operator/home",
      LANG: "en_CA.UTF-8",
      OPENAI_API_KEY: "must-not-cross-the-smoke-boundary",
      PATH: "/trusted/bin",
      TMUX: "/operator/tmux,123,0",
      TMUX_TMPDIR: "/operator/tmux",
      XDG_CACHE_HOME: "/operator/cache",
      XDG_CONFIG_HOME: "/operator/config",
      XDG_DATA_HOME: "/operator/data",
      XDG_RUNTIME_DIR: "/operator/runtime",
      XDG_STATE_HOME: "/operator/state"
    });
    temporaryDirectories.push(sandbox.rootPath);

    expect(sandbox.environment.PATH).toBe("/trusted/bin");
    expect(sandbox.environment.LANG).toBe("en_CA.UTF-8");
    expect(sandbox.environment.OPENAI_API_KEY).toBeUndefined();
    expect(sandbox.environment.AGENTLAB_CODEX_BIN).toBeUndefined();
    expect(sandbox.environment.TMUX).toBeUndefined();
    expect(sandbox.environment.AGENTLAB_DATABASE_PATH).toBe(
      join(sandbox.rootPath, "data", "agentlab", "agentlab.sqlite")
    );
    expect(sandbox.environment.AGENTLAB_CACHE_PATH).toBe(
      join(sandbox.rootPath, "cache", "agentlab")
    );
    expect(Object.keys(sandbox.environment).sort()).toEqual([
      "AGENTLAB_CACHE_PATH",
      "AGENTLAB_DATABASE_PATH",
      "HOME",
      "LANG",
      "PATH",
      "TERM",
      "TMPDIR",
      "TMUX_TMPDIR",
      "XDG_CACHE_HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_RUNTIME_DIR",
      "XDG_STATE_HOME"
    ]);

    for (const name of [
      "HOME",
      "TMPDIR",
      "TMUX_TMPDIR",
      "XDG_CACHE_HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_RUNTIME_DIR",
      "XDG_STATE_HOME",
      "AGENTLAB_CACHE_PATH",
      "AGENTLAB_DATABASE_PATH"
    ] as const) {
      const path = sandbox.environment[name];
      if (path === undefined) throw new Error(`Missing isolated ${name} path.`);
      expect(isAbsolute(path)).toBe(true);
      const fromRoot = relative(sandbox.rootPath, path);
      expect(fromRoot).not.toBe("..");
      expect(fromRoot.startsWith(`..${sep}`)).toBe(false);
      expect(isAbsolute(fromRoot)).toBe(false);
    }

    expect((await stat(sandbox.rootPath)).mode & 0o777).toBe(0o700);
    await sandbox.dispose();
    await sandbox.dispose();
    await expect(stat(sandbox.rootPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("extracts the opaque Anthropic SDK marker across compiled-binary chunks", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentlab-binary-provenance-"));
    temporaryDirectories.push(root);
    const binaryPath = join(root, "agentlab");
    const prefix = Buffer.alloc(1024 * 1024 - 96);
    const marker = Buffer.from(
      [
        "https://api.anthropic.com X-Stainless-Lang;",
        'var RuntimeVersion="0.112.1";',
        'const a={"X-Stainless-Package-Version":RuntimeVersion};',
        'const b={"X-Stainless-Package-Version":RuntimeVersion};'
      ].join(""),
      "utf8"
    );
    await writeFile(binaryPath, Buffer.concat([prefix, marker]));

    await expect(discoverAnthropicSdkVersionInBinary(binaryPath)).resolves.toBe("0.112.1");
  });

  it("rejects a compiled marker without independent repeated bindings", async () => {
    const root = await mkdtemp(join(tmpdir(), "agentlab-binary-provenance-"));
    temporaryDirectories.push(root);
    const binaryPath = join(root, "agentlab");
    await writeFile(
      binaryPath,
      'https://api.anthropic.com X-Stainless-Lang;var V="0.112.1";{"X-Stainless-Package-Version":V}'
    );

    await expect(discoverAnthropicSdkVersionInBinary(binaryPath)).rejects.toThrow(
      "has no unambiguous Anthropic SDK marker"
    );
  });
});
