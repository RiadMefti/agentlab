import {
  factoryExternalPullRequestFeedbackPolicySchema,
  type FactoryExternalPullRequestFeedbackEvent,
  type FactoryExternalPullRequestFeedbackRun,
  type Sha256Digest
} from "@agentlab/contracts";

import type { CanonicalFactoryDocument } from "../../packages/runtime/src/domain/factory-documents.js";
import { testDigest } from "./factory.js";
import {
  completedExternalPullRequestReviewDocuments,
  testExternalPullRequestReviewFixture
} from "./factory-external-pull-request-review.js";

export const TEST_EXTERNAL_PR_FEEDBACK_RUN_ID = "93000000-0000-4000-8000-000000000001";

export function testExternalPullRequestFeedbackFixture() {
  const review = testExternalPullRequestReviewFixture();
  const completedReview = completedExternalPullRequestReviewDocuments(review);
  const policy = factoryExternalPullRequestFeedbackPolicySchema.parse({
    schemaVersion: "agentlab.external-pull-request-feedback-policy.v1",
    id: "agentlab/external-pull-request-feedback",
    version: "1.0.0",
    repositoryId: review.policy.repositoryId,
    reviewPolicyDigest: review.policyDocument.digest,
    publisherId: "external-review-feedback-broker",
    publisherUserId: 123_456,
    publicationMode: "comment-only",
    maximumPublicationsPerTick: 3,
    maximumReviewAgeHours: 24,
    maximumBodyBytes: 16_000,
    operationDeadlineSeconds: 300,
    maximumRecoveryAttempts: 1
  });
  const policyDocument = review.documents.externalPullRequestFeedbackPolicy(policy);
  const run = review.documents.externalPullRequestFeedbackRun({
    schemaVersion: "agentlab.external-pull-request-feedback-run.v1",
    publicationRunId: TEST_EXTERNAL_PR_FEEDBACK_RUN_ID,
    repositoryId: review.run.value.repositoryId,
    pullRequestNumber: review.run.value.pullRequestNumber,
    reviewRunId: review.run.value.runId,
    reviewRunDigest: review.run.digest,
    reviewRun: review.run.value,
    bundleDigest: completedReview.bundle.digest,
    bundle: completedReview.bundle.value,
    reviewPolicyDigest: review.policyDocument.digest,
    feedbackPolicyDigest: policyDocument.digest,
    feedbackPolicy: policy,
    expectedBaseRevision: review.candidate.base.revision,
    expectedHeadRevision: review.candidate.head.revision,
    bodyArtifact: {
      digest: testDigest("8"),
      sizeBytes: 1_024,
      mediaType: "text/markdown; charset=utf-8"
    },
    marker: `<!-- agentlab-external-review:${completedReview.bundle.digest} -->`,
    createdAt: "2026-09-01T12:18:30.000Z",
    deadlineAt: "2026-09-01T12:23:30.000Z",
    correlationId: review.run.value.correlationId
  });
  return { review, completedReview, policy, policyDocument, run };
}

export function registeredExternalPullRequestFeedbackEvent(
  fixture: ReturnType<typeof testExternalPullRequestFeedbackFixture>
): CanonicalFactoryDocument<FactoryExternalPullRequestFeedbackEvent> {
  return fixture.review.documents.externalPullRequestFeedbackEvent({
    ...feedbackEventBase(fixture.run, 1, null, "93000000-0000-4000-8000-000000000002"),
    kind: "registered",
    from: null,
    to: "ready",
    occurredAt: fixture.run.value.createdAt,
    reasonCode: "completed-review-admitted"
  });
}

export function feedbackEventBase(
  run: CanonicalFactoryDocument<FactoryExternalPullRequestFeedbackRun>,
  sequence: number,
  previousEventDigest: Sha256Digest | null,
  eventId: string
) {
  return {
    schemaVersion: "agentlab.external-pull-request-feedback-event.v1" as const,
    eventId,
    publicationRunId: run.value.publicationRunId,
    runDigest: run.digest,
    sequence,
    previousEventDigest,
    actor: {
      kind: "broker" as const,
      role: "pr-broker" as const,
      id: run.value.feedbackPolicy.publisherId,
      sessionId: run.value.publicationRunId
    },
    occurredAt: `2026-09-01T12:${String(18 + sequence).padStart(2, "0")}:00.000Z`,
    correlationId: run.value.correlationId
  };
}
