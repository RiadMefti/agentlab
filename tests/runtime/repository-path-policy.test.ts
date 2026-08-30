import { describe, expect, it } from "vitest";

import {
  repositoryPathIsInScope,
  repositoryPathMatches
} from "../../packages/runtime/src/domain/repository-path-policy.js";

describe("repository path policy", () => {
  it("supports exact segments, segment wildcards, and recursive segments", () => {
    expect(repositoryPathMatches("package.json", "**/package.json")).toBe(true);
    expect(repositoryPathMatches("packages/runtime/package.json", "**/package.json")).toBe(true);
    expect(repositoryPathMatches("scripts/check-release.mjs", "scripts/*release*")).toBe(true);
    expect(repositoryPathMatches(".github/workflows/ci.yml", ".github/**")).toBe(true);
    expect(repositoryPathMatches(".github", ".github/**")).toBe(true);
    expect(repositoryPathMatches("docs/readme.md", ".github/**")).toBe(false);
  });

  it("matches Unicode literally and keeps a wildcard within one path segment", () => {
    expect(repositoryPathMatches("docs/🚀-launch.md", "docs/*-launch.md")).toBe(true);
    expect(repositoryPathMatches("docs/nested/launch.md", "docs/*.md")).toBe(false);
  });

  it("gives exclusions precedence over includes", () => {
    expect(
      repositoryPathIsInScope("packages/runtime/src/file.ts", ["packages/**"], ["**/*.snap"])
    ).toBe(true);
    expect(
      repositoryPathIsInScope("packages/runtime/src/file.snap", ["packages/**"], ["**/*.snap"])
    ).toBe(false);
  });
});
