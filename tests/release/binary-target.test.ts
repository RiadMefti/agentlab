import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { discoverAnthropicSdkVersionInBinary } from "../../scripts/binary-sbom-correspondence.js";
import { externalNativePackages, resolveBinaryTarget } from "../../scripts/build-binary.js";

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
