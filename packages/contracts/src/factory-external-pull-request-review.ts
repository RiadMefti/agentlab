import { z } from "zod";

import {
  factoryAgentRunStatusSchema,
  factoryActorSchema,
  factoryArtifactReferenceSchema,
  factoryBudgetSchema,
  factoryBudgetUsageSchema,
  factoryCapabilityGrantSchema,
  factoryIdentifierSchema,
  factoryProcessIsolationSchema,
  factoryResourceLimitsSchema,
  factoryReviewDecisionSchema,
  factorySemanticVersionSchema,
  factoryTimestampSchema,
  gitObjectIdSchema,
  sha256DigestSchema
} from "./factory.js";
import { factoryExternalPullRequestCandidateSchema } from "./factory-external-pull-request-discovery.js";
import { modelIdSchema, providerIdSchema, reasoningIdSchema } from "./provider.js";

const repositoryIdSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/u);

const readOnlyCapabilitiesSchema = factoryCapabilityGrantSchema.superRefine(
  (capabilities, context) => {
    if (
      capabilities.filesystem !== "read" ||
      capabilities.git !== "read" ||
      capabilities.remoteRepository !== "none" ||
      capabilities.network.mode !== "off" ||
      capabilities.secretRefs.length > 0 ||
      capabilities.commandAllowlist.length > 0
    ) {
      context.addIssue({
        code: "custom",
        message: "External pull-request reviewers require an exact read-only capability grant."
      });
    }
  }
);

const reviewerProfileSchema = z
  .object({
    id: factoryIdentifierSchema,
    provider: providerIdSchema,
    model: modelIdSchema,
    reasoning: reasoningIdSchema.nullable(),
    skillDigests: z.array(sha256DigestSchema).min(1).max(16),
    capabilities: readOnlyCapabilitiesSchema,
    budget: factoryBudgetSchema
  })
  .strict()
  .superRefine((profile, context) => {
    if (new Set(profile.skillDigests).size !== profile.skillDigests.length) {
      context.addIssue({
        code: "custom",
        path: ["skillDigests"],
        message: "Reviewer skill digests must be unique."
      });
    }
  });

/** Repository-owned authority for producing local review evidence. It grants no GitHub mutation. */
export const factoryExternalPullRequestReviewPolicySchema = z
  .object({
    schemaVersion: z.literal("agentlab.external-pull-request-review-policy.v1"),
    id: z.literal("agentlab/external-pull-request-review"),
    version: factorySemanticVersionSchema,
    repositoryId: repositoryIdSchema,
    discoveryPolicyDigest: sha256DigestSchema,
    reviewerProfiles: z.array(reviewerProfileSchema).min(1).max(5),
    minimumIndependentReviews: z.number().int().min(1).max(5),
    maximumCandidatesPerTick: z.number().int().min(1).max(10),
    maximumPatchBytes: z
      .number()
      .int()
      .min(1)
      .max(8 * 1_024 * 1_024),
    maximumPromptBytes: z
      .number()
      .int()
      .min(1)
      .max(12 * 1_024 * 1_024),
    aggregateBudget: factoryBudgetSchema,
    resourceLimits: factoryResourceLimitsSchema,
    maximumRecoveryAttempts: z.number().int().min(0).max(2)
  })
  .strict()
  .superRefine((policy, context) => {
    const profileIds = policy.reviewerProfiles.map(({ id }) => id);
    if (new Set(profileIds).size !== profileIds.length) {
      context.addIssue({
        code: "custom",
        path: ["reviewerProfiles"],
        message: "Reviewer profile IDs must be unique."
      });
    }
    if (policy.minimumIndependentReviews > policy.reviewerProfiles.length) {
      context.addIssue({
        code: "custom",
        path: ["minimumIndependentReviews"],
        message: "The review threshold cannot exceed the configured reviewer count."
      });
    }
  });
export type FactoryExternalPullRequestReviewPolicy = z.infer<
  typeof factoryExternalPullRequestReviewPolicySchema
>;

/** Immutable review identity rooted in one authenticated discovery candidate and exact Git heads. */
export const factoryExternalPullRequestReviewRunSchema = z
  .object({
    schemaVersion: z.literal("agentlab.external-pull-request-review-run.v1"),
    runId: z.uuid(),
    repositoryId: repositoryIdSchema,
    pullRequestNumber: z.number().int().positive(),
    candidateDigest: sha256DigestSchema,
    candidate: factoryExternalPullRequestCandidateSchema,
    discoveryRunId: z.uuid(),
    discoveryRunDigest: sha256DigestSchema,
    discoverySnapshotDigest: sha256DigestSchema,
    discoveryPolicyDigest: sha256DigestSchema,
    reviewPolicyDigest: sha256DigestSchema,
    reviewPolicy: factoryExternalPullRequestReviewPolicySchema,
    costPolicyDigest: sha256DigestSchema,
    workspaceId: z.uuid(),
    createdAt: factoryTimestampSchema,
    deadlineAt: factoryTimestampSchema,
    correlationId: z.uuid()
  })
  .strict()
  .superRefine((run, context) => {
    if (
      run.repositoryId !== run.candidate.repositoryId ||
      run.repositoryId !== run.reviewPolicy.repositoryId ||
      run.pullRequestNumber !== run.candidate.pullRequestNumber ||
      run.reviewPolicy.discoveryPolicyDigest !== run.discoveryPolicyDigest
    ) {
      context.addIssue({
        code: "custom",
        message: "External review run coordinates do not share one repository candidate."
      });
    }
    if (run.candidate.disposition !== "agent-review-candidate") {
      context.addIssue({
        code: "custom",
        path: ["candidate", "disposition"],
        message: "Only an admitted external pull request can enter agent review."
      });
    }
    if (run.createdAt >= run.deadlineAt) {
      context.addIssue({
        code: "custom",
        path: ["deadlineAt"],
        message: "External review deadline must follow creation."
      });
    }
  });
export type FactoryExternalPullRequestReviewRun = z.infer<
  typeof factoryExternalPullRequestReviewRunSchema
>;

/** Provider-neutral, read-only request consumed by existing isolated reviewer adapters. */
export const factoryExternalPullRequestReviewerRequestSchema = z
  .object({
    schemaVersion: z.literal("agentlab.external-pull-request-reviewer-request.v1"),
    executionId: z.uuid(),
    reviewRunId: z.uuid(),
    taskId: z.uuid(),
    contractDigest: sha256DigestSchema,
    candidateDigest: sha256DigestSchema,
    reviewerId: factoryIdentifierSchema,
    role: z.literal("reviewer"),
    attempt: z.number().int().min(1).max(20),
    provider: providerIdSchema,
    model: modelIdSchema,
    reasoning: reasoningIdSchema.nullable(),
    repository: z.object({ id: repositoryIdSchema, baseRevision: gitObjectIdSchema }).strict(),
    pullRequest: z
      .object({
        number: z.number().int().positive(),
        baseRevision: gitObjectIdSchema,
        headRevision: gitObjectIdSchema,
        patchDigest: sha256DigestSchema
      })
      .strict(),
    promptArtifact: factoryArtifactReferenceSchema,
    outputSchemaDigest: sha256DigestSchema,
    skillDigests: z.array(sha256DigestSchema).min(1).max(16),
    capabilities: readOnlyCapabilitiesSchema,
    budget: factoryBudgetSchema
  })
  .strict()
  .superRefine((request, context) => {
    if (
      request.reviewRunId !== request.taskId ||
      request.repository.baseRevision !== request.pullRequest.headRevision
    ) {
      context.addIssue({
        code: "custom",
        message: "Reviewer request must bind its run and exact head workspace."
      });
    }
    if (new Set(request.skillDigests).size !== request.skillDigests.length) {
      context.addIssue({
        code: "custom",
        path: ["skillDigests"],
        message: "Reviewer request skill digests must be unique."
      });
    }
  });
export type FactoryExternalPullRequestReviewerRequest = z.infer<
  typeof factoryExternalPullRequestReviewerRequestSchema
>;

export const factoryExternalPullRequestReviewerRecordSchema = z
  .object({
    schemaVersion: z.literal("agentlab.external-pull-request-reviewer-record.v1"),
    reviewRunId: z.uuid(),
    runDigest: sha256DigestSchema,
    requestDigest: sha256DigestSchema,
    executionId: z.uuid(),
    reviewerId: factoryIdentifierSchema,
    provider: providerIdSchema,
    providerVersion: z.string().trim().min(1).max(180),
    harnessVersion: z.string().trim().min(1).max(180),
    model: modelIdSchema,
    reasoning: reasoningIdSchema.nullable(),
    providerSessionId: z.string().trim().min(1).max(256).nullable(),
    status: factoryAgentRunStatusSchema,
    startedAt: factoryTimestampSchema,
    finishedAt: factoryTimestampSchema,
    exitCode: z.number().int().min(0).max(255).nullable(),
    stdoutArtifact: factoryArtifactReferenceSchema,
    stderrArtifact: factoryArtifactReferenceSchema,
    finalOutputArtifact: factoryArtifactReferenceSchema.nullable(),
    usage: factoryBudgetUsageSchema,
    usageComplete: z.boolean(),
    errorCode: factoryIdentifierSchema.nullable(),
    isolation: factoryProcessIsolationSchema
  })
  .strict()
  .superRefine((record, context) => {
    if (record.finishedAt < record.startedAt) {
      context.addIssue({
        code: "custom",
        path: ["finishedAt"],
        message: "Review ended before it started."
      });
    }
    if (record.status === "succeeded" && (record.exitCode !== 0 || record.errorCode !== null)) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Successful review execution is inconsistent."
      });
    }
    if (record.status !== "succeeded" && record.errorCode === null) {
      context.addIssue({
        code: "custom",
        path: ["errorCode"],
        message: "Failed review execution needs an error code."
      });
    }
  });
export type FactoryExternalPullRequestReviewerRecord = z.infer<
  typeof factoryExternalPullRequestReviewerRecordSchema
>;

export const factoryExternalPullRequestReviewResultSchema = factoryReviewDecisionSchema.safeExtend({
  schemaVersion: z.literal("agentlab.external-pull-request-review-result.v1"),
  reviewRunId: z.uuid(),
  runDigest: sha256DigestSchema,
  candidateDigest: sha256DigestSchema,
  patchDigest: sha256DigestSchema,
  reviewerId: factoryIdentifierSchema,
  requestDigest: sha256DigestSchema,
  reviewerRecordDigest: sha256DigestSchema,
  executionId: z.uuid(),
  createdAt: factoryTimestampSchema
});
export type FactoryExternalPullRequestReviewResult = z.infer<
  typeof factoryExternalPullRequestReviewResultSchema
>;

export const factoryExternalPullRequestReviewBundleSchema = z
  .object({
    schemaVersion: z.literal("agentlab.external-pull-request-review-bundle.v1"),
    reviewRunId: z.uuid(),
    runDigest: sha256DigestSchema,
    repositoryId: repositoryIdSchema,
    pullRequestNumber: z.number().int().positive(),
    candidateDigest: sha256DigestSchema,
    patchDigest: sha256DigestSchema,
    reviewPolicyDigest: sha256DigestSchema,
    decision: z.enum(["approved", "changes-requested", "human-review-required"]),
    reviewerRecords: z.array(factoryExternalPullRequestReviewerRecordSchema).min(1).max(5),
    reviews: z.array(factoryExternalPullRequestReviewResultSchema).min(1).max(5),
    aggregateUsage: factoryBudgetUsageSchema,
    usageComplete: z.boolean(),
    workspaceUnchanged: z.literal(true),
    createdAt: factoryTimestampSchema
  })
  .strict()
  .superRefine((bundle, context) => {
    const reviewerIds = bundle.reviews.map(({ reviewerId }) => reviewerId);
    if (
      new Set(reviewerIds).size !== reviewerIds.length ||
      bundle.reviewerRecords.length !== bundle.reviews.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["reviews"],
        message: "Reviewers must be independent and complete."
      });
    }
    for (const review of bundle.reviews) {
      if (
        review.reviewRunId !== bundle.reviewRunId ||
        review.runDigest !== bundle.runDigest ||
        review.candidateDigest !== bundle.candidateDigest ||
        review.patchDigest !== bundle.patchDigest
      ) {
        context.addIssue({
          code: "custom",
          path: ["reviews"],
          message: "Review bundle lineage is inconsistent."
        });
        break;
      }
    }
  });
export type FactoryExternalPullRequestReviewBundle = z.infer<
  typeof factoryExternalPullRequestReviewBundleSchema
>;

export const factoryExternalPullRequestReviewStateSchema = z.enum([
  "ready",
  "workspace-active",
  "reviewing",
  "reviewer-active",
  "recorded",
  "completed",
  "failed",
  "quarantined"
]);
export type FactoryExternalPullRequestReviewState = z.infer<
  typeof factoryExternalPullRequestReviewStateSchema
>;

const eventCommon = {
  schemaVersion: z.literal("agentlab.external-pull-request-review-event.v1"),
  eventId: z.uuid(),
  reviewRunId: z.uuid(),
  runDigest: sha256DigestSchema,
  sequence: z.number().int().min(1).max(64),
  previousEventDigest: sha256DigestSchema.nullable(),
  actor: factoryActorSchema,
  occurredAt: factoryTimestampSchema,
  reasonCode: factoryIdentifierSchema,
  correlationId: z.uuid()
} as const;

export const factoryExternalPullRequestReviewEventSchema = z.discriminatedUnion("kind", [
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
      kind: z.literal("workspace-started"),
      from: z.literal("ready"),
      to: z.literal("workspace-active")
    })
    .strict(),
  z
    .object({
      ...eventCommon,
      kind: z.literal("workspace-prepared"),
      from: z.literal("workspace-active"),
      to: z.literal("reviewing"),
      patchDigest: sha256DigestSchema,
      patchArtifact: factoryArtifactReferenceSchema
    })
    .strict(),
  z
    .object({
      ...eventCommon,
      kind: z.literal("reviewer-started"),
      from: z.literal("reviewing"),
      to: z.literal("reviewer-active"),
      reviewerId: factoryIdentifierSchema,
      executionId: z.uuid(),
      requestDigest: sha256DigestSchema
    })
    .strict(),
  z
    .object({
      ...eventCommon,
      kind: z.literal("reviewer-finished"),
      from: z.literal("reviewer-active"),
      to: z.literal("reviewing"),
      reviewerId: factoryIdentifierSchema,
      executionId: z.uuid(),
      requestDigest: sha256DigestSchema,
      reviewerRecordDigest: sha256DigestSchema,
      reviewResultDigest: sha256DigestSchema
    })
    .strict(),
  z
    .object({
      ...eventCommon,
      kind: z.literal("recovered"),
      from: z.enum(["workspace-active", "reviewing", "reviewer-active"]),
      to: z.literal("ready")
    })
    .strict(),
  z
    .object({
      ...eventCommon,
      kind: z.literal("bundle-recorded"),
      from: z.literal("reviewing"),
      to: z.literal("recorded"),
      bundleDigest: sha256DigestSchema,
      bundleArtifact: factoryArtifactReferenceSchema
    })
    .strict(),
  z
    .object({
      ...eventCommon,
      kind: z.literal("completed"),
      from: z.literal("recorded"),
      to: z.literal("completed"),
      decision: z.enum(["approved", "changes-requested", "human-review-required"])
    })
    .strict(),
  z
    .object({
      ...eventCommon,
      kind: z.literal("failed"),
      from: z.enum(["ready", "workspace-active", "reviewing", "reviewer-active"]),
      to: z.literal("failed"),
      reviewerRecordDigest: sha256DigestSchema.nullable()
    })
    .strict(),
  z
    .object({
      ...eventCommon,
      kind: z.literal("quarantined"),
      from: z.enum(["workspace-active", "reviewing", "reviewer-active"]),
      to: z.literal("quarantined"),
      reviewerRecordDigest: sha256DigestSchema.nullable()
    })
    .strict()
]);
export type FactoryExternalPullRequestReviewEvent = z.infer<
  typeof factoryExternalPullRequestReviewEventSchema
>;
