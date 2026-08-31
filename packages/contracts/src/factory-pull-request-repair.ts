import { z } from "zod";

import {
  factoryIdentifierSchema,
  factoryTimestampSchema,
  gitObjectIdSchema,
  sha256DigestSchema
} from "./factory.js";

const externalIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine((value) => !hasAsciiControl(value), "External ID contains a control character.");

const checkNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .refine((value) => !hasAsciiControl(value), "Check name contains a control character.");

const failedCheckSchema = z
  .object({
    name: checkNameSchema,
    producerId: factoryIdentifierSchema,
    runId: externalIdSchema,
    conclusion: z.enum([
      "failure",
      "cancelled",
      "timed-out",
      "action-required",
      "stale",
      "startup-failure"
    ])
  })
  .strict();

/**
 * Immutable permission for one post-PR repair. It selects remote facts by ID and deliberately
 * excludes every untrusted feedback body; the worker must resolve those IDs from the exact
 * observed artifact and continue to enforce the original task contract.
 */
export const factoryPullRequestRepairAuthorizationSchema = z
  .object({
    schemaVersion: z.literal("agentlab.pull-request-repair-authorization.v1"),
    authorizationId: z.uuid(),
    taskId: z.uuid(),
    contractDigest: sha256DigestSchema,
    policyBundleDigest: sha256DigestSchema,
    proposalDigest: sha256DigestSchema,
    priorPatchProposalDigest: sha256DigestSchema,
    pullRequestRecordDigest: sha256DigestSchema,
    observationDigest: sha256DigestSchema,
    observationEvidenceBundleDigest: sha256DigestSchema,
    repositoryId: factoryIdentifierSchema,
    pullRequestNumber: z.number().int().positive(),
    headRevision: gitObjectIdSchema,
    brokerId: factoryIdentifierSchema,
    contractRepairAttempt: z.number().int().min(1).max(20),
    reasonCodes: z
      .array(z.enum(["review-changes-requested", "trusted-check-failed"]))
      .min(1)
      .max(2),
    selectedReviewIds: z.array(externalIdSchema).max(99),
    selectedReviewCommentIds: z.array(externalIdSchema).max(99),
    failedChecks: z.array(failedCheckSchema).max(32),
    createdAt: factoryTimestampSchema,
    expiresAt: factoryTimestampSchema,
    correlationId: z.uuid()
  })
  .strict()
  .superRefine((authorization, context) => {
    for (const [path, values] of [
      ["reasonCodes", authorization.reasonCodes],
      ["selectedReviewIds", authorization.selectedReviewIds],
      ["selectedReviewCommentIds", authorization.selectedReviewCommentIds],
      [
        "failedChecks",
        authorization.failedChecks.map(
          (check) => `${check.name}\0${check.producerId}\0${check.runId}`
        )
      ]
    ] as const) {
      if (new Set(values).size !== values.length) {
        context.addIssue({ code: "custom", path: [path], message: `${path} must be unique.` });
      }
    }
    if (authorization.expiresAt <= authorization.createdAt) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Repair authorization must expire after it is created."
      });
    }
    const hasReviewReason = authorization.reasonCodes.includes("review-changes-requested");
    const hasCheckReason = authorization.reasonCodes.includes("trusted-check-failed");
    if (hasReviewReason !== authorization.selectedReviewIds.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["selectedReviewIds"],
        message: "Selected reviews must exactly justify the review reason."
      });
    }
    if (hasCheckReason !== authorization.failedChecks.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["failedChecks"],
        message: "Failed checks must exactly justify the trusted-check reason."
      });
    }
    if (
      authorization.selectedReviewCommentIds.length > 0 &&
      authorization.selectedReviewIds.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["selectedReviewCommentIds"],
        message: "Review comments require a selected formal review."
      });
    }
  });

export type FactoryPullRequestRepairAuthorization = z.infer<
  typeof factoryPullRequestRepairAuthorizationSchema
>;

/**
 * Immutable header for one credentialless post-PR repair execution. The authorization digest is
 * the capability being consumed; all other coordinates make that transitive binding inspectable
 * without reopening mutable task or remote state.
 */
export const factoryPullRequestRepairRunSchema = z
  .object({
    schemaVersion: z.literal("agentlab.pull-request-repair-run.v1"),
    runId: z.uuid(),
    taskId: z.uuid(),
    contractDigest: sha256DigestSchema,
    policyBundleDigest: sha256DigestSchema,
    authorizationId: z.uuid(),
    authorizationDigest: sha256DigestSchema,
    observationDigest: sha256DigestSchema,
    priorPatchProposalDigest: sha256DigestSchema,
    repository: z
      .object({
        id: factoryIdentifierSchema,
        baseRevision: gitObjectIdSchema
      })
      .strict(),
    contractRepairAttempt: z.number().int().min(1).max(20),
    maximumAttempts: z.number().int().min(1).max(20),
    createdAt: factoryTimestampSchema,
    correlationId: z.uuid()
  })
  .strict()
  .superRefine((run, context) => {
    if (run.maximumAttempts !== run.contractRepairAttempt) {
      context.addIssue({
        code: "custom",
        path: ["maximumAttempts"],
        message: "A PR repair run may consume only its exact contract repair attempt."
      });
    }
  });

export type FactoryPullRequestRepairRun = z.infer<typeof factoryPullRequestRepairRunSchema>;

function hasAsciiControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}
