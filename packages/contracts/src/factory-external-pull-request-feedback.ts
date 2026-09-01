import { z } from "zod";

import {
  factoryActorSchema,
  factoryArtifactReferenceSchema,
  factoryIdentifierSchema,
  factorySemanticVersionSchema,
  factoryTimestampSchema,
  gitObjectIdSchema,
  sha256DigestSchema
} from "./factory.js";
import {
  factoryExternalPullRequestReviewBundleSchema,
  factoryExternalPullRequestReviewRunSchema
} from "./factory-external-pull-request-review.js";

const repositoryIdSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/u);

/** Reviewed authority for publishing evidence as a non-approving GitHub review comment. */
export const factoryExternalPullRequestFeedbackPolicySchema = z
  .object({
    schemaVersion: z.literal("agentlab.external-pull-request-feedback-policy.v1"),
    id: z.literal("agentlab/external-pull-request-feedback"),
    version: factorySemanticVersionSchema,
    repositoryId: repositoryIdSchema,
    reviewPolicyDigest: sha256DigestSchema,
    publisherId: factoryIdentifierSchema,
    publisherUserId: z.number().int().positive().refine(Number.isSafeInteger),
    publicationMode: z.literal("comment-only"),
    maximumPublicationsPerTick: z.number().int().min(1).max(10),
    maximumReviewAgeHours: z.number().int().min(1).max(168),
    maximumBodyBytes: z.number().int().min(1_024).max(16_000),
    operationDeadlineSeconds: z.number().int().min(30).max(900),
    maximumRecoveryAttempts: z.number().int().min(0).max(2)
  })
  .strict();
export type FactoryExternalPullRequestFeedbackPolicy = z.infer<
  typeof factoryExternalPullRequestFeedbackPolicySchema
>;

/** Immutable publication request rooted in a completed local review and exact PR head. */
export const factoryExternalPullRequestFeedbackRunSchema = z
  .object({
    schemaVersion: z.literal("agentlab.external-pull-request-feedback-run.v1"),
    publicationRunId: z.uuid(),
    repositoryId: repositoryIdSchema,
    pullRequestNumber: z.number().int().positive(),
    reviewRunId: z.uuid(),
    reviewRunDigest: sha256DigestSchema,
    reviewRun: factoryExternalPullRequestReviewRunSchema,
    bundleDigest: sha256DigestSchema,
    bundle: factoryExternalPullRequestReviewBundleSchema,
    reviewPolicyDigest: sha256DigestSchema,
    feedbackPolicyDigest: sha256DigestSchema,
    feedbackPolicy: factoryExternalPullRequestFeedbackPolicySchema,
    expectedBaseRevision: gitObjectIdSchema,
    expectedHeadRevision: gitObjectIdSchema,
    bodyArtifact: factoryArtifactReferenceSchema,
    marker: z.string().regex(/^<!-- agentlab-external-review:sha256:[a-f0-9]{64} -->$/u),
    createdAt: factoryTimestampSchema,
    deadlineAt: factoryTimestampSchema,
    correlationId: z.uuid()
  })
  .strict()
  .superRefine((run, context) => {
    if (
      run.repositoryId !== run.reviewRun.repositoryId ||
      run.repositoryId !== run.bundle.repositoryId ||
      run.repositoryId !== run.feedbackPolicy.repositoryId ||
      run.pullRequestNumber !== run.reviewRun.pullRequestNumber ||
      run.pullRequestNumber !== run.bundle.pullRequestNumber ||
      run.reviewRunId !== run.reviewRun.runId ||
      run.reviewRunId !== run.bundle.reviewRunId ||
      run.reviewRunDigest !== run.bundle.runDigest ||
      run.reviewPolicyDigest !== run.reviewRun.reviewPolicyDigest ||
      run.reviewPolicyDigest !== run.bundle.reviewPolicyDigest ||
      run.reviewPolicyDigest !== run.feedbackPolicy.reviewPolicyDigest ||
      run.expectedBaseRevision !== run.reviewRun.candidate.base.revision ||
      run.expectedHeadRevision !== run.reviewRun.candidate.head.revision ||
      run.bundle.candidateDigest !== run.reviewRun.candidateDigest ||
      run.marker !== `<!-- agentlab-external-review:${run.bundleDigest} -->`
    ) {
      context.addIssue({
        code: "custom",
        message: "External PR feedback run does not bind one exact completed review."
      });
    }
    if (run.createdAt >= run.deadlineAt || run.bundle.createdAt > run.createdAt) {
      context.addIssue({
        code: "custom",
        path: ["deadlineAt"],
        message: "External PR feedback timestamps are inconsistent."
      });
    }
  });
export type FactoryExternalPullRequestFeedbackRun = z.infer<
  typeof factoryExternalPullRequestFeedbackRunSchema
>;

/** Authenticated evidence for one exact remote COMMENT review. */
export const factoryExternalPullRequestFeedbackRecordSchema = z
  .object({
    schemaVersion: z.literal("agentlab.external-pull-request-feedback-record.v1"),
    publicationRunId: z.uuid(),
    runDigest: sha256DigestSchema,
    bundleDigest: sha256DigestSchema,
    repositoryId: repositoryIdSchema,
    pullRequestNumber: z.number().int().positive(),
    headRevision: gitObjectIdSchema,
    publisherId: factoryIdentifierSchema,
    publisherUserId: z.number().int().positive().refine(Number.isSafeInteger),
    remoteReviewId: z.string().regex(/^[1-9][0-9]{0,19}$/u),
    remoteState: z.literal("commented"),
    remoteUrl: z.url().max(2_048).nullable(),
    bodyDigest: sha256DigestSchema,
    remoteSubmittedAt: factoryTimestampSchema,
    observedAt: factoryTimestampSchema,
    source: z.enum(["posted", "reconciled"])
  })
  .strict()
  .superRefine((record, context) => {
    if (record.observedAt < record.remoteSubmittedAt) {
      context.addIssue({
        code: "custom",
        path: ["observedAt"],
        message: "Feedback cannot be observed before remote submission."
      });
    }
  });
export type FactoryExternalPullRequestFeedbackRecord = z.infer<
  typeof factoryExternalPullRequestFeedbackRecordSchema
>;

export const factoryExternalPullRequestFeedbackStateSchema = z.enum([
  "ready",
  "remote-verified",
  "publication-active",
  "recorded",
  "completed",
  "skipped",
  "attention-required",
  "failed"
]);
export type FactoryExternalPullRequestFeedbackState = z.infer<
  typeof factoryExternalPullRequestFeedbackStateSchema
>;

const eventCommon = {
  schemaVersion: z.literal("agentlab.external-pull-request-feedback-event.v1"),
  eventId: z.uuid(),
  publicationRunId: z.uuid(),
  runDigest: sha256DigestSchema,
  sequence: z.number().int().min(1).max(16),
  previousEventDigest: sha256DigestSchema.nullable(),
  actor: factoryActorSchema,
  occurredAt: factoryTimestampSchema,
  reasonCode: factoryIdentifierSchema,
  correlationId: z.uuid()
} as const;

export const factoryExternalPullRequestFeedbackEventSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...eventCommon,
      kind: z.literal("registered"),
      from: z.null(),
      to: z.literal("ready")
    })
    .strict(),
  z
    .object({
      ...eventCommon,
      kind: z.literal("remote-verified"),
      from: z.literal("ready"),
      to: z.literal("remote-verified")
    })
    .strict(),
  z
    .object({
      ...eventCommon,
      kind: z.literal("publication-started"),
      from: z.literal("remote-verified"),
      to: z.literal("publication-active")
    })
    .strict(),
  z
    .object({
      ...eventCommon,
      kind: z.literal("recovery-pending"),
      from: z.literal("publication-active"),
      to: z.literal("publication-active")
    })
    .strict(),
  z
    .object({
      ...eventCommon,
      kind: z.literal("publication-cancelled"),
      from: z.literal("publication-active"),
      to: z.literal("skipped")
    })
    .strict(),
  z
    .object({
      ...eventCommon,
      kind: z.literal("publication-recorded"),
      from: z.enum(["remote-verified", "publication-active"]),
      to: z.literal("recorded"),
      recordDigest: sha256DigestSchema,
      recordArtifact: factoryArtifactReferenceSchema
    })
    .strict(),
  z
    .object({
      ...eventCommon,
      kind: z.literal("completed"),
      from: z.literal("recorded"),
      to: z.literal("completed"),
      remoteReviewId: z.string().regex(/^[1-9][0-9]{0,19}$/u)
    })
    .strict(),
  z
    .object({
      ...eventCommon,
      kind: z.literal("skipped"),
      from: z.enum(["ready", "remote-verified"]),
      to: z.literal("skipped")
    })
    .strict(),
  z
    .object({
      ...eventCommon,
      kind: z.literal("attention-required"),
      from: z.literal("publication-active"),
      to: z.literal("attention-required")
    })
    .strict(),
  z
    .object({
      ...eventCommon,
      kind: z.literal("failed"),
      from: z.enum(["ready", "remote-verified"]),
      to: z.literal("failed")
    })
    .strict()
]);
export type FactoryExternalPullRequestFeedbackEvent = z.infer<
  typeof factoryExternalPullRequestFeedbackEventSchema
>;
