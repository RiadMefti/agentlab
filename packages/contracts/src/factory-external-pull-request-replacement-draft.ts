import { z } from "zod";

import {
  factoryActorSchema,
  factoryArtifactReferenceSchema,
  factoryChangeSetSchema,
  factoryIdentifierSchema,
  factorySemanticVersionSchema,
  factoryTimestampSchema,
  gitObjectIdSchema,
  sha256DigestSchema
} from "./factory.js";

const repositoryIdSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/u);
const branchNameSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => !/[\0-\x20~^:?*[\\]/u.test(value) && !value.endsWith("."));

/** Reviewed authority for publishing only qualified external repairs as new draft PRs. */
export const factoryExternalPullRequestReplacementDraftPolicySchema = z
  .object({
    schemaVersion: z.literal("agentlab.external-pull-request-replacement-draft-policy.v1"),
    id: z.literal("agentlab/external-pull-request-replacement-draft"),
    version: factorySemanticVersionSchema,
    repositoryId: repositoryIdSchema,
    brokerId: factoryIdentifierSchema,
    publisherId: factoryIdentifierSchema,
    brokerUserId: z.number().int().min(1).max(4_294_967_294),
    qualificationPolicyDigest: sha256DigestSchema,
    roleIdentityPolicyDigest: sha256DigestSchema,
    branchPrefix: z.literal("agentlab/external-repair"),
    requiredStatusChecks: z
      .array(z.enum(["verify", "factory-sandbox"]))
      .length(2)
      .refine((checks) => new Set(checks).size === 2),
    maximumPatchBytes: z
      .number()
      .int()
      .min(1)
      .max(8 * 1_024 * 1_024),
    maximumCandidatesPerTick: z.number().int().min(1).max(10),
    operationDeadlineSeconds: z.number().int().min(60).max(86_400),
    maximumRiskTier: z.literal("R1"),
    draft: z.literal(true),
    contributorBranchWrite: z.literal(false),
    forcePush: z.literal(false),
    approval: z.literal(false),
    autoMerge: z.literal(false),
    release: z.literal(false)
  })
  .strict();
export type FactoryExternalPullRequestReplacementDraftPolicy = z.infer<
  typeof factoryExternalPullRequestReplacementDraftPolicySchema
>;

/** Immutable publication identity rooted in one completed, qualified repair bundle. */
export const factoryExternalPullRequestReplacementDraftRunSchema = z
  .object({
    schemaVersion: z.literal("agentlab.external-pull-request-replacement-draft-run.v1"),
    publicationRunId: z.uuid(),
    repositoryId: repositoryIdSchema,
    originalPullRequestNumber: z.number().int().positive(),
    qualificationRunId: z.uuid(),
    qualificationRunDigest: sha256DigestSchema,
    qualificationBundleDigest: sha256DigestSchema,
    repairBundleDigest: sha256DigestSchema,
    publicationPolicyDigest: sha256DigestSchema,
    publicationPolicy: factoryExternalPullRequestReplacementDraftPolicySchema,
    qualificationPolicyDigest: sha256DigestSchema,
    expectedBaseRevision: gitObjectIdSchema,
    expectedHeadRevision: gitObjectIdSchema,
    repairedPatchDigest: sha256DigestSchema,
    changeSet: factoryChangeSetSchema,
    createdAt: factoryTimestampSchema,
    deadlineAt: factoryTimestampSchema,
    correlationId: z.uuid()
  })
  .strict()
  .superRefine((run, context) => {
    if (
      run.repositoryId !== run.publicationPolicy.repositoryId ||
      run.qualificationPolicyDigest !== run.publicationPolicy.qualificationPolicyDigest ||
      run.changeSet.baseRevision !== run.expectedHeadRevision ||
      run.createdAt >= run.deadlineAt
    ) {
      context.addIssue({
        code: "custom",
        message: "Replacement-draft run lineage is inconsistent."
      });
    }
  });
export type FactoryExternalPullRequestReplacementDraftRun = z.infer<
  typeof factoryExternalPullRequestReplacementDraftRunSchema
>;

/** Exact, deterministic remote-write proposal. It never names the contributor's branch. */
export const factoryExternalPullRequestReplacementDraftProposalSchema = z
  .object({
    schemaVersion: z.literal("agentlab.external-pull-request-replacement-draft-proposal.v1"),
    publicationRunId: z.uuid(),
    runDigest: sha256DigestSchema,
    repositoryId: repositoryIdSchema,
    originalPullRequestNumber: z.number().int().positive(),
    originalPullRequestUrl: z.url().max(2_048),
    qualificationBundleDigest: sha256DigestSchema,
    expectedBaseBranch: branchNameSchema,
    expectedBaseRevision: gitObjectIdSchema,
    expectedOriginalHeadRevision: gitObjectIdSchema,
    repairedPatchDigest: sha256DigestSchema,
    changeSet: factoryChangeSetSchema,
    branchName: branchNameSchema,
    title: z.string().trim().min(1).max(120),
    body: z.string().min(1).max(16_384),
    commitTitle: z.string().trim().min(1).max(120),
    createdAt: factoryTimestampSchema,
    draft: z.literal(true),
    maintainerCanModify: z.literal(false)
  })
  .strict()
  .superRefine((proposal, context) => {
    const expectedBranch = replacementDraftBranchName(
      proposal.originalPullRequestNumber,
      proposal.qualificationBundleDigest
    );
    if (
      proposal.changeSet.baseRevision !== proposal.expectedOriginalHeadRevision ||
      proposal.branchName !== expectedBranch ||
      !proposal.body.includes(replacementDraftMarker(proposal.publicationRunId, proposal.runDigest))
    ) {
      context.addIssue({
        code: "custom",
        message: "Replacement-draft proposal is not deterministic."
      });
    }
  });
export type FactoryExternalPullRequestReplacementDraftProposal = z.infer<
  typeof factoryExternalPullRequestReplacementDraftProposalSchema
>;

export const factoryExternalPullRequestReplacementDraftRecordSchema = z
  .object({
    schemaVersion: z.literal("agentlab.external-pull-request-replacement-draft-record.v1"),
    publicationRunId: z.uuid(),
    runDigest: sha256DigestSchema,
    proposalDigest: sha256DigestSchema,
    qualificationBundleDigest: sha256DigestSchema,
    repositoryId: repositoryIdSchema,
    originalPullRequestNumber: z.number().int().positive(),
    originalPullRequestUrl: z.url().max(2_048),
    replacementPullRequestNumber: z.number().int().positive(),
    replacementPullRequestUrl: z.url().max(2_048),
    baseBranch: branchNameSchema,
    baseRevision: gitObjectIdSchema,
    branchName: branchNameSchema,
    headRevision: gitObjectIdSchema,
    brokerId: factoryIdentifierSchema,
    publisherId: factoryIdentifierSchema,
    draft: z.literal(true),
    createdAt: factoryTimestampSchema
  })
  .strict()
  .refine((record) => record.originalPullRequestNumber !== record.replacementPullRequestNumber, {
    message: "A replacement draft must be a distinct pull request."
  });
export type FactoryExternalPullRequestReplacementDraftRecord = z.infer<
  typeof factoryExternalPullRequestReplacementDraftRecordSchema
>;

export const factoryExternalPullRequestReplacementDraftStateSchema = z.enum([
  "ready",
  "branch-publish-intent-recorded",
  "branch-published",
  "pull-request-open-intent-recorded",
  "pull-request-opened",
  "completed",
  "stale",
  "quarantined"
]);
export type FactoryExternalPullRequestReplacementDraftState = z.infer<
  typeof factoryExternalPullRequestReplacementDraftStateSchema
>;

const eventCommon = {
  schemaVersion: z.literal("agentlab.external-pull-request-replacement-draft-event.v1"),
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

export const factoryExternalPullRequestReplacementDraftEventSchema = z.discriminatedUnion("kind", [
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
      kind: z.literal("branch-publish-intent-recorded"),
      from: z.literal("ready"),
      to: z.literal("branch-publish-intent-recorded"),
      proposalDigest: sha256DigestSchema,
      proposalArtifact: factoryArtifactReferenceSchema
    })
    .strict(),
  z
    .object({
      ...eventCommon,
      kind: z.literal("branch-published"),
      from: z.literal("branch-publish-intent-recorded"),
      to: z.literal("branch-published"),
      proposalDigest: sha256DigestSchema,
      headRevision: gitObjectIdSchema
    })
    .strict(),
  z
    .object({
      ...eventCommon,
      kind: z.literal("pull-request-open-intent-recorded"),
      from: z.literal("branch-published"),
      to: z.literal("pull-request-open-intent-recorded"),
      proposalDigest: sha256DigestSchema,
      headRevision: gitObjectIdSchema
    })
    .strict(),
  z
    .object({
      ...eventCommon,
      kind: z.literal("pull-request-opened"),
      from: z.literal("pull-request-open-intent-recorded"),
      to: z.literal("pull-request-opened"),
      recordDigest: sha256DigestSchema,
      recordArtifact: factoryArtifactReferenceSchema
    })
    .strict(),
  z
    .object({
      ...eventCommon,
      kind: z.literal("completed"),
      from: z.literal("pull-request-opened"),
      to: z.literal("completed"),
      recordDigest: sha256DigestSchema
    })
    .strict(),
  z
    .object({
      ...eventCommon,
      kind: z.literal("stale"),
      from: z.enum([
        "ready",
        "branch-publish-intent-recorded",
        "branch-published",
        "pull-request-open-intent-recorded"
      ]),
      to: z.literal("stale"),
      evidenceDigest: sha256DigestSchema.nullable()
    })
    .strict(),
  z
    .object({
      ...eventCommon,
      kind: z.literal("quarantined"),
      from: z.enum([
        "branch-publish-intent-recorded",
        "branch-published",
        "pull-request-open-intent-recorded",
        "pull-request-opened"
      ]),
      to: z.literal("quarantined"),
      evidenceDigest: sha256DigestSchema.nullable()
    })
    .strict()
]);
export type FactoryExternalPullRequestReplacementDraftEvent = z.infer<
  typeof factoryExternalPullRequestReplacementDraftEventSchema
>;

export function replacementDraftBranchName(
  pullRequestNumber: number,
  qualificationBundleDigest: string
): string {
  return `agentlab/external-repair/pr-${String(pullRequestNumber)}-${qualificationBundleDigest.slice("sha256:".length, "sha256:".length + 16)}`;
}

export function replacementDraftMarker(publicationRunId: string, runDigest: string): string {
  return `<!-- agentlab:external-repair publication=${publicationRunId} run=${runDigest} -->`;
}
