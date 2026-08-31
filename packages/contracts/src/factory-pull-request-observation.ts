import { z } from "zod";

import {
  factoryIdentifierSchema,
  factoryTimestampSchema,
  gitObjectIdSchema,
  repositoryRelativePathSchema,
  sha256DigestSchema
} from "./factory.js";

const externalIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine((value) => !hasAsciiControl(value), "External ID contains a control character.");

const externalLoginSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine((value) => !hasAsciiControl(value), "External login contains a control character.");

const untrustedFeedbackSchema = z
  .string()
  .max(16_384)
  .refine((value) => !value.includes("\0"), "Feedback contains a null byte.");

const boundedUrlSchema = z.url().max(2_048);

export const factoryPullRequestCheckConclusionSchema = z.enum([
  "success",
  "neutral",
  "skipped",
  "failure",
  "cancelled",
  "timed-out",
  "action-required",
  "stale",
  "startup-failure"
]);
export type FactoryPullRequestCheckConclusion = z.infer<
  typeof factoryPullRequestCheckConclusionSchema
>;

const checkIdentityShape = {
  name: z
    .string()
    .trim()
    .min(1)
    .max(256)
    .refine((value) => !hasAsciiControl(value), "Check name contains a control character."),
  producerId: factoryIdentifierSchema
} as const;

export const factoryPullRequestCheckObservationSchema = z.union([
  z
    .object({
      ...checkIdentityShape,
      status: z.literal("missing"),
      runId: z.null(),
      conclusion: z.null(),
      url: z.null(),
      startedAt: z.null(),
      completedAt: z.null()
    })
    .strict(),
  z
    .object({
      ...checkIdentityShape,
      status: z.enum(["queued", "in-progress"]),
      runId: externalIdSchema,
      conclusion: z.null(),
      url: boundedUrlSchema.nullable(),
      startedAt: factoryTimestampSchema.nullable(),
      completedAt: z.null()
    })
    .strict(),
  z
    .object({
      ...checkIdentityShape,
      status: z.literal("completed"),
      runId: externalIdSchema,
      conclusion: factoryPullRequestCheckConclusionSchema,
      url: boundedUrlSchema.nullable(),
      startedAt: factoryTimestampSchema.nullable(),
      completedAt: factoryTimestampSchema
    })
    .strict()
    .superRefine((check, context) => {
      if (check.startedAt !== null && check.completedAt < check.startedAt) {
        context.addIssue({
          code: "custom",
          path: ["completedAt"],
          message: "A check cannot complete before it starts."
        });
      }
    })
]);
export type FactoryPullRequestCheckObservation = z.infer<
  typeof factoryPullRequestCheckObservationSchema
>;

export const factoryPullRequestFeedbackAuthorSchema = z
  .object({
    externalId: externalIdSchema,
    login: externalLoginSchema,
    kind: z.enum(["human", "bot", "unknown"]),
    association: z.enum([
      "collaborator",
      "contributor",
      "first-time-contributor",
      "first-timer",
      "mannequin",
      "member",
      "none",
      "owner"
    ])
  })
  .strict();
export type FactoryPullRequestFeedbackAuthor = z.infer<
  typeof factoryPullRequestFeedbackAuthorSchema
>;

export const factoryPullRequestReviewObservationSchema = z
  .object({
    reviewId: externalIdSchema,
    author: factoryPullRequestFeedbackAuthorSchema,
    decision: z.enum(["approved", "changes-requested", "commented", "dismissed", "pending"]),
    headRevision: gitObjectIdSchema.nullable(),
    untrustedBody: untrustedFeedbackSchema,
    submittedAt: factoryTimestampSchema.nullable(),
    url: boundedUrlSchema.nullable()
  })
  .strict();
export type FactoryPullRequestReviewObservation = z.infer<
  typeof factoryPullRequestReviewObservationSchema
>;

export const factoryPullRequestReviewCommentObservationSchema = z
  .object({
    commentId: externalIdSchema,
    reviewId: externalIdSchema.nullable(),
    author: factoryPullRequestFeedbackAuthorSchema,
    headRevision: gitObjectIdSchema,
    path: repositoryRelativePathSchema,
    line: z.number().int().positive().nullable(),
    side: z.enum(["left", "right"]).nullable(),
    untrustedBody: untrustedFeedbackSchema,
    createdAt: factoryTimestampSchema,
    updatedAt: factoryTimestampSchema,
    url: boundedUrlSchema.nullable()
  })
  .strict()
  .superRefine((comment, context) => {
    if (comment.updatedAt < comment.createdAt) {
      context.addIssue({
        code: "custom",
        path: ["updatedAt"],
        message: "A review comment cannot be updated before it is created."
      });
    }
  });
export type FactoryPullRequestReviewCommentObservation = z.infer<
  typeof factoryPullRequestReviewCommentObservationSchema
>;

export const factoryPullRequestConversationCommentObservationSchema = z
  .object({
    commentId: externalIdSchema,
    author: factoryPullRequestFeedbackAuthorSchema,
    untrustedBody: untrustedFeedbackSchema,
    createdAt: factoryTimestampSchema,
    updatedAt: factoryTimestampSchema,
    url: boundedUrlSchema.nullable()
  })
  .strict()
  .superRefine((comment, context) => {
    if (comment.updatedAt < comment.createdAt) {
      context.addIssue({
        code: "custom",
        path: ["updatedAt"],
        message: "A conversation comment cannot be updated before it is created."
      });
    }
  });
export type FactoryPullRequestConversationCommentObservation = z.infer<
  typeof factoryPullRequestConversationCommentObservationSchema
>;

/** Provider-neutral, bounded remote facts. Every feedback body remains explicitly untrusted data. */
export const factoryPullRequestObservationSchema = z
  .object({
    schemaVersion: z.literal("agentlab.pull-request-observation.v1"),
    taskId: z.uuid(),
    contractDigest: sha256DigestSchema,
    proposalDigest: sha256DigestSchema,
    pullRequestRecordDigest: sha256DigestSchema,
    repositoryId: factoryIdentifierSchema,
    pullRequestNumber: z.number().int().positive(),
    url: boundedUrlSchema,
    brokerId: factoryIdentifierSchema,
    authorizedBaseRevision: gitObjectIdSchema,
    recordedHeadRevision: gitObjectIdSchema,
    remoteBaseRevision: gitObjectIdSchema,
    remoteHeadRevision: gitObjectIdSchema,
    branchName: factoryIdentifierSchema,
    state: z.enum(["open", "closed"]),
    draft: z.boolean(),
    merged: z.boolean(),
    trustedChecks: z.array(factoryPullRequestCheckObservationSchema).min(1).max(32),
    reviews: z.array(factoryPullRequestReviewObservationSchema).max(99),
    reviewComments: z.array(factoryPullRequestReviewCommentObservationSchema).max(99),
    conversationComments: z.array(factoryPullRequestConversationCommentObservationSchema).max(99),
    observedAt: factoryTimestampSchema
  })
  .strict()
  .superRefine((observation, context) => {
    for (const [path, identities] of [
      [
        "trustedChecks",
        observation.trustedChecks.map((check) => `${check.name}\0${check.producerId}`)
      ],
      ["reviews", observation.reviews.map((review) => review.reviewId)],
      ["reviewComments", observation.reviewComments.map((comment) => comment.commentId)],
      ["conversationComments", observation.conversationComments.map((comment) => comment.commentId)]
    ] as const) {
      if (new Set(identities).size !== identities.length) {
        context.addIssue({ code: "custom", path: [path], message: `${path} must be unique.` });
      }
    }
    if (observation.merged && observation.state !== "closed") {
      context.addIssue({
        code: "custom",
        path: ["merged"],
        message: "A merged pull request must be closed."
      });
    }
  });
export type FactoryPullRequestObservation = z.infer<typeof factoryPullRequestObservationSchema>;

function hasAsciiControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}
