import {
  factoryExternalPullRequestRepairAdmissionPolicySchema,
  factoryExternalPullRequestRepairDecisionSchema
} from "@agentlab/contracts";
import { describe, expect, it } from "vitest";

import { testExternalPullRequestRepairAdmissionFixture } from "../helpers/factory-external-pull-request-repair-admission.js";
import { testDigest } from "../helpers/factory.js";

describe("external pull-request repair admission contracts", () => {
  it("pins the complete downstream authority and rejects duplicate skill packages", () => {
    const fixture = testExternalPullRequestRepairAdmissionFixture();
    expect(fixture.policy.maximumRiskTier).toBe("R1");
    expect(fixture.policy.allowForks).toBe(true);
    expect(() =>
      factoryExternalPullRequestRepairAdmissionPolicySchema.parse({
        ...fixture.policy,
        skillPackageDigests: [testDigest("7"), testDigest("7")]
      })
    ).toThrow(/unique/u);
    expect(() =>
      factoryExternalPullRequestRepairAdmissionPolicySchema.parse({
        ...fixture.policy,
        unexpectedRemoteCredential: "token"
      })
    ).toThrow();
  });

  it("requires authorization identity and selected findings to agree with the decision", () => {
    const fixture = testExternalPullRequestRepairAdmissionFixture();
    const decision = {
      schemaVersion: "agentlab.external-pull-request-repair-decision.v1",
      decisionId: "94000000-0000-4000-8000-000000000001",
      repositoryId: fixture.policy.repositoryId,
      pullRequestNumber: 42,
      reviewRunId: fixture.feedback.run.value.reviewRunId,
      reviewRunDigest: fixture.feedback.run.value.reviewRunDigest,
      bundleDigest: fixture.feedback.run.value.bundleDigest,
      feedbackPublicationRunId: fixture.feedback.run.value.publicationRunId,
      feedbackPublicationRunDigest: fixture.feedback.run.digest,
      feedbackRecordDigest: fixture.completedFeedback.record.digest,
      admissionPolicyDigest: fixture.policyDocument.digest,
      status: "authorized",
      reasonCodes: ["external-repair-authorized"],
      authorizationDigest: testDigest("a"),
      selectedFindingCount: 0,
      createdAt: "2026-09-01T12:24:00.000Z",
      actor: {
        kind: "control-plane",
        role: "policy-engine",
        id: "agentlab/external-pull-request-repair-admission",
        sessionId: "94000000-0000-4000-8000-000000000001"
      },
      correlationId: "94000000-0000-4000-8000-000000000002"
    } as const;
    expect(() => factoryExternalPullRequestRepairDecisionSchema.parse(decision)).toThrow(
      /status and authorization fields/u
    );
  });
});
