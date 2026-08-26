import { describe, expect, it } from "vitest";

import {
  parseReleaseManifest,
  releaseDownloadUrl,
  resolveRuntimeTarget
} from "../../packages/launcher/src/manifest.js";

const checksum = "a".repeat(64);

function manifest() {
  return {
    repository: "RiadMefti/agentlab",
    targets: {
      "linux-x64": {
        asset: "agentlab-v0.2.0-linux-x64",
        sha256: checksum,
        size: 12
      },
      "mac-arm64": {
        asset: "agentlab-v0.2.0-mac-arm64",
        sha256: checksum,
        size: 14
      }
    },
    version: "0.2.0"
  };
}

describe("AgentLab release manifest", () => {
  it("validates the exact supported release graph", () => {
    const parsed = parseReleaseManifest(manifest());
    expect(parsed.version).toBe("0.2.0");
    expect(releaseDownloadUrl(parsed, "linux-x64")).toBe(
      "https://github.com/RiadMefti/agentlab/releases/download/v0.2.0/agentlab-v0.2.0-linux-x64"
    );
  });

  it("rejects missing targets and mismatched asset identities", () => {
    const missing = manifest();
    delete (missing.targets as Partial<typeof missing.targets>)["mac-arm64"];
    expect(() => parseReleaseManifest(missing)).toThrow("must be exactly");

    const mismatched = manifest();
    mismatched.targets["linux-x64"].asset = "different-file";
    expect(() => parseReleaseManifest(mismatched)).toThrow("must be agentlab-v0.2.0-linux-x64");
  });

  it("selects only the platforms represented by production assets", () => {
    expect(
      resolveRuntimeTarget({ arch: "x64", glibcVersionRuntime: "2.39", platform: "linux" })
    ).toBe("linux-x64");
    expect(resolveRuntimeTarget({ arch: "arm64", platform: "darwin" })).toBe("mac-arm64");
    expect(() => resolveRuntimeTarget({ arch: "x64", platform: "linux" })).toThrow("glibc");
    expect(() => resolveRuntimeTarget({ arch: "x64", platform: "darwin" })).toThrow(
      "does not support"
    );
  });
});
