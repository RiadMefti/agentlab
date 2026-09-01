import { describe, expect, it } from "vitest";

import { classifyExternalPullRequest } from "../../packages/runtime/src/domain/factory-external-pull-request-policy.js";
import {
  testExternalPullRequestCandidate,
  testExternalPullRequestDiscoveryFixture
} from "../helpers/factory-external-pull-request-discovery.js";

describe("external pull-request discovery policy", () => {
  it("admits a bounded contributor PR only as a read-only review candidate", () => {
    const fixture = testExternalPullRequestDiscoveryFixture();
    const candidate = testExternalPullRequestCandidate();
    const classified = classifyExternalPullRequest({
      pullRequest: withoutDisposition(candidate),
      policy: fixture.policy,
      factoryOwned: false,
      observedAt: "2026-09-01T12:06:00.000Z"
    });
    expect(classified.disposition).toBe("agent-review-candidate");
    expect(classified.reasonCodes).toEqual(["read-only-agent-review-candidate"]);
  });

  it("routes protected, oversized, stale, and unknown-author work to humans", () => {
    const fixture = testExternalPullRequestDiscoveryFixture();
    const changedFile = testExternalPullRequestCandidate().changedFiles[0];
    if (changedFile === undefined) throw new Error("The test candidate has no changed file.");
    const candidate = testExternalPullRequestCandidate({
      author: {
        externalId: "github-user/8",
        login: "outsider",
        kind: "human",
        association: "none"
      },
      createdAt: "2026-06-01T00:00:00.000Z",
      totalChangedFiles: 21,
      filesComplete: false,
      changedFiles: [
        {
          ...changedFile,
          path: ".github/workflows/verify.yml"
        }
      ],
      additions: 600,
      deletions: 0,
      changedLines: 600
    });
    const classified = classifyExternalPullRequest({
      pullRequest: withoutDisposition(candidate),
      policy: fixture.policy,
      factoryOwned: false,
      observedAt: "2026-09-01T12:06:00.000Z"
    });
    expect(classified.disposition).toBe("human-review-required");
    expect(classified.reasonCodes).toEqual([
      "author-association-not-admitted",
      "changed-file-ceiling-exceeded",
      "changed-file-inventory-incomplete",
      "changed-line-ceiling-exceeded",
      "protected-path-change",
      "pull-request-age-ceiling-exceeded"
    ]);
  });

  it("excludes factory-owned PRs and defers drafts before any semantic classification", () => {
    const fixture = testExternalPullRequestDiscoveryFixture();
    const candidate = testExternalPullRequestCandidate();
    expect(
      classifyExternalPullRequest({
        pullRequest: withoutDisposition(candidate),
        policy: fixture.policy,
        factoryOwned: true,
        observedAt: "2026-09-01T12:06:00.000Z"
      }).disposition
    ).toBe("factory-owned");
    expect(
      classifyExternalPullRequest({
        pullRequest: withoutDisposition({ ...candidate, draft: true }),
        policy: fixture.policy,
        factoryOwned: false,
        observedAt: "2026-09-01T12:06:00.000Z"
      }).disposition
    ).toBe("deferred");
  });
});

function withoutDisposition(candidate: ReturnType<typeof testExternalPullRequestCandidate>) {
  const { disposition, reasonCodes, ...remote } = candidate;
  void disposition;
  void reasonCodes;
  return remote;
}
