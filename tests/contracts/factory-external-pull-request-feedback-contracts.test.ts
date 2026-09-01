import {
  factoryExternalPullRequestFeedbackEventSchema,
  factoryExternalPullRequestFeedbackPolicySchema,
  factoryExternalPullRequestFeedbackRecordSchema,
  factoryExternalPullRequestFeedbackRunSchema
} from "@agentlab/contracts";
import { describe, expect, it } from "vitest";

import {
  registeredExternalPullRequestFeedbackEvent,
  testExternalPullRequestFeedbackFixture
} from "../helpers/factory-external-pull-request-feedback.js";

describe("external PR feedback contracts", () => {
  it("pins a comment-only publisher to one completed review bundle and exact head", () => {
    const fixture = testExternalPullRequestFeedbackFixture();
    expect(factoryExternalPullRequestFeedbackPolicySchema.parse(fixture.policy)).toEqual(
      fixture.policy
    );
    expect(factoryExternalPullRequestFeedbackRunSchema.parse(fixture.run.value)).toEqual(
      fixture.run.value
    );
    expect(
      factoryExternalPullRequestFeedbackEventSchema.parse(
        registeredExternalPullRequestFeedbackEvent(fixture).value
      )
    ).toMatchObject({ kind: "registered", to: "ready" });
  });

  it("rejects widened publication authority and inconsistent remote evidence", () => {
    const fixture = testExternalPullRequestFeedbackFixture();
    expect(() =>
      factoryExternalPullRequestFeedbackPolicySchema.parse({
        ...fixture.policy,
        publicationMode: "approve"
      })
    ).toThrow();
    expect(() =>
      factoryExternalPullRequestFeedbackRunSchema.parse({
        ...fixture.run.value,
        expectedHeadRevision: "a".repeat(40)
      })
    ).toThrow(/exact completed review/u);
    expect(() =>
      factoryExternalPullRequestFeedbackRecordSchema.parse({
        schemaVersion: "agentlab.external-pull-request-feedback-record.v1",
        publicationRunId: fixture.run.value.publicationRunId,
        runDigest: fixture.run.digest,
        bundleDigest: fixture.run.value.bundleDigest,
        repositoryId: fixture.run.value.repositoryId,
        pullRequestNumber: fixture.run.value.pullRequestNumber,
        headRevision: fixture.run.value.expectedHeadRevision,
        publisherId: fixture.policy.publisherId,
        publisherUserId: fixture.policy.publisherUserId,
        remoteReviewId: "100",
        remoteState: "approved",
        remoteUrl: null,
        bodyDigest: fixture.run.value.bodyArtifact.digest,
        remoteSubmittedAt: "2026-09-01T12:20:00.000Z",
        observedAt: "2026-09-01T12:20:01.000Z",
        source: "posted"
      })
    ).toThrow();
  });
});
