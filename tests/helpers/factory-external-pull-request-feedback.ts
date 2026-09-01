import {
  factoryExternalPullRequestFeedbackPolicySchema,
  type FactoryExternalPullRequestFeedbackEvent,
  type FactoryExternalPullRequestFeedbackRecord,
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

export function testExternalPullRequestFeedbackFixture(
  options: {
    readonly reviewDecision?: "split" | "changes-requested" | "approved";
  } = {}
) {
  const review = testExternalPullRequestReviewFixture();
  const completedReview = completedExternalPullRequestReviewDocuments(review, {
    ...(options.reviewDecision === undefined ? {} : { decision: options.reviewDecision })
  });
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

export function completedExternalPullRequestFeedbackDocuments(
  fixture: ReturnType<typeof testExternalPullRequestFeedbackFixture>
): {
  readonly events: readonly CanonicalFactoryDocument<FactoryExternalPullRequestFeedbackEvent>[];
  readonly record: CanonicalFactoryDocument<FactoryExternalPullRequestFeedbackRecord>;
} {
  const events: CanonicalFactoryDocument<FactoryExternalPullRequestFeedbackEvent>[] = [
    registeredExternalPullRequestFeedbackEvent(fixture)
  ];
  events.push(
    fixture.review.documents.externalPullRequestFeedbackEvent({
      ...feedbackEventBase(fixture.run, 2, events.at(-1)?.digest ?? null, feedbackId(3)),
      kind: "remote-verified",
      from: "ready",
      to: "remote-verified",
      reasonCode: "exact-open-head-verified"
    })
  );
  events.push(
    fixture.review.documents.externalPullRequestFeedbackEvent({
      ...feedbackEventBase(fixture.run, 3, events.at(-1)?.digest ?? null, feedbackId(4)),
      kind: "publication-started",
      from: "remote-verified",
      to: "publication-active",
      reasonCode: "comment-publication-intent-recorded"
    })
  );
  const record = fixture.review.documents.externalPullRequestFeedbackRecord({
    schemaVersion: "agentlab.external-pull-request-feedback-record.v1",
    publicationRunId: fixture.run.value.publicationRunId,
    runDigest: fixture.run.digest,
    bundleDigest: fixture.run.value.bundleDigest,
    repositoryId: fixture.run.value.repositoryId,
    pullRequestNumber: fixture.run.value.pullRequestNumber,
    headRevision: fixture.run.value.expectedHeadRevision,
    publisherId: fixture.policy.publisherId,
    publisherUserId: fixture.policy.publisherUserId,
    remoteReviewId: "98765",
    remoteState: "commented",
    remoteUrl: "https://github.com/owner/agentlab/pull/42#pullrequestreview-98765",
    bodyDigest: fixture.run.value.bodyArtifact.digest,
    remoteSubmittedAt: "2026-09-01T12:21:30.000Z",
    observedAt: "2026-09-01T12:22:00.000Z",
    source: "posted"
  });
  events.push(
    fixture.review.documents.externalPullRequestFeedbackEvent({
      ...feedbackEventBase(fixture.run, 4, events.at(-1)?.digest ?? null, feedbackId(5)),
      kind: "publication-recorded",
      from: "publication-active",
      to: "recorded",
      recordDigest: record.digest,
      recordArtifact: {
        digest: record.digest,
        mediaType: "application/vnd.agentlab.external-pull-request-feedback-record+json;version=1",
        sizeBytes: new TextEncoder().encode(record.json).byteLength
      },
      reasonCode: "comment-publication-recorded"
    })
  );
  events.push(
    fixture.review.documents.externalPullRequestFeedbackEvent({
      ...feedbackEventBase(fixture.run, 5, events.at(-1)?.digest ?? null, feedbackId(6)),
      kind: "completed",
      from: "recorded",
      to: "completed",
      remoteReviewId: record.value.remoteReviewId,
      reasonCode: "comment-publication-completed"
    })
  );
  return { events, record };
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

function feedbackId(suffix: number): string {
  return `93000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
}
