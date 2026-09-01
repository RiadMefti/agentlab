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
const authorAssociationSchema = z.enum([
  "collaborator",
  "contributor",
  "first-time-contributor",
  "first-timer",
  "mannequin",
  "member",
  "none",
  "owner"
]);

/** Deterministic authority ceiling for admitting one external-PR repair proposal. */
export const factoryExternalPullRequestRepairAdmissionPolicySchema = z
  .object({
    schemaVersion: z.literal("agentlab.external-pull-request-repair-admission-policy.v1"),
    id: z.literal("agentlab/external-pull-request-repair-admission"),
    version: factorySemanticVersionSchema,
    repositoryId: repositoryIdSchema,
    reviewPolicyDigest: sha256DigestSchema,
    feedbackPolicyDigest: sha256DigestSchema,
    repairExecutionPolicyDigest: sha256DigestSchema,
    costPolicyDigest: sha256DigestSchema,
    roleIdentityPolicyDigest: sha256DigestSchema,
    gateProfileDigest: sha256DigestSchema,
    skillPackageDigests: z.array(sha256DigestSchema).min(1).max(16),
    allowedAuthorAssociations: z.array(authorAssociationSchema).min(1).max(8),
    allowForks: z.boolean(),
    minimumFindingSeverity: z.enum(["medium", "high", "critical"]),
    maximumFindings: z.number().int().min(1).max(64),
    maximumChangedFiles: z.number().int().min(1).max(99),
    maximumChangedLines: z.number().int().min(1).max(20_000),
    maximumReviewAgeHours: z.number().int().min(1).max(168),
    authorizationTtlSeconds: z.number().int().min(60).max(86_400),
    maximumCandidatesPerTick: z.number().int().min(1).max(10),
    maximumRiskTier: z.literal("R1")
  })
  .strict()
  .superRefine((policy, context) => {
    for (const [path, values] of [
      ["skillPackageDigests", policy.skillPackageDigests],
      ["allowedAuthorAssociations", policy.allowedAuthorAssociations]
    ] as const) {
      if (new Set(values).size !== values.length) {
        context.addIssue({ code: "custom", path: [path], message: `${path} must be unique.` });
      }
    }
  });
export type FactoryExternalPullRequestRepairAdmissionPolicy = z.infer<
  typeof factoryExternalPullRequestRepairAdmissionPolicySchema
>;

export const factoryExternalPullRequestRepairFindingSelectorSchema = z
  .object({
    reviewerId: factoryIdentifierSchema,
    findingId: factoryIdentifierSchema,
    severity: z.enum(["medium", "high", "critical"])
  })
  .strict();
export type FactoryExternalPullRequestRepairFindingSelector = z.infer<
  typeof factoryExternalPullRequestRepairFindingSelectorSchema
>;

/**
 * Immutable permission for one credentialless repair proposal. Review text is deliberately absent;
 * the worker must resolve selected IDs from the exact embedded evidence and treat it as untrusted.
 */
export const factoryExternalPullRequestRepairAuthorizationSchema = z
  .object({
    schemaVersion: z.literal("agentlab.external-pull-request-repair-authorization.v1"),
    authorizationId: z.uuid(),
    repositoryId: repositoryIdSchema,
    pullRequestNumber: z.number().int().positive(),
    reviewRunId: z.uuid(),
    reviewRunDigest: sha256DigestSchema,
    bundleDigest: sha256DigestSchema,
    feedbackPublicationRunId: z.uuid(),
    feedbackPublicationRunDigest: sha256DigestSchema,
    feedbackRecordDigest: sha256DigestSchema,
    reviewPolicyDigest: sha256DigestSchema,
    feedbackPolicyDigest: sha256DigestSchema,
    admissionPolicyDigest: sha256DigestSchema,
    repairExecutionPolicyDigest: sha256DigestSchema,
    costPolicyDigest: sha256DigestSchema,
    roleIdentityPolicyDigest: sha256DigestSchema,
    gateProfileDigest: sha256DigestSchema,
    skillPackageDigests: z.array(sha256DigestSchema).min(1).max(16),
    expectedBaseRevision: gitObjectIdSchema,
    expectedHeadRevision: gitObjectIdSchema,
    patchDigest: sha256DigestSchema,
    fromFork: z.boolean(),
    headRepositoryId: repositoryIdSchema.nullable(),
    headBranchName: z.string().trim().min(1).max(255),
    selectedFindings: z.array(factoryExternalPullRequestRepairFindingSelectorSchema).min(1).max(64),
    repairAttempt: z.literal(1),
    publicationMode: z.literal("replacement-draft"),
    remoteWrite: z.literal(false),
    autoMerge: z.literal(false),
    release: z.literal(false),
    createdAt: factoryTimestampSchema,
    expiresAt: factoryTimestampSchema,
    actor: factoryActorSchema,
    correlationId: z.uuid()
  })
  .strict()
  .superRefine((authorization, context) => {
    if (
      authorization.headRepositoryId !== null &&
      authorization.fromFork !== (authorization.headRepositoryId !== authorization.repositoryId)
    ) {
      context.addIssue({ code: "custom", message: "External repair fork identity differs." });
    }
    if (authorization.expiresAt <= authorization.createdAt) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "External repair authorization must expire after creation."
      });
    }
    if (
      new Set(authorization.skillPackageDigests).size !== authorization.skillPackageDigests.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["skillPackageDigests"],
        message: "External repair skill digests must be unique."
      });
    }
    const selectors = authorization.selectedFindings.map(
      ({ reviewerId, findingId }) => `${reviewerId}\0${findingId}`
    );
    if (new Set(selectors).size !== selectors.length) {
      context.addIssue({
        code: "custom",
        path: ["selectedFindings"],
        message: "External repair finding selectors must be unique."
      });
    }
    if (
      authorization.actor.kind !== "control-plane" ||
      authorization.actor.role !== "policy-engine" ||
      authorization.actor.id !== "agentlab/external-pull-request-repair-admission" ||
      authorization.actor.sessionId !== authorization.authorizationId
    ) {
      context.addIssue({
        code: "custom",
        path: ["actor"],
        message: "External repair authorization requires the deterministic admission actor."
      });
    }
  });
export type FactoryExternalPullRequestRepairAuthorization = z.infer<
  typeof factoryExternalPullRequestRepairAuthorizationSchema
>;

/** One atomic, immutable admission decision, including denials. */
export const factoryExternalPullRequestRepairDecisionSchema = z
  .object({
    schemaVersion: z.literal("agentlab.external-pull-request-repair-decision.v1"),
    decisionId: z.uuid(),
    repositoryId: repositoryIdSchema,
    pullRequestNumber: z.number().int().positive(),
    reviewRunId: z.uuid(),
    reviewRunDigest: sha256DigestSchema,
    bundleDigest: sha256DigestSchema,
    feedbackPublicationRunId: z.uuid(),
    feedbackPublicationRunDigest: sha256DigestSchema,
    feedbackRecordDigest: sha256DigestSchema,
    admissionPolicyDigest: sha256DigestSchema,
    status: z.enum(["authorized", "denied"]),
    reasonCodes: z.array(factoryIdentifierSchema).min(1).max(16),
    authorizationDigest: sha256DigestSchema.nullable(),
    selectedFindingCount: z.number().int().min(0).max(64),
    createdAt: factoryTimestampSchema,
    actor: factoryActorSchema,
    correlationId: z.uuid()
  })
  .strict()
  .superRefine((decision, context) => {
    if (new Set(decision.reasonCodes).size !== decision.reasonCodes.length) {
      context.addIssue({
        code: "custom",
        path: ["reasonCodes"],
        message: "External repair decision reasons must be unique."
      });
    }
    if (
      (decision.status === "authorized") !== (decision.authorizationDigest !== null) ||
      (decision.status === "authorized") !== decision.selectedFindingCount > 0
    ) {
      context.addIssue({
        code: "custom",
        message: "External repair decision status and authorization fields differ."
      });
    }
    if (
      decision.actor.kind !== "control-plane" ||
      decision.actor.role !== "policy-engine" ||
      decision.actor.id !== "agentlab/external-pull-request-repair-admission" ||
      decision.actor.sessionId !== decision.decisionId
    ) {
      context.addIssue({
        code: "custom",
        path: ["actor"],
        message: "External repair decision requires the deterministic admission actor."
      });
    }
  });
export type FactoryExternalPullRequestRepairDecision = z.infer<
  typeof factoryExternalPullRequestRepairDecisionSchema
>;
