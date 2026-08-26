import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  discoverPrebundledPackages,
  parseBunModuleMarkers,
  parseClaudeAgentSdkPrebundle
} from "../../scripts/bun-bundle-provenance.js";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));

describe("Bun prebundle provenance", () => {
  it("parses and deduplicates exact unscoped and scoped package identities", () => {
    const source = [
      "// ../../../node_modules/.bun/plain-package@1.2.3+deadbeef/node_modules/plain-package/index.js",
      "// ../../../node_modules/.bun/@scope+package@4.5.6-beta.1+cafebabe/node_modules/@scope/package/index.js",
      "// ../../../node_modules/.bun/plain-package@1.2.3+deadbeef/node_modules/plain-package/other.js"
    ].join("\n");

    expect(parseBunModuleMarkers(source, "fixture.js")).toEqual([
      { name: "@scope/package", version: "4.5.6-beta.1" },
      { name: "plain-package", version: "1.2.3" }
    ]);
  });

  it("rejects a cache entry whose identity disagrees with its module path", () => {
    const source =
      "// ../../../node_modules/.bun/other-package@1.2.3+deadbeef/node_modules/plain-package/index.js";

    expect(() => parseBunModuleMarkers(source, "fixture.js")).toThrow(
      "Bun module marker in fixture.js has an inconsistent package identity."
    );
  });

  it("extracts the exact Anthropic SDK bound to the opaque Claude runtime", () => {
    expect(parseClaudeAgentSdkPrebundle(claudeBundle(), "sdk.mjs", "0.3.239")).toEqual({
      name: "@anthropic-ai/sdk",
      version: "0.112.1",
      provenance: "anthropic-stainless-runtime-marker"
    });
  });

  it("fails closed when the Claude wrapper or Stainless runtime marker changes", () => {
    expect(() => parseClaudeAgentSdkPrebundle(claudeBundle(), "sdk.mjs", "0.3.240")).toThrow(
      "does not match its locked wrapper version"
    );
    expect(() =>
      parseClaudeAgentSdkPrebundle(
        claudeBundle().replace(/,second:\{"X-Stainless-Package-Version":SdkVersion\}/u, ""),
        "sdk.mjs",
        "0.3.239"
      )
    ).toThrow("is missing or inconsistent");
  });

  it("recognizes the exact SDK embedded by the real installed Claude package", async () => {
    const packagePath = join(projectRoot, "node_modules", "@anthropic-ai", "claude-agent-sdk");
    const [source, packageSource] = await Promise.all([
      readFile(join(packagePath, "sdk.mjs"), "utf8"),
      readFile(join(packagePath, "package.json"), "utf8")
    ]);
    const packageJson = JSON.parse(packageSource) as { readonly version?: unknown };
    if (typeof packageJson.version !== "string") throw new Error("Claude SDK version is missing.");

    expect(parseClaudeAgentSdkPrebundle(source, "real sdk.mjs", packageJson.version)).toMatchObject(
      {
        name: "@anthropic-ai/sdk",
        version: "0.112.1"
      }
    );
  });

  it("rejects an unrecognized Claude package input instead of silently omitting its bundle", async () => {
    const root = await mkdtemp(join(tmpdir(), "orchestrator-opaque-prebundle-"));
    const inputPath = "node_modules/@anthropic-ai/claude-agent-sdk/bridge.mjs";
    const owner = "node_modules/@anthropic-ai/claude-agent-sdk";
    try {
      await mkdir(dirname(join(root, inputPath)), { recursive: true });
      await writeFile(join(root, inputPath), "export {};\n", { encoding: "utf8", flag: "wx" });
      await expect(
        discoverPrebundledPackages({
          rootPath: root,
          inputPaths: [inputPath],
          ownerByInput: new Map([[inputPath, owner]]),
          ownerVersionByInput: new Map([[inputPath, "0.3.239"]])
        })
      ).rejects.toThrow("has no supported sdk.mjs provenance input");
    } finally {
      await rm(dirname(join(root, inputPath)), { force: true, recursive: true });
      await rm(root, { force: true, recursive: true });
    }
  });
});

function claudeBundle(): string {
  return [
    "// Version: 0.3.239",
    'var SdkVersion="0.112.1";',
    'const headers={first:{"X-Stainless-Package-Version":SdkVersion},second:{"X-Stainless-Package-Version":SdkVersion}};',
    'const runtime={baseURL:"https://api.anthropic.com",language:"X-Stainless-Lang"};',
    "export {headers,runtime};"
  ].join("\n");
}
