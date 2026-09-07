import { z } from "zod";

import {
  factoryActorSchema,
  factoryArtifactReferenceSchema,
  factoryIdentifierSchema,
  factorySemanticVersionSchema,
  factoryTimestampSchema,
  gitObjectIdSchema,
  repositoryPathPatternSchema,
  repositoryRelativePathSchema,
  sha256DigestSchema
} from "./factory.js";
import { factoryPullRequestFeedbackAuthorSchema } from "./factory-pull-request-observation.js";
import { factorySchedulePolicySchema } from "./factory-schedule.js";

const repositoryIdSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/u);

const branchNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine((value) => !hasAsciiControl(value), "Branch name contains a control character.");

const untrustedTextSchema = z
  .string()
  .max(16_384)
  .refine((value) => !value.includes("\0"), "Untrusted text contains a null byte.");

const externalRepositoryRelativePathSchema = repositoryRelativePathSchema.refine(
  (value) => !hasAsciiControl(value),
  "Repository path contains a control character."
);

/** Repository-owned limits for read-only inventory. This policy grants no review or write authority. */
export const factoryExternalPullRequestDiscoveryPolicySchema = z
  .object({
    schemaVersion: z.literal("agentlab.external-pull-request-discovery-policy.v1"),
    id: z.literal("agentlab/external-pull-request-discovery"),
    version: factorySemanticVersionSchema,
    repositoryId: repositoryIdSchema,
    allowedBaseBranches: z.array(branchNameSchema).min(1).max(32),
    protectedPaths: z.array(repositoryPathPatternSchema).max(256),
    agentReviewAssociations: z
      .array(
        z.enum([
          "collaborator",
          "contributor",
          "first-time-contributor",
          "first-timer",
          "mannequin",
          "member",
          "none",
          "owner"
        ])
      )
      .min(1)
      .max(8),
    includeDrafts: z.boolean(),
    maximumPullRequestsPerTick: z.number().int().min(1).max(25),
    maximumChangedFilesForAgentReview: z.number().int().min(1).max(99),
    maximumChangedLinesForAgentReview: z.number().int().min(1).max(20_000),
    maximumAgeDays: z.number().int().min(1).max(365)
  })
  .strict()
  .superRefine((policy, context) => {
    for (const [path, values] of [
      ["allowedBaseBranches", policy.allowedBaseBranches],
      ["protectedPaths", policy.protectedPaths],
      ["agentReviewAssociations", policy.agentReviewAssociations]
    ] as const) {
      if (new Set(values).size !== values.length) {
        context.addIssue({ code: "custom", path: [path], message: `${path} must be unique.` });
      }
    }
  });
export type FactoryExternalPullRequestDiscoveryPolicy = z.infer<
  typeof factoryExternalPullRequestDiscoveryPolicySchema
>;

export const factoryExternalPullRequestChangedFileSchema = z
  .object({
    path: externalRepositoryRelativePathSchema,
    previousPath: externalRepositoryRelativePathSchema.nullable(),
    status: z.enum(["added", "modified", "removed", "renamed", "copied", "changed", "unchanged"]),
    revision: gitObjectIdSchema,
    additions: z.number().int().min(0).max(1_000_000),
    deletions: z.number().int().min(0).max(1_000_000),
    changes: z.number().int().min(0).max(1_000_000)
  })
  .strict()
  .superRefine((file, context) => {
    if (file.changes !== file.additions + file.deletions) {
      context.addIssue({
        code: "custom",
        path: ["changes"],
        message: "Changed lines must equal additions plus deletions."
      });
    }
    if ((file.status === "renamed") !== (file.previousPath !== null)) {
      context.addIssue({
        code: "custom",
        path: ["previousPath"],
        message: "Only renamed files carry a previous path."
      });
    }
  });
export type FactoryExternalPullRequestChangedFile = z.infer<
  typeof factoryExternalPullRequestChangedFileSchema
>;

export const factoryExternalPullRequestDispositionSchema = z.enum([
  "agent-review-candidate",
  "human-review-required",
  "deferred",
  "factory-owned"
]);
export type FactoryExternalPullRequestDisposition = z.infer<
  typeof factoryExternalPullRequestDispositionSchema
>;

/** One provider-authenticated PR head. Text and contributor identity remain explicitly untrusted. */
export const factoryExternalPullRequestCandidateSchema = z
  .object({
    repositoryId: repositoryIdSchema,
    pullRequestNumber: z.number().int().positive(),
    url: z.url().max(2_048),
    untrustedTitle: untrustedTextSchema,
    untrustedBody: untrustedTextSchema,
    author: factoryPullRequestFeedbackAuthorSchema,
    base: z.object({ branchName: branchNameSchema, revision: gitObjectIdSchema }).strict(),
    head: z
      .object({
        repositoryId: repositoryIdSchema.nullable(),
        branchName: branchNameSchema,
        revision: gitObjectIdSchema
      })
      .strict(),
    fromFork: z.boolean(),
    draft: z.boolean(),
    createdAt: factoryTimestampSchema,
    updatedAt: factoryTimestampSchema,
    totalChangedFiles: z.number().int().min(0).max(10_000),
    filesComplete: z.boolean(),
    changedFiles: z.array(factoryExternalPullRequestChangedFileSchema).max(100),
    additions: z.number().int().min(0).max(10_000_000),
    deletions: z.number().int().min(0).max(10_000_000),
    changedLines: z.number().int().min(0).max(20_000_000),
    disposition: factoryExternalPullRequestDispositionSchema,
    reasonCodes: z.array(factoryIdentifierSchema).min(1).max(16)
  })
  .strict()
  .superRefine((candidate, context) => {
    if (candidate.updatedAt < candidate.createdAt) {
      context.addIssue({
        code: "custom",
        path: ["updatedAt"],
        message: "A pull request cannot be updated before it is created."
      });
    }
    if (candidate.changedLines !== candidate.additions + candidate.deletions) {
      context.addIssue({
        code: "custom",
        path: ["changedLines"],
        message: "Changed lines must equal additions plus deletions."
      });
    }
    if (
      candidate.filesComplete !==
      (candidate.changedFiles.length === candidate.totalChangedFiles)
    ) {
      context.addIssue({
        code: "custom",
        path: ["filesComplete"],
        message: "File completeness must match the advertised changed-file count."
      });
    }
    if (
      candidate.head.repositoryId !== null &&
      candidate.fromFork !== (candidate.head.repositoryId !== candidate.repositoryId)
    ) {
      context.addIssue({
        code: "custom",
        path: ["fromFork"],
        message: "Fork identity must match the head repository."
      });
    }
    if (new Set(candidate.reasonCodes).size !== candidate.reasonCodes.length) {
      context.addIssue({
        code: "custom",
        path: ["reasonCodes"],
        message: "Reason codes must be unique."
      });
    }
  });
export type FactoryExternalPullRequestCandidate = z.infer<
  typeof factoryExternalPullRequestCandidateSchema
>;

/** Immutable identity for one idempotent daily read-only inventory slot. */
export const factoryExternalPullRequestDiscoveryRunSchema = z
  .object({
    schemaVersion: z.literal("agentlab.external-pull-request-discovery-run.v1"),
    runId: z.uuid(),
    repositoryId: repositoryIdSchema,
    observerId: factoryIdentifierSchema,
    discoveryPolicyDigest: sha256DigestSchema,
    discoveryPolicy: factoryExternalPullRequestDiscoveryPolicySchema,
    schedulePolicyDigest: sha256DigestSchema,
    schedulePolicy: factorySchedulePolicySchema,
    scheduledFor: factoryTimestampSchema,
    deadlineAt: factoryTimestampSchema,
    createdAt: factoryTimestampSchema,
    correlationId: z.uuid()
  })
  .strict()
  .superRefine((run, context) => {
    if (run.discoveryPolicy.repositoryId !== run.repositoryId) {
      context.addIssue({
        code: "custom",
        path: ["discoveryPolicy", "repositoryId"],
        message: "Discovery policy must name the exact run repository."
      });
    }
    if (
      run.deadlineAt <= run.scheduledFor ||
      run.createdAt < run.scheduledFor ||
      run.createdAt > run.deadlineAt
    ) {
      context.addIssue({
        code: "custom",
        path: ["createdAt"],
        message: "Discovery must start inside its daily slot window."
      });
    }
  });
export type FactoryExternalPullRequestDiscoveryRun = z.infer<
  typeof factoryExternalPullRequestDiscoveryRunSchema
>;

export const factoryExternalPullRequestDiscoverySnapshotSchema = z
  .object({
    schemaVersion: z.literal("agentlab.external-pull-request-discovery-snapshot.v1"),
    runId: z.uuid(),
    runDigest: sha256DigestSchema,
    repositoryId: repositoryIdSchema,
    observerId: factoryIdentifierSchema,
    discoveryPolicyDigest: sha256DigestSchema,
    scheduledFor: factoryTimestampSchema,
    observedAt: factoryTimestampSchema,
    hasMore: z.boolean(),
    pullRequests: z.array(factoryExternalPullRequestCandidateSchema).max(25),
    counts: z
      .object({
        agentReviewCandidates: z.number().int().min(0).max(25),
        humanReviewRequired: z.number().int().min(0).max(25),
        deferred: z.number().int().min(0).max(25),
        factoryOwned: z.number().int().min(0).max(25)
      })
      .strict()
  })
  .strict()
  .superRefine((snapshot, context) => {
    const identities = snapshot.pullRequests.map((item) => item.pullRequestNumber);
    if (new Set(identities).size !== identities.length) {
      context.addIssue({
        code: "custom",
        path: ["pullRequests"],
        message: "Pull-request numbers must be unique."
      });
    }
    const counts = countDispositions(snapshot.pullRequests);
    if (
      counts.agentReviewCandidates !== snapshot.counts.agentReviewCandidates ||
      counts.humanReviewRequired !== snapshot.counts.humanReviewRequired ||
      counts.deferred !== snapshot.counts.deferred ||
      counts.factoryOwned !== snapshot.counts.factoryOwned
    ) {
      context.addIssue({
        code: "custom",
        path: ["counts"],
        message: "Snapshot counts must match its pull requests."
      });
    }
  });
export type FactoryExternalPullRequestDiscoverySnapshot = z.infer<
  typeof factoryExternalPullRequestDiscoverySnapshotSchema
>;

export const factoryExternalPullRequestDiscoveryStateSchema = z.enum([
  "ready",
  "fetching",
  "recorded",
  "completed",
  "failed"
]);
export type FactoryExternalPullRequestDiscoveryState = z.infer<
  typeof factoryExternalPullRequestDiscoveryStateSchema
>;

const eventCommon = {
  schemaVersion: z.literal("agentlab.external-pull-request-discovery-event.v1"),
  eventId: z.uuid(),
  runId: z.uuid(),
  runDigest: sha256DigestSchema,
  sequence: z.number().int().min(1).max(8),
  previousEventDigest: sha256DigestSchema.nullable(),
  actor: factoryActorSchema,
  occurredAt: factoryTimestampSchema,
  reasonCode: factoryIdentifierSchema,
  correlationId: z.uuid()
} as const;

export const factoryExternalPullRequestDiscoveryEventSchema = z.discriminatedUnion("kind", [
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
      kind: z.literal("inventory-started"),
      from: z.literal("ready"),
      to: z.literal("fetching")
    })
    .strict(),
  z
    .object({
      ...eventCommon,
      kind: z.literal("recovered"),
      from: z.literal("fetching"),
      to: z.literal("ready")
    })
    .strict(),
  z
    .object({
      ...eventCommon,
      kind: z.literal("snapshot-recorded"),
      from: z.literal("fetching"),
      to: z.literal("recorded"),
      snapshotDigest: sha256DigestSchema,
      snapshotArtifact: factoryArtifactReferenceSchema
    })
    .strict(),
  z
    .object({
      ...eventCommon,
      kind: z.literal("completed"),
      from: z.literal("recorded"),
      to: z.literal("completed"),
      agentReviewCandidates: z.number().int().min(0).max(25),
      humanReviewRequired: z.number().int().min(0).max(25),
      deferred: z.number().int().min(0).max(25),
      factoryOwned: z.number().int().min(0).max(25),
      hasMore: z.boolean()
    })
    .strict(),
  z
    .object({
      ...eventCommon,
      kind: z.literal("failed"),
      from: z.literal("fetching"),
      to: z.literal("failed")
    })
    .strict()
]);
export type FactoryExternalPullRequestDiscoveryEvent = z.infer<
  typeof factoryExternalPullRequestDiscoveryEventSchema
>;

function countDispositions(items: readonly FactoryExternalPullRequestCandidate[]) {
  return {
    agentReviewCandidates: items.filter(
      ({ disposition }) => disposition === "agent-review-candidate"
    ).length,
    humanReviewRequired: items.filter(({ disposition }) => disposition === "human-review-required")
      .length,
    deferred: items.filter(({ disposition }) => disposition === "deferred").length,
    factoryOwned: items.filter(({ disposition }) => disposition === "factory-owned").length
  };
}

function hasAsciiControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}
