import { factoryPullRequestRepairAuthorizationSchema } from "@agentlab/contracts";
import { describe, expect, it } from "vitest";

describe("factory pull-request repair authorization contracts", () => {
  it("binds one repair to exact facts without carrying untrusted feedback text", () => {
    const authorization = validAuthorization();

    expect(factoryPullRequestRepairAuthorizationSchema.parse(authorization)).toEqual(authorization);
    expect(Object.keys(authorization)).not.toContain("body");
  });

  it("requires selected facts to exactly justify each reason", () => {
    const authorization = validAuthorization();
    expect(
      factoryPullRequestRepairAuthorizationSchema.safeParse({
        ...authorization,
        selectedReviewIds: []
      }).success
    ).toBe(false);
    expect(
      factoryPullRequestRepairAuthorizationSchema.safeParse({
        ...authorization,
        failedChecks: []
      }).success
    ).toBe(false);
    expect(
      factoryPullRequestRepairAuthorizationSchema.safeParse({
        ...authorization,
        selectedReviewIds: ["500", "500"]
      }).success
    ).toBe(false);
  });
});

function validAuthorization() {
  return {
    schemaVersion: "agentlab.pull-request-repair-authorization.v1" as const,
    authorizationId: "11111111-1111-4111-8111-111111111111",
    taskId: "22222222-2222-4222-8222-222222222222",
    contractDigest: digest("1"),
    policyBundleDigest: digest("2"),
    proposalDigest: digest("3"),
    priorPatchProposalDigest: digest("4"),
    pullRequestRecordDigest: digest("5"),
    observationDigest: digest("6"),
    observationEvidenceBundleDigest: digest("7"),
    repositoryId: "riadmefti/agentlab",
    pullRequestNumber: 42,
    headRevision: "a".repeat(40),
    brokerId: "github-app/agentlab",
    contractRepairAttempt: 1,
    reasonCodes: ["review-changes-requested", "trusted-check-failed"] as const,
    selectedReviewIds: ["500"],
    selectedReviewCommentIds: ["600"],
    failedChecks: [
      {
        name: "verify",
        producerId: "github-app/15368",
        runId: "700",
        conclusion: "failure" as const
      }
    ],
    createdAt: "2026-08-30T12:04:00.000Z",
    expiresAt: "2026-08-31T12:04:00.000Z",
    correlationId: "33333333-3333-4333-8333-333333333333"
  };
}

function digest(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}
