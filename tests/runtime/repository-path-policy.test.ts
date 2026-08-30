import { describe, expect, it } from "vitest";

import {
  repositoryPathIsInScope,
  repositoryPathMatches,
  repositoryPatternsMayOverlap
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

  it("detects exact, segment-wildcard, and recursive scope overlap", () => {
    expect(repositoryPatternsMayOverlap(".github/**", ".github/workflows/*.yml")).toBe(true);
    expect(
      repositoryPatternsMayOverlap("packages/*/src/**", "packages/runtime/src/factory.ts")
    ).toBe(true);
    expect(repositoryPatternsMayOverlap("**/*auth*", "tests/authentication.test.ts")).toBe(true);
    expect(repositoryPatternsMayOverlap("tests/runtime/exact.test.ts", "**/*security*")).toBe(
      false
    );
    expect(repositoryPatternsMayOverlap("docs/**", "packages/**")).toBe(false);
  });

  it("requires a non-empty concrete path while allowing recursive alignment", () => {
    expect(repositoryPatternsMayOverlap("**", "**")).toBe(true);
    expect(repositoryPatternsMayOverlap("**/a", "a/**")).toBe(true);
    expect(repositoryPatternsMayOverlap("a/**/b", "c/**/d")).toBe(false);
    expect(repositoryPatternsMayOverlap("a/*/c", "a/b*/c")).toBe(true);
    expect(repositoryPatternsMayOverlap("a/x/c", "a/b*/c")).toBe(false);
  });

  it("agrees with exhaustive witnesses for the bounded glob grammar", () => {
    const segmentPatterns = ["a", "b", "*", "a*", "*b", "**"];
    const patterns = [
      ...segmentPatterns,
      ...segmentPatterns.flatMap((left) => segmentPatterns.map((right) => `${left}/${right}`))
    ];
    const paths = concretePaths(["a", "b", "aa", "ab", "ba", "bb"], 4);

    for (const left of patterns) {
      for (const right of patterns) {
        const witnessed = paths.some(
          (path) => repositoryPathMatches(path, left) && repositoryPathMatches(path, right)
        );
        expect(repositoryPatternsMayOverlap(left, right), `${left} ∩ ${right}`).toBe(witnessed);
      }
    }
  });
});

function concretePaths(segments: readonly string[], maximumDepth: number): readonly string[] {
  const paths: string[] = [];
  let level = [""];
  for (let depth = 1; depth <= maximumDepth; depth += 1) {
    level = level.flatMap((prefix) =>
      segments.map((segment) => (prefix.length === 0 ? segment : `${prefix}/${segment}`))
    );
    paths.push(...level);
  }
  return paths;
}
