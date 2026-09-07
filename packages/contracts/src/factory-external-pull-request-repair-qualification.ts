import { z } from "zod";

import {
  factoryActorSchema,
  factoryArtifactReferenceSchema,
  factoryBudgetSchema,
  factoryBudgetUsageSchema,
  factoryCapabilityGrantSchema,
  factoryChangeSetSchema,
  factoryGateObservationSchema,
  factoryIdentifierSchema,
  factoryResourceIsolationRecordSchema,
  factoryResourceLimitsSchema,
  factorySemanticVersionSchema,
  factoryTimestampSchema,
  gitObjectIdSchema,
  sha256DigestSchema
} from "./factory.js";
import {
  factoryExternalPullRequestReviewerRecordSchema,
  factoryExternalPullRequestReviewResultSchema
} from "./factory-external-pull-request-review.js";
import { modelIdSchema, providerIdSchema, reasoningIdSchema } from "./provider.js";

const repositoryIdSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/u);

const absoluteExecutableSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => value.startsWith("/") && !value.includes("\0"));

const gateIdSchema = z.enum([
  "format",
  "architecture",
  "typecheck",
  "lint",
  "test",
  "build",
  "secret-scan"
]);

const gateDefinitionSchema = z
  .object({
    id: gateIdSchema,
    evidenceKind: z.enum(["test", "build", "security", "provenance"]),
    command: z
      .object({
        executable: absoluteExecutableSchema,
        executableDigest: sha256DigestSchema,
        args: z
          .array(
            z
              .string()
              .max(4_096)
              .refine((value) => !value.includes("\0"))
          )
          .max(128)
      })
      .strict(),
    timeoutMs: z.number().int().min(1).max(3_600_000),
    maximumOutputBytes: z.number().int().min(1).max(1_073_741_824)
  })
  .strict();

const requiredGateIds = [
  "format",
  "architecture",
  "typecheck",
  "lint",
  "test",
  "build",
  "secret-scan"
] as const;

/** Content-addressed commands for the non-negotiable external R1 quality floor. */
export const factoryExternalPullRequestRepairGateProfileSchema = z
  .object({
    schemaVersion: z.literal("agentlab.external-pull-request-repair-gate-profile.v1"),
    id: z.literal("agentlab/external-pull-request-repair-gates"),
    version: factorySemanticVersionSchema,
    repositoryId: repositoryIdSchema,
    gates: z.array(gateDefinitionSchema).length(requiredGateIds.length)
  })
  .strict()
  .superRefine((profile, context) => {
    if (profile.gates.some(({ id }, index) => id !== requiredGateIds[index])) {
      context.addIssue({
        code: "custom",
        path: ["gates"],
        message: "External repair gates must contain the exact ordered R1 quality floor."
      });
    }
    const expectedEvidence = {
      format: "test",
      architecture: "test",
      typecheck: "test",
      lint: "test",
      test: "test",
      build: "build",
      "secret-scan": "security"
    } as const;
    if (profile.gates.some((gate) => gate.evidenceKind !== expectedEvidence[gate.id])) {
      context.addIssue({
        code: "custom",
        path: ["gates"],
        message: "External repair gate evidence kinds do not match the R1 quality floor."
      });
    }
  });
export type FactoryExternalPullRequestRepairGateProfile = z.infer<
  typeof factoryExternalPullRequestRepairGateProfileSchema
>;

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
        message: "External repair qualification reviewers require an exact read-only capability."
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
        message: "Qualification reviewer skill digests must be unique."
      });
    }
    const expectedProcess = profile.provider === "codex" ? "sandboxed" : "none";
    if (profile.capabilities.process !== expectedProcess) {
      context.addIssue({
        code: "custom",
        path: ["capabilities", "process"],
        message: "Qualification reviewer process isolation must match its provider adapter."
      });
    }
  });

/** No-write authority for gates and independent review of one repaired external patch. */
export const factoryExternalPullRequestRepairQualificationPolicySchema = z
  .object({
    schemaVersion: z.literal("agentlab.external-pull-request-repair-qualification-policy.v1"),
    id: z.literal("agentlab/external-pull-request-repair-qualification"),
    version: factorySemanticVersionSchema,
    repositoryId: repositoryIdSchema,
    costPolicyDigest: sha256DigestSchema,
    roleIdentityPolicyDigest: sha256DigestSchema,
    gateProfileDigest: sha256DigestSchema,
    gateProfile: factoryExternalPullRequestRepairGateProfileSchema,
    reviewerProfiles: z.array(reviewerProfileSchema).min(1).max(5),
    minimumIndependentReviews: z.number().int().min(1).max(5),
    aggregateBudget: factoryBudgetSchema,
    resourceLimits: factoryResourceLimitsSchema,
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
    operationDeadlineSeconds: z.number().int().min(60).max(86_400),
    maximumCandidatesPerTick: z.number().int().min(1).max(10),
    maximumRecoveryAttempts: z.number().int().min(0).max(2),
    maximumRiskTier: z.literal("R1"),
    publicationMode: z.literal("replacement-draft"),
    remoteWrite: z.literal(false),
    autoMerge: z.literal(false),
    release: z.literal(false)
  })
  .strict()
  .superRefine((policy, context) => {
    const profileIds = policy.reviewerProfiles.map(({ id }) => id);
    if (new Set(profileIds).size !== profileIds.length) {
      context.addIssue({
        code: "custom",
        path: ["reviewerProfiles"],
        message: "Qualification reviewer profile IDs must be unique."
      });
    }
    if (policy.minimumIndependentReviews > policy.reviewerProfiles.length) {
      context.addIssue({
        code: "custom",
        path: ["minimumIndependentReviews"],
        message: "Qualification review threshold exceeds its reviewer inventory."
      });
    }
    if (
      policy.repositoryId !== policy.gateProfile.repositoryId ||
      policy.resourceLimits.maxProcesses > policy.aggregateBudget.maxProcesses
    ) {
      context.addIssue({
        code: "custom",
        message: "Qualification policy coordinates or process ceilings are inconsistent."
      });
    }
    const selectedReviewers = policy.reviewerProfiles.slice(0, policy.minimumIndependentReviews);
    const reserved = {
      wallClockSeconds:
        policy.gateProfile.gates.reduce(
          (total, gate) => total + Math.ceil(gate.timeoutMs / 1_000),
          0
        ) +
        selectedReviewers.reduce((total, profile) => total + profile.budget.wallClockSeconds, 0),
      maxAgentTurns: selectedReviewers.reduce(
        (total, profile) => total + profile.budget.maxAgentTurns,
        0
      ),
      maxToolCalls: selectedReviewers.reduce(
        (total, profile) => total + profile.budget.maxToolCalls,
        0
      ),
      maxInputTokens: selectedReviewers.reduce(
        (total, profile) => total + profile.budget.maxInputTokens,
        0
      ),
      maxOutputTokens: selectedReviewers.reduce(
        (total, profile) => total + profile.budget.maxOutputTokens,
        0
      ),
      maxCostMicrousd: selectedReviewers.reduce(
        (total, profile) => total + profile.budget.maxCostMicrousd,
        0
      ),
      maxProcesses:
        policy.gateProfile.gates.length +
        selectedReviewers.reduce((total, profile) => total + profile.budget.maxProcesses, 0),
      maxOutputBytes:
        policy.gateProfile.gates.reduce((total, gate) => total + gate.maximumOutputBytes, 0) +
        selectedReviewers.reduce((total, profile) => total + profile.budget.maxOutputBytes, 0)
    };
    if (
      reserved.wallClockSeconds > policy.aggregateBudget.wallClockSeconds ||
      reserved.wallClockSeconds > policy.operationDeadlineSeconds ||
      reserved.maxAgentTurns > policy.aggregateBudget.maxAgentTurns ||
      reserved.maxToolCalls > policy.aggregateBudget.maxToolCalls ||
      reserved.maxInputTokens > policy.aggregateBudget.maxInputTokens ||
      reserved.maxOutputTokens > policy.aggregateBudget.maxOutputTokens ||
      reserved.maxCostMicrousd > policy.aggregateBudget.maxCostMicrousd ||
      reserved.maxProcesses > policy.aggregateBudget.maxProcesses ||
      reserved.maxOutputBytes > policy.aggregateBudget.maxOutputBytes
    ) {
      context.addIssue({
        code: "custom",
        path: ["aggregateBudget"],
        message:
          "Qualification aggregate budget and deadline cannot reserve every required gate and review."
      });
    }
  });
export type FactoryExternalPullRequestRepairQualificationPolicy = z.infer<
  typeof factoryExternalPullRequestRepairQualificationPolicySchema
>;

/** Immutable identity rooted in one completed repair bundle. */
export const factoryExternalPullRequestRepairQualificationRunSchema = z
  .object({
    schemaVersion: z.literal("agentlab.external-pull-request-repair-qualification-run.v1"),
    qualificationRunId: z.uuid(),
    repositoryId: repositoryIdSchema,
    pullRequestNumber: z.number().int().positive(),
    repairRunId: z.uuid(),
    repairRunDigest: sha256DigestSchema,
    repairBundleDigest: sha256DigestSchema,
    authorizationDigest: sha256DigestSchema,
    repairExecutionPolicyDigest: sha256DigestSchema,
    qualificationPolicyDigest: sha256DigestSchema,
    qualificationPolicy: factoryExternalPullRequestRepairQualificationPolicySchema,
    gateProfileDigest: sha256DigestSchema,
    expectedBaseRevision: gitObjectIdSchema,
    expectedHeadRevision: gitObjectIdSchema,
    originalPatchDigest: sha256DigestSchema,
    repairedPatchDigest: sha256DigestSchema,
    repairerId: factoryIdentifierSchema,
    repairerRecordDigest: sha256DigestSchema,
    repairerExecutionId: z.uuid(),
    repairerProviderSessionId: z.string().trim().min(1).max(256),
    workspaceId: z.uuid(),
    createdAt: factoryTimestampSchema,
    deadlineAt: factoryTimestampSchema,
    correlationId: z.uuid()
  })
  .strict()
  .superRefine((run, context) => {
    if (
      run.repositoryId !== run.qualificationPolicy.repositoryId ||
      run.gateProfileDigest !== run.qualificationPolicy.gateProfileDigest
    ) {
      context.addIssue({
        code: "custom",
        message: "Qualification run coordinates disagree with its policy."
      });
    }
    if (run.createdAt >= run.deadlineAt) {
      context.addIssue({
        code: "custom",
        path: ["deadlineAt"],
        message: "Qualification deadline must follow creation."
      });
    }
  });
export type FactoryExternalPullRequestRepairQualificationRun = z.infer<
  typeof factoryExternalPullRequestRepairQualificationRunSchema
>;

export const factoryExternalPullRequestRepairQualificationBundleSchema = z
  .object({
    schemaVersion: z.literal("agentlab.external-pull-request-repair-qualification-bundle.v1"),
    qualificationRunId: z.uuid(),
    runDigest: sha256DigestSchema,
    repositoryId: repositoryIdSchema,
    pullRequestNumber: z.number().int().positive(),
    repairRunDigest: sha256DigestSchema,
    repairBundleDigest: sha256DigestSchema,
    qualificationPolicyDigest: sha256DigestSchema,
    gateProfileDigest: sha256DigestSchema,
    repairedPatchArtifact: factoryArtifactReferenceSchema,
    changeSet: factoryChangeSetSchema,
    gateObservations: z.array(factoryGateObservationSchema).min(1).max(7),
    gateIsolationRecords: z.array(factoryResourceIsolationRecordSchema).min(1).max(7),
    reviewerRecords: z.array(factoryExternalPullRequestReviewerRecordSchema).max(5),
    reviews: z.array(factoryExternalPullRequestReviewResultSchema).max(5),
    decision: z.enum(["qualified", "rejected", "human-review-required"]),
    aggregateUsage: factoryBudgetUsageSchema,
    usageComplete: z.literal(true),
    workspaceUnchanged: z.literal(true),
    workspaceClosed: z.literal(true),
    publicationMode: z.literal("replacement-draft"),
    remoteWrite: z.literal(false),
    autoMerge: z.literal(false),
    release: z.literal(false),
    createdAt: factoryTimestampSchema
  })
  .strict()
  .superRefine((bundle, context) => {
    const gateIds = bundle.gateObservations.map(({ gateId }) => gateId);
    const isolationIds = bundle.gateIsolationRecords.map(({ execution }) =>
      execution.kind === "gate" ? execution.gateId : null
    );
    const reviewerIds = bundle.reviews.map(({ reviewerId }) => reviewerId);
    if (
      new Set(gateIds).size !== gateIds.length ||
      gateIds.some((gateId, index) => gateId !== requiredGateIds[index]) ||
      isolationIds.some((gateId, index) => gateId !== gateIds[index]) ||
      bundle.reviewerRecords.length !== bundle.reviews.length ||
      new Set(reviewerIds).size !== reviewerIds.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Qualification evidence is not an ordered, independent, complete set."
      });
    }
    if (
      bundle.changeSet.baseRevision !== bundle.gateObservations[0]?.baseRevision ||
      bundle.gateObservations.some(
        ({ taskId, contractDigest, baseRevision }) =>
          taskId !== bundle.qualificationRunId ||
          contractDigest !== bundle.runDigest ||
          baseRevision !== bundle.changeSet.baseRevision
      ) ||
      bundle.gateIsolationRecords.some(
        ({ taskId, contractDigest, subjectDigest }) =>
          taskId !== bundle.qualificationRunId ||
          contractDigest !== bundle.runDigest ||
          subjectDigest !== bundle.repairBundleDigest
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Qualification gate evidence changed its exact repaired-patch lineage."
      });
    }
    const allGatesPassed = bundle.gateObservations.every(({ result }) => result === "pass");
    const allReviewsApproved =
      bundle.reviews.length > 0 && bundle.reviews.every(({ verdict }) => verdict === "approved");
    if (bundle.decision === "qualified" && (!allGatesPassed || !allReviewsApproved)) {
      context.addIssue({
        code: "custom",
        path: ["decision"],
        message: "Qualified repair evidence requires every gate and review to pass."
      });
    }
    if (!allGatesPassed && bundle.decision !== "rejected") {
      context.addIssue({
        code: "custom",
        path: ["decision"],
        message: "A failed strict gate must reject publication."
      });
    }
  });
export type FactoryExternalPullRequestRepairQualificationBundle = z.infer<
  typeof factoryExternalPullRequestRepairQualificationBundleSchema
>;

export const factoryExternalPullRequestRepairQualificationStateSchema = z.enum([
  "ready",
  "workspace-active",
  "gating",
  "gate-active",
  "reviewing",
  "reviewer-active",
  "recorded",
  "completed",
  "failed",
  "quarantined"
]);
export type FactoryExternalPullRequestRepairQualificationState = z.infer<
  typeof factoryExternalPullRequestRepairQualificationStateSchema
>;

const eventCommon = {
  schemaVersion: z.literal("agentlab.external-pull-request-repair-qualification-event.v1"),
  eventId: z.uuid(),
  qualificationRunId: z.uuid(),
  runDigest: sha256DigestSchema,
  sequence: z.number().int().min(1).max(128),
  previousEventDigest: sha256DigestSchema.nullable(),
  actor: factoryActorSchema,
  occurredAt: factoryTimestampSchema,
  reasonCode: factoryIdentifierSchema,
  correlationId: z.uuid()
} as const;

export const factoryExternalPullRequestRepairQualificationEventSchema = z.discriminatedUnion(
  "kind",
  [
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
        to: z.enum(["gating", "reviewing"]),
        patchDigest: sha256DigestSchema,
        patchArtifact: factoryArtifactReferenceSchema
      })
      .strict(),
    z
      .object({
        ...eventCommon,
        kind: z.literal("gate-started"),
        from: z.literal("gating"),
        to: z.literal("gate-active"),
        gateId: gateIdSchema,
        isolationId: z.uuid()
      })
      .strict(),
    z
      .object({
        ...eventCommon,
        kind: z.literal("gate-finished"),
        from: z.literal("gate-active"),
        to: z.literal("gating"),
        gateId: gateIdSchema,
        isolationId: z.uuid(),
        gateObservationDigest: sha256DigestSchema,
        isolationRecordDigest: sha256DigestSchema
      })
      .strict(),
    z
      .object({
        ...eventCommon,
        kind: z.literal("gates-passed"),
        from: z.literal("gating"),
        to: z.literal("reviewing")
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
        from: z.enum(["workspace-active", "gating", "reviewing"]),
        to: z.literal("ready")
      })
      .strict(),
    z
      .object({
        ...eventCommon,
        kind: z.literal("bundle-recorded"),
        from: z.enum(["gating", "reviewing"]),
        to: z.literal("recorded"),
        bundleDigest: sha256DigestSchema,
        bundleArtifact: factoryArtifactReferenceSchema,
        decision: z.enum(["qualified", "rejected", "human-review-required"])
      })
      .strict(),
    z
      .object({
        ...eventCommon,
        kind: z.literal("completed"),
        from: z.literal("recorded"),
        to: z.literal("completed"),
        bundleDigest: sha256DigestSchema,
        decision: z.enum(["qualified", "rejected", "human-review-required"])
      })
      .strict(),
    z
      .object({
        ...eventCommon,
        kind: z.literal("failed"),
        from: z.enum([
          "ready",
          "workspace-active",
          "gating",
          "gate-active",
          "reviewing",
          "reviewer-active"
        ]),
        to: z.literal("failed"),
        evidenceDigest: sha256DigestSchema.nullable()
      })
      .strict(),
    z
      .object({
        ...eventCommon,
        kind: z.literal("quarantined"),
        from: z.enum(["workspace-active", "gating", "gate-active", "reviewing", "reviewer-active"]),
        to: z.literal("quarantined"),
        evidenceDigest: sha256DigestSchema.nullable()
      })
      .strict()
  ]
);
export type FactoryExternalPullRequestRepairQualificationEvent = z.infer<
  typeof factoryExternalPullRequestRepairQualificationEventSchema
>;
