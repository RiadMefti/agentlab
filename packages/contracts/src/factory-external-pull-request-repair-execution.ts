import { z } from "zod";

import {
  factoryActorSchema,
  factoryAgentRunStatusSchema,
  factoryArtifactReferenceSchema,
  factoryBudgetSchema,
  factoryBudgetUsageSchema,
  factoryCapabilityGrantSchema,
  factoryChangeSetSchema,
  factoryIdentifierSchema,
  factoryProcessIsolationSchema,
  factoryResourceLimitsSchema,
  factorySemanticVersionSchema,
  factoryTimestampSchema,
  gitObjectIdSchema,
  repositoryPathPatternSchema,
  sha256DigestSchema
} from "./factory.js";
import { factoryExternalPullRequestRepairFindingSelectorSchema } from "./factory-external-pull-request-repair-admission.js";
import { modelIdSchema, providerIdSchema, reasoningIdSchema } from "./provider.js";

const repositoryIdSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/u);

const repairerCapabilitiesSchema = factoryCapabilityGrantSchema.superRefine(
  (capabilities, context) => {
    if (
      capabilities.filesystem !== "workspace-write" ||
      capabilities.git !== "worktree-write" ||
      capabilities.remoteRepository !== "none" ||
      capabilities.process !== "sandboxed" ||
      capabilities.network.mode !== "off" ||
      capabilities.secretRefs.length > 0 ||
      capabilities.commandAllowlist.length > 0
    ) {
      context.addIssue({
        code: "custom",
        message: "External repairers require an exact credentialless workspace-write grant."
      });
    }
  }
);

const repairerProfileSchema = z
  .object({
    id: factoryIdentifierSchema,
    provider: providerIdSchema,
    model: modelIdSchema,
    reasoning: reasoningIdSchema.nullable(),
    skillDigests: z.array(sha256DigestSchema).min(1).max(16),
    capabilities: repairerCapabilitiesSchema,
    budget: factoryBudgetSchema
  })
  .strict()
  .superRefine((profile, context) => {
    if (new Set(profile.skillDigests).size !== profile.skillDigests.length) {
      context.addIssue({
        code: "custom",
        path: ["skillDigests"],
        message: "External repair skill digests must be unique."
      });
    }
    if (
      profile.budget.maxWorkers !== 1 ||
      profile.budget.maxRepairAttempts !== 1 ||
      profile.budget.maxChangedFiles < 1 ||
      profile.budget.maxChangedLines < 1
    ) {
      context.addIssue({
        code: "custom",
        path: ["budget"],
        message: "External repair requires one bounded worker and one repair attempt."
      });
    }
  });

/** Credentialless authority ceiling for consuming one admitted external-PR repair. */
export const factoryExternalPullRequestRepairExecutionPolicySchema = z
  .object({
    schemaVersion: z.literal("agentlab.external-pull-request-repair-execution-policy.v1"),
    id: z.literal("agentlab/external-pull-request-repair-execution"),
    version: factorySemanticVersionSchema,
    repositoryId: repositoryIdSchema,
    costPolicyDigest: sha256DigestSchema,
    roleIdentityPolicyDigest: sha256DigestSchema,
    gateProfileDigest: sha256DigestSchema,
    repairerProfile: repairerProfileSchema,
    protectedPaths: z.array(repositoryPathPatternSchema).max(256),
    maximumChangedFiles: z.number().int().min(1).max(99),
    maximumChangedLines: z.number().int().min(1).max(20_000),
    maximumPatchBytes: z
      .number()
      .int()
      .min(1)
      .max(8 * 1_024 * 1_024),
    maximumPromptBytes: z
      .number()
      .int()
      .min(1)
      .max(1 * 1_024 * 1_024),
    operationDeadlineSeconds: z.number().int().min(60).max(86_400),
    maximumCandidatesPerTick: z.number().int().min(1).max(10),
    resourceLimits: factoryResourceLimitsSchema,
    maximumRecoveryAttempts: z.number().int().min(0).max(2),
    maximumRiskTier: z.literal("R1"),
    maximumRepairAttempts: z.literal(1),
    publicationMode: z.literal("replacement-draft"),
    remoteWrite: z.literal(false),
    autoMerge: z.literal(false),
    release: z.literal(false)
  })
  .strict()
  .superRefine((policy, context) => {
    if (new Set(policy.protectedPaths).size !== policy.protectedPaths.length) {
      context.addIssue({
        code: "custom",
        path: ["protectedPaths"],
        message: "External repair protected paths must be unique."
      });
    }
    if (
      policy.maximumChangedFiles > policy.repairerProfile.budget.maxChangedFiles ||
      policy.maximumChangedLines > policy.repairerProfile.budget.maxChangedLines ||
      policy.resourceLimits.maxProcesses > policy.repairerProfile.budget.maxProcesses
    ) {
      context.addIssue({
        code: "custom",
        message: "External repair policy limits exceed the repairer profile budget."
      });
    }
  });
export type FactoryExternalPullRequestRepairExecutionPolicy = z.infer<
  typeof factoryExternalPullRequestRepairExecutionPolicySchema
>;

/** Immutable identity for one authorization-bound, exact-head repair execution. */
export const factoryExternalPullRequestRepairExecutionRunSchema = z
  .object({
    schemaVersion: z.literal("agentlab.external-pull-request-repair-execution-run.v1"),
    runId: z.uuid(),
    repositoryId: repositoryIdSchema,
    pullRequestNumber: z.number().int().positive(),
    authorizationId: z.uuid(),
    authorizationDigest: sha256DigestSchema,
    admissionDecisionDigest: sha256DigestSchema,
    feedbackPublicationRunDigest: sha256DigestSchema,
    feedbackRecordDigest: sha256DigestSchema,
    reviewRunDigest: sha256DigestSchema,
    reviewBundleDigest: sha256DigestSchema,
    admissionPolicyDigest: sha256DigestSchema,
    repairExecutionPolicyDigest: sha256DigestSchema,
    repairExecutionPolicy: factoryExternalPullRequestRepairExecutionPolicySchema,
    expectedBaseRevision: gitObjectIdSchema,
    expectedHeadRevision: gitObjectIdSchema,
    originalPatchDigest: sha256DigestSchema,
    selectedFindings: z.array(factoryExternalPullRequestRepairFindingSelectorSchema).min(1).max(64),
    repairAttempt: z.literal(1),
    workspaceId: z.uuid(),
    createdAt: factoryTimestampSchema,
    deadlineAt: factoryTimestampSchema,
    correlationId: z.uuid()
  })
  .strict()
  .superRefine((run, context) => {
    if (run.repositoryId !== run.repairExecutionPolicy.repositoryId) {
      context.addIssue({
        code: "custom",
        message: "External repair run coordinates disagree with its execution policy."
      });
    }
    if (run.createdAt >= run.deadlineAt) {
      context.addIssue({
        code: "custom",
        path: ["deadlineAt"],
        message: "External repair deadline must follow creation."
      });
    }
  });
export type FactoryExternalPullRequestRepairExecutionRun = z.infer<
  typeof factoryExternalPullRequestRepairExecutionRunSchema
>;

/** Provider-neutral request containing only authority selectors; prose remains in the prompt. */
export const factoryExternalPullRequestRepairerRequestSchema = z
  .object({
    schemaVersion: z.literal("agentlab.external-pull-request-repairer-request.v1"),
    executionId: z.uuid(),
    repairRunId: z.uuid(),
    taskId: z.uuid(),
    contractDigest: sha256DigestSchema,
    authorizationDigest: sha256DigestSchema,
    feedbackPublicationRunDigest: sha256DigestSchema,
    feedbackRecordDigest: sha256DigestSchema,
    selectedFindings: z.array(factoryExternalPullRequestRepairFindingSelectorSchema).min(1).max(64),
    repairerId: factoryIdentifierSchema,
    role: z.literal("repairer"),
    attempt: z.literal(1),
    provider: providerIdSchema,
    model: modelIdSchema,
    reasoning: reasoningIdSchema.nullable(),
    repository: z.object({ id: repositoryIdSchema, baseRevision: gitObjectIdSchema }).strict(),
    pullRequest: z
      .object({
        number: z.number().int().positive(),
        originalBaseRevision: gitObjectIdSchema,
        headRevision: gitObjectIdSchema,
        originalPatchDigest: sha256DigestSchema
      })
      .strict(),
    promptArtifact: factoryArtifactReferenceSchema,
    skillDigests: z.array(sha256DigestSchema).min(1).max(16),
    capabilities: repairerCapabilitiesSchema,
    budget: factoryBudgetSchema
  })
  .strict()
  .superRefine((request, context) => {
    if (
      request.repairRunId !== request.taskId ||
      request.repository.baseRevision !== request.pullRequest.headRevision
    ) {
      context.addIssue({
        code: "custom",
        message: "External repairer request must bind one run and exact-head workspace."
      });
    }
    if (new Set(request.skillDigests).size !== request.skillDigests.length) {
      context.addIssue({
        code: "custom",
        path: ["skillDigests"],
        message: "External repairer request skill digests must be unique."
      });
    }
  });
export type FactoryExternalPullRequestRepairerRequest = z.infer<
  typeof factoryExternalPullRequestRepairerRequestSchema
>;

export const factoryExternalPullRequestRepairerRecordSchema = z
  .object({
    schemaVersion: z.literal("agentlab.external-pull-request-repairer-record.v1"),
    repairRunId: z.uuid(),
    runDigest: sha256DigestSchema,
    requestDigest: sha256DigestSchema,
    executionId: z.uuid(),
    repairerId: factoryIdentifierSchema,
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
        message: "Repair ended before it started."
      });
    }
    if (record.status === "succeeded" && (record.exitCode !== 0 || record.errorCode !== null)) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Successful repair execution is inconsistent."
      });
    }
    if (record.status !== "succeeded" && record.errorCode === null) {
      context.addIssue({
        code: "custom",
        path: ["errorCode"],
        message: "Failed repair execution needs an error code."
      });
    }
  });
export type FactoryExternalPullRequestRepairerRecord = z.infer<
  typeof factoryExternalPullRequestRepairerRecordSchema
>;

/** Immutable credentialless output for a later, separately brokered replacement draft. */
export const factoryExternalPullRequestRepairBundleSchema = z
  .object({
    schemaVersion: z.literal("agentlab.external-pull-request-repair-bundle.v1"),
    repairRunId: z.uuid(),
    runDigest: sha256DigestSchema,
    repositoryId: repositoryIdSchema,
    pullRequestNumber: z.number().int().positive(),
    authorizationDigest: sha256DigestSchema,
    repairExecutionPolicyDigest: sha256DigestSchema,
    expectedHeadRevision: gitObjectIdSchema,
    originalPatchDigest: sha256DigestSchema,
    repairerRequestDigest: sha256DigestSchema,
    repairerRecordDigest: sha256DigestSchema,
    executionId: z.uuid(),
    patchArtifact: factoryArtifactReferenceSchema,
    changeSet: factoryChangeSetSchema,
    usage: factoryBudgetUsageSchema,
    usageComplete: z.literal(true),
    repairAttempt: z.literal(1),
    publicationMode: z.literal("replacement-draft"),
    remoteWrite: z.literal(false),
    autoMerge: z.literal(false),
    release: z.literal(false),
    workspaceClosed: z.literal(true),
    createdAt: factoryTimestampSchema
  })
  .strict()
  .superRefine((bundle, context) => {
    if (
      bundle.changeSet.baseRevision !== bundle.expectedHeadRevision ||
      bundle.changeSet.changedFiles < 1 ||
      bundle.patchArtifact.sizeBytes < 1 ||
      bundle.usage.repairAttempts !== 1 ||
      bundle.usage.changedFiles !== bundle.changeSet.changedFiles ||
      bundle.usage.changedLines !== bundle.changeSet.changedLines
    ) {
      context.addIssue({
        code: "custom",
        message: "External repair bundle patch, usage, and exact-head lineage disagree."
      });
    }
  });
export type FactoryExternalPullRequestRepairBundle = z.infer<
  typeof factoryExternalPullRequestRepairBundleSchema
>;

export const factoryExternalPullRequestRepairExecutionStateSchema = z.enum([
  "ready",
  "workspace-active",
  "prepared",
  "repairer-active",
  "recorded",
  "completed",
  "failed",
  "quarantined"
]);
export type FactoryExternalPullRequestRepairExecutionState = z.infer<
  typeof factoryExternalPullRequestRepairExecutionStateSchema
>;

const eventCommon = {
  schemaVersion: z.literal("agentlab.external-pull-request-repair-execution-event.v1"),
  eventId: z.uuid(),
  repairRunId: z.uuid(),
  runDigest: sha256DigestSchema,
  sequence: z.number().int().min(1).max(32),
  previousEventDigest: sha256DigestSchema.nullable(),
  actor: factoryActorSchema,
  occurredAt: factoryTimestampSchema,
  reasonCode: factoryIdentifierSchema,
  correlationId: z.uuid()
} as const;

export const factoryExternalPullRequestRepairExecutionEventSchema = z.discriminatedUnion("kind", [
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
      to: z.literal("prepared"),
      sourcePatchDigest: sha256DigestSchema,
      sourcePatchArtifact: factoryArtifactReferenceSchema
    })
    .strict(),
  z
    .object({
      ...eventCommon,
      kind: z.literal("repairer-started"),
      from: z.literal("prepared"),
      to: z.literal("repairer-active"),
      repairerId: factoryIdentifierSchema,
      executionId: z.uuid(),
      requestDigest: sha256DigestSchema
    })
    .strict(),
  z
    .object({
      ...eventCommon,
      kind: z.literal("recovered"),
      from: z.enum(["workspace-active", "prepared"]),
      to: z.literal("ready")
    })
    .strict(),
  z
    .object({
      ...eventCommon,
      kind: z.literal("bundle-recorded"),
      from: z.literal("repairer-active"),
      to: z.literal("recorded"),
      repairerId: factoryIdentifierSchema,
      executionId: z.uuid(),
      requestDigest: sha256DigestSchema,
      repairerRecordDigest: sha256DigestSchema,
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
      bundleDigest: sha256DigestSchema
    })
    .strict(),
  z
    .object({
      ...eventCommon,
      kind: z.literal("failed"),
      from: z.enum(["ready", "workspace-active", "prepared", "repairer-active"]),
      to: z.literal("failed"),
      repairerRecordDigest: sha256DigestSchema.nullable()
    })
    .strict(),
  z
    .object({
      ...eventCommon,
      kind: z.literal("quarantined"),
      from: z.enum(["workspace-active", "prepared", "repairer-active"]),
      to: z.literal("quarantined"),
      repairerRecordDigest: sha256DigestSchema.nullable()
    })
    .strict()
]);
export type FactoryExternalPullRequestRepairExecutionEvent = z.infer<
  typeof factoryExternalPullRequestRepairExecutionEventSchema
>;
