import { z } from "zod";

import {
  factoryActorSchema,
  factoryIdentifierSchema,
  factorySemanticVersionSchema,
  factoryTimestampSchema,
  gitObjectIdSchema,
  sha256DigestSchema
} from "./factory.js";

const repositoryIdSchema = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/u);

const externalIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine((value) => {
    for (let index = 0; index < value.length; index += 1) {
      const code = value.charCodeAt(index);
      if (code < 32 || code === 127) return false;
    }
    return true;
  }, "External ID contains a control character.");

const trustedStatusCheckSchema = z
  .object({
    context: z.enum(["verify", "factory-sandbox"]),
    producerId: factoryIdentifierSchema
  })
  .strict();

/**
 * Separately reviewed authority for the only autonomous merge cohort. The immutable task contract
 * and factory policy must independently opt in; this document can narrow but never widen either.
 */
export const factoryAutonomousMergePolicySchema = z
  .object({
    schemaVersion: z.literal("agentlab.autonomous-merge-policy.v1"),
    id: z.literal("agentlab/r1-scheduled-merge-queue"),
    version: factorySemanticVersionSchema,
    repositoryId: repositoryIdSchema,
    mergerId: factoryIdentifierSchema,
    mergerUserId: z.number().int().min(1).max(4_294_967_294),
    prBrokerUserId: z.number().int().min(1).max(4_294_967_294),
    schedulePolicyDigest: sha256DigestSchema,
    dailyQuotaPolicyDigest: sha256DigestSchema,
    roleIdentityPolicyDigest: sha256DigestSchema,
    requiredStatusChecks: z.array(trustedStatusCheckSchema).length(2),
    minimumIndependentReviews: z.number().int().min(1).max(5),
    maximumObservationAgeSeconds: z.number().int().min(30).max(3_600),
    authorizationLifetimeSeconds: z.number().int().min(30).max(900),
    operationDeadlineSeconds: z.number().int().min(60).max(3_600),
    maximumCandidatesPerTick: z.number().int().min(1).max(10),
    maximumMergesPerUtcDay: z.number().int().min(1).max(10),
    maximumRiskTier: z.literal("R1"),
    allowedTrigger: z.literal("scheduled"),
    deliveryMode: z.literal("merge-queue"),
    markReadyForReview: z.literal(true),
    directMerge: z.literal(false),
    autonomousMerge: z.literal(true),
    release: z.literal(false)
  })
  .strict()
  .superRefine((policy, context) => {
    const identities = policy.requiredStatusChecks.map(
      ({ context: check, producerId }) => `${check}\0${producerId}`
    );
    const names = new Set(policy.requiredStatusChecks.map(({ context: check }) => check));
    if (
      new Set(identities).size !== identities.length ||
      !names.has("verify") ||
      !names.has("factory-sandbox")
    ) {
      context.addIssue({
        code: "custom",
        path: ["requiredStatusChecks"],
        message: "Autonomous merge must bind verify and factory-sandbox exactly once."
      });
    }
    if (policy.mergerUserId === policy.prBrokerUserId) {
      context.addIssue({
        code: "custom",
        path: ["mergerUserId"],
        message: "The autonomous merger and PR broker must use distinct POSIX users."
      });
    }
  });
export type FactoryAutonomousMergePolicy = z.infer<typeof factoryAutonomousMergePolicySchema>;

/** One short-lived, exact-head, single-use authority produced without a remote-write capability. */
export const factoryAutonomousMergeAuthorizationSchema = z
  .object({
    schemaVersion: z.literal("agentlab.autonomous-merge-authorization.v1"),
    authorizationId: z.uuid(),
    taskId: z.uuid(),
    contractDigest: sha256DigestSchema,
    policyBundleDigest: sha256DigestSchema,
    mergePolicyDigest: sha256DigestSchema,
    observationDigest: sha256DigestSchema,
    observationEvidenceBundleDigest: sha256DigestSchema,
    policyEvaluationDigest: sha256DigestSchema,
    policyEvidenceBundleDigest: sha256DigestSchema,
    proposalDigest: sha256DigestSchema,
    pullRequestRecordDigest: sha256DigestSchema,
    repositoryId: repositoryIdSchema,
    pullRequestNumber: z.number().int().positive(),
    pullRequestUrl: z.url().max(2_048),
    branchName: factoryIdentifierSchema,
    expectedBaseRevision: gitObjectIdSchema,
    expectedHeadRevision: gitObjectIdSchema,
    canaryReservationDigest: sha256DigestSchema,
    schedulePolicyDigest: sha256DigestSchema,
    dailyQuotaPolicyDigest: sha256DigestSchema,
    roleIdentityPolicyDigest: sha256DigestSchema,
    riskTier: z.literal("R1"),
    trigger: z.literal("scheduled"),
    deliveryMode: z.literal("merge-queue"),
    markReadyForReview: z.literal(true),
    directMerge: z.literal(false),
    release: z.literal(false),
    issuedAt: factoryTimestampSchema,
    expiresAt: factoryTimestampSchema,
    correlationId: z.uuid()
  })
  .strict()
  .superRefine((authorization, context) => {
    if (authorization.issuedAt >= authorization.expiresAt) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Autonomous merge authorization must expire after issuance."
      });
    }
  });
export type FactoryAutonomousMergeAuthorization = z.infer<
  typeof factoryAutonomousMergeAuthorizationSchema
>;

export const factoryAutonomousMergeStateSchema = z.enum([
  "ready",
  "ready-intent-recorded",
  "ready-for-review",
  "enqueue-intent-recorded",
  "enqueued",
  "merged",
  "merge-evidence-recorded",
  "completed",
  "stale",
  "quarantined"
]);
export type FactoryAutonomousMergeState = z.infer<typeof factoryAutonomousMergeStateSchema>;

export const factoryAutonomousMergeRunSchema = z
  .object({
    schemaVersion: z.literal("agentlab.autonomous-merge-run.v1"),
    mergeRunId: z.uuid(),
    authorizationId: z.uuid(),
    authorizationDigest: sha256DigestSchema,
    taskId: z.uuid(),
    contractDigest: sha256DigestSchema,
    repositoryId: repositoryIdSchema,
    pullRequestNumber: z.number().int().positive(),
    pullRequestUrl: z.url().max(2_048),
    expectedBaseRevision: gitObjectIdSchema,
    expectedHeadRevision: gitObjectIdSchema,
    mergePolicyDigest: sha256DigestSchema,
    mergePolicy: factoryAutonomousMergePolicySchema,
    createdAt: factoryTimestampSchema,
    deadlineAt: factoryTimestampSchema,
    correlationId: z.uuid()
  })
  .strict()
  .superRefine((run, context) => {
    if (run.repositoryId !== run.mergePolicy.repositoryId || run.createdAt >= run.deadlineAt) {
      context.addIssue({
        code: "custom",
        message: "Autonomous merge run coordinates or deadline are inconsistent."
      });
    }
  });
export type FactoryAutonomousMergeRun = z.infer<typeof factoryAutonomousMergeRunSchema>;

const eventCommon = {
  schemaVersion: z.literal("agentlab.autonomous-merge-event.v1"),
  eventId: z.uuid(),
  mergeRunId: z.uuid(),
  runDigest: sha256DigestSchema,
  sequence: z.number().int().min(1).max(9),
  previousEventDigest: sha256DigestSchema.nullable(),
  actor: factoryActorSchema,
  occurredAt: factoryTimestampSchema,
  reasonCode: factoryIdentifierSchema,
  correlationId: z.uuid()
} as const;

export const factoryAutonomousMergeEventSchema = z
  .discriminatedUnion("kind", [
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
        kind: z.literal("ready-intent-recorded"),
        from: z.literal("ready"),
        to: z.literal("ready-intent-recorded")
      })
      .strict(),
    z
      .object({
        ...eventCommon,
        kind: z.literal("ready-for-review"),
        from: z.literal("ready-intent-recorded"),
        to: z.literal("ready-for-review")
      })
      .strict(),
    z
      .object({
        ...eventCommon,
        kind: z.literal("enqueue-intent-recorded"),
        from: z.literal("ready-for-review"),
        to: z.literal("enqueue-intent-recorded")
      })
      .strict(),
    z
      .object({
        ...eventCommon,
        kind: z.literal("enqueued"),
        from: z.literal("enqueue-intent-recorded"),
        to: z.literal("enqueued"),
        mergeQueueEntryId: externalIdSchema
      })
      .strict(),
    z
      .object({
        ...eventCommon,
        kind: z.literal("merged"),
        from: z.enum(["enqueue-intent-recorded", "enqueued"]),
        to: z.literal("merged"),
        mergeQueueEntryId: externalIdSchema,
        mergedRevision: gitObjectIdSchema,
        mergedAt: factoryTimestampSchema
      })
      .strict(),
    z
      .object({
        ...eventCommon,
        kind: z.literal("evidence-recorded"),
        from: z.literal("merged"),
        to: z.literal("merge-evidence-recorded"),
        recordDigest: sha256DigestSchema,
        evidenceBundleDigest: sha256DigestSchema
      })
      .strict(),
    z
      .object({
        ...eventCommon,
        kind: z.literal("completed"),
        from: z.literal("merge-evidence-recorded"),
        to: z.literal("completed"),
        taskEventDigest: sha256DigestSchema
      })
      .strict(),
    z
      .object({
        ...eventCommon,
        kind: z.literal("stale"),
        from: z.enum([
          "ready",
          "ready-intent-recorded",
          "ready-for-review",
          "enqueue-intent-recorded",
          "enqueued"
        ]),
        to: z.literal("stale")
      })
      .strict(),
    z
      .object({
        ...eventCommon,
        kind: z.literal("quarantined"),
        from: z.enum([
          "ready",
          "ready-intent-recorded",
          "ready-for-review",
          "enqueue-intent-recorded",
          "enqueued"
        ]),
        to: z.literal("quarantined")
      })
      .strict()
  ])
  .superRefine((event, context) => {
    if (
      event.kind === "registered" &&
      (event.sequence !== 1 || event.previousEventDigest !== null)
    ) {
      context.addIssue({ code: "custom", message: "Registration must be the first merge event." });
    }
    if (
      event.kind !== "registered" &&
      (event.sequence === 1 || event.previousEventDigest === null)
    ) {
      context.addIssue({ code: "custom", message: "Later merge events must link a predecessor." });
    }
  });
export type FactoryAutonomousMergeEvent = z.infer<typeof factoryAutonomousMergeEventSchema>;

export const factoryAutonomousMergeRecordSchema = z
  .object({
    schemaVersion: z.literal("agentlab.autonomous-merge-record.v1"),
    mergeRunId: z.uuid(),
    runDigest: sha256DigestSchema,
    authorizationDigest: sha256DigestSchema,
    taskId: z.uuid(),
    contractDigest: sha256DigestSchema,
    repositoryId: repositoryIdSchema,
    pullRequestNumber: z.number().int().positive(),
    pullRequestUrl: z.url().max(2_048),
    expectedHeadRevision: gitObjectIdSchema,
    mergedRevision: gitObjectIdSchema,
    mergerId: factoryIdentifierSchema,
    mergeQueueEntryId: externalIdSchema,
    mergedAt: factoryTimestampSchema,
    recordedAt: factoryTimestampSchema
  })
  .strict()
  .superRefine((record, context) => {
    if (record.recordedAt < record.mergedAt) {
      context.addIssue({
        code: "custom",
        path: ["recordedAt"],
        message: "Merge record cannot precede the observed merge."
      });
    }
  });
export type FactoryAutonomousMergeRecord = z.infer<typeof factoryAutonomousMergeRecordSchema>;
