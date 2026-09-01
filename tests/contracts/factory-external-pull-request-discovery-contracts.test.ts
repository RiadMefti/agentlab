import { describe, expect, it } from "vitest";

import {
  factoryExternalPullRequestCandidateSchema,
  factoryExternalPullRequestDiscoveryPolicySchema,
  factoryExternalPullRequestDiscoverySnapshotSchema
} from "@agentlab/contracts";

import {
  testExternalPullRequestCandidate,
  testExternalPullRequestDiscoveryFixture,
  testExternalPullRequestSnapshot
} from "../helpers/factory-external-pull-request-discovery.js";

describe("external pull-request discovery contracts", () => {
  it("accepts a bounded read-only policy and immutable snapshot", () => {
    const fixture = testExternalPullRequestDiscoveryFixture();
    expect(factoryExternalPullRequestDiscoveryPolicySchema.parse(fixture.policy)).toEqual(
      fixture.policy
    );
    expect(
      factoryExternalPullRequestDiscoverySnapshotSchema.parse(
        testExternalPullRequestSnapshot(fixture).value
      ).counts.agentReviewCandidates
    ).toBe(1);
  });

  it("rejects duplicate policy coordinates and inconsistent candidate facts", () => {
    const fixture = testExternalPullRequestDiscoveryFixture();
    expect(() =>
      factoryExternalPullRequestDiscoveryPolicySchema.parse({
        ...fixture.policy,
        allowedBaseBranches: ["main", "main"]
      })
    ).toThrow(/unique/u);
    expect(() =>
      factoryExternalPullRequestCandidateSchema.parse(
        testExternalPullRequestCandidate({ filesComplete: false })
      )
    ).toThrow(/completeness/u);
    expect(() =>
      factoryExternalPullRequestCandidateSchema.parse(
        testExternalPullRequestCandidate({ changedLines: 7 })
      )
    ).toThrow(/additions plus deletions/u);
  });

  it("keeps contributor text untrusted and bounded", () => {
    const changedFile = testExternalPullRequestCandidate().changedFiles[0];
    if (changedFile === undefined) throw new Error("The test candidate has no changed file.");
    expect(() =>
      factoryExternalPullRequestCandidateSchema.parse(
        testExternalPullRequestCandidate({ untrustedBody: "x".repeat(16_385) })
      )
    ).toThrow();
    expect(() =>
      factoryExternalPullRequestCandidateSchema.parse(
        testExternalPullRequestCandidate({
          changedFiles: [
            {
              ...changedFile,
              path: "bad\npath.ts"
            }
          ]
        })
      )
    ).toThrow(/control/u);
  });
});
