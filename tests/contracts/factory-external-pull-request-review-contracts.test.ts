import {
  factoryExternalPullRequestReviewEventSchema,
  factoryExternalPullRequestReviewPolicySchema,
  factoryExternalPullRequestReviewRunSchema
} from "@agentlab/contracts";
import { describe, expect, it } from "vitest";

import {
  registeredExternalPullRequestReviewEvent,
  testExternalPullRequestReviewFixture
} from "../helpers/factory-external-pull-request-review.js";

describe("external pull-request review contracts", () => {
  it("binds an admitted candidate, discovery authority, exact heads, and review authority", () => {
    const fixture = testExternalPullRequestReviewFixture();
    expect(factoryExternalPullRequestReviewRunSchema.parse(fixture.run.value)).toEqual(
      fixture.run.value
    );
    expect(
      factoryExternalPullRequestReviewEventSchema.parse(
        registeredExternalPullRequestReviewEvent(fixture).value
      )
    ).toMatchObject({ kind: "registered", to: "ready" });
  });

  it("rejects remote, network, secret, command, and write authority for every reviewer", () => {
    const fixture = testExternalPullRequestReviewFixture();
    const profile = fixture.policy.reviewerProfiles[0];
    expect(
      factoryExternalPullRequestReviewPolicySchema.safeParse({
        ...fixture.policy,
        reviewerProfiles: [
          {
            ...profile,
            capabilities: {
              ...profile?.capabilities,
              remoteRepository: "read",
              network: { mode: "allowlist", hosts: ["api.github.com"] }
            }
          }
        ],
        minimumIndependentReviews: 1
      }).success
    ).toBe(false);
  });

  it("rejects human-routed candidates and review quorums larger than inventory", () => {
    const fixture = testExternalPullRequestReviewFixture();
    expect(
      factoryExternalPullRequestReviewRunSchema.safeParse({
        ...fixture.run.value,
        candidate: { ...fixture.candidate, disposition: "human-review-required" }
      }).success
    ).toBe(false);
    expect(
      factoryExternalPullRequestReviewPolicySchema.safeParse({
        ...fixture.policy,
        reviewerProfiles: [fixture.policy.reviewerProfiles[0]],
        minimumIndependentReviews: 2
      }).success
    ).toBe(false);
  });
});
