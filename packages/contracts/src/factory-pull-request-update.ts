import { z } from "zod";

import {
  factoryActorSchema,
  factoryChangeSetSchema,
  factoryIdentifierSchema,
  factoryPullRequestRecordSchema,
  factoryTimestampSchema,
  gitObjectIdSchema,
  sha256DigestSchema
} from "./factory.js";

const boundedUrlSchema = z.url().max(2_048);

/** Immutable authorization for one non-force update of an existing brokered draft branch. */
export const factoryPullRequestUpdateProposalSchema = z
  .object({
    schemaVersion: z.literal("agentlab.pull-request-update-proposal.v1"),
    taskId: z.uuid(),
    contractDigest: sha256DigestSchema,
    policyBundleDigest: sha256DigestSchema,
    initialProposalDigest: sha256DigestSchema,
    priorPullRequestRecordDigest: sha256DigestSchema,
    repairAuthorizationDigest: sha256DigestSchema,
    repairRunDigest: sha256DigestSchema,
    repairedPatchProposalDigest: sha256DigestSchema,
    repairedPatchArtifactDigest: sha256DigestSchema,
    policyEvaluationDigest: sha256DigestSchema,
    changeSet: factoryChangeSetSchema,
    repositoryId: factoryIdentifierSchema,
    baseRevision: gitObjectIdSchema,
    baseBranch: factoryIdentifierSchema,
    branchName: factoryIdentifierSchema,
    pullRequestNumber: z.number().int().positive(),
    priorHeadRevision: gitObjectIdSchema,
    brokerId: factoryIdentifierSchema,
    contractRepairAttempt: z.number().int().min(1).max(20),
    commitTitle: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .refine((value) => !hasAsciiControl(value), "Update title contains controls."),
    createdAt: factoryTimestampSchema
  })
  .strict()
  .superRefine((proposal, context) => {
    if (proposal.changeSet.baseRevision !== proposal.baseRevision) {
      context.addIssue({
        code: "custom",
        path: ["changeSet", "baseRevision"],
        message: "PR update change set must match its exact contract base."
      });
    }
    if (proposal.priorHeadRevision === proposal.baseRevision) {
      context.addIssue({
        code: "custom",
        path: ["priorHeadRevision"],
        message: "PR update requires an existing non-base branch head."
      });
    }
  });
export type FactoryPullRequestUpdateProposal = z.infer<
  typeof factoryPullRequestUpdateProposalSchema
>;

/** Broker-authenticated current PR coordinates after one exact branch update. */
export const factoryPullRequestUpdateRecordSchema = z
  .object({
    schemaVersion: z.literal("agentlab.pull-request-update-record.v1"),
    taskId: z.uuid(),
    contractDigest: sha256DigestSchema,
    initialProposalDigest: sha256DigestSchema,
    updateProposalDigest: sha256DigestSchema,
    priorPullRequestRecordDigest: sha256DigestSchema,
    repairAuthorizationDigest: sha256DigestSchema,
    repairRunDigest: sha256DigestSchema,
    repairedPatchProposalDigest: sha256DigestSchema,
    repositoryId: factoryIdentifierSchema,
    number: z.number().int().positive(),
    url: boundedUrlSchema,
    baseRevision: gitObjectIdSchema,
    priorHeadRevision: gitObjectIdSchema,
    headRevision: gitObjectIdSchema,
    branchName: factoryIdentifierSchema,
    draft: z.literal(true),
    brokerId: factoryIdentifierSchema,
    contractRepairAttempt: z.number().int().min(1).max(20),
    updatedAt: factoryTimestampSchema
  })
  .strict()
  .superRefine((record, context) => {
    if (record.headRevision === record.priorHeadRevision) {
      context.addIssue({
        code: "custom",
        path: ["headRevision"],
        message: "A PR update must advance the remote head."
      });
    }
  });
export type FactoryPullRequestUpdateRecord = z.infer<typeof factoryPullRequestUpdateRecordSchema>;

export const factoryPullRequestAuthorityRecordSchema = z.union([
  factoryPullRequestRecordSchema,
  factoryPullRequestUpdateRecordSchema
]);
export type FactoryPullRequestAuthorityRecord = z.infer<
  typeof factoryPullRequestAuthorityRecordSchema
>;

export const factoryPullRequestUpdateStateSchema = z.enum([
  "ready",
  "update-active",
  "remote-updated",
  "evidence-recorded",
  "completed"
]);
export type FactoryPullRequestUpdateState = z.infer<typeof factoryPullRequestUpdateStateSchema>;

export const factoryPullRequestUpdateRunSchema = z
  .object({
    schemaVersion: z.literal("agentlab.pull-request-update.v1"),
    updateId: z.uuid(),
    taskId: z.uuid(),
    contractDigest: sha256DigestSchema,
    proposalDigest: sha256DigestSchema,
    proposal: factoryPullRequestUpdateProposalSchema,
    brokerId: factoryIdentifierSchema,
    createdAt: factoryTimestampSchema,
    correlationId: z.uuid()
  })
  .strict()
  .superRefine((run, context) => {
    if (
      run.proposal.taskId !== run.taskId ||
      run.proposal.contractDigest !== run.contractDigest ||
      run.proposal.brokerId !== run.brokerId ||
      run.proposal.createdAt !== run.createdAt
    ) {
      context.addIssue({
        code: "custom",
        path: ["proposal"],
        message: "PR update proposal must match its immutable run identity."
      });
    }
  });
export type FactoryPullRequestUpdateRun = z.infer<typeof factoryPullRequestUpdateRunSchema>;

const summarySchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((value) => !hasAsciiControl(value), "Summary contains a control character.");

const commonEventShape = {
  schemaVersion: z.literal("agentlab.pull-request-update-event.v1"),
  eventId: z.uuid(),
  updateId: z.uuid(),
  updateDigest: sha256DigestSchema,
  taskId: z.uuid(),
  contractDigest: sha256DigestSchema,
  sequence: z.number().int().min(1).max(5),
  previousEventDigest: sha256DigestSchema.nullable(),
  actor: factoryActorSchema,
  occurredAt: factoryTimestampSchema,
  reasonCode: factoryIdentifierSchema,
  summary: summarySchema.nullable(),
  correlationId: z.uuid()
} as const;

const eventUnionSchema = z.union([
  z
    .object({
      ...commonEventShape,
      kind: z.literal("registered"),
      from: z.null(),
      to: z.literal("ready")
    })
    .strict(),
  z
    .object({
      ...commonEventShape,
      kind: z.literal("update-started"),
      from: z.literal("ready"),
      to: z.literal("update-active")
    })
    .strict(),
  z
    .object({
      ...commonEventShape,
      kind: z.literal("remote-updated"),
      from: z.literal("update-active"),
      to: z.literal("remote-updated"),
      record: factoryPullRequestUpdateRecordSchema,
      updated: z.boolean()
    })
    .strict(),
  z
    .object({
      ...commonEventShape,
      kind: z.literal("evidence-recorded"),
      from: z.literal("remote-updated"),
      to: z.literal("evidence-recorded"),
      evidenceBundleDigest: sha256DigestSchema
    })
    .strict(),
  z
    .object({
      ...commonEventShape,
      kind: z.literal("task-recorded"),
      from: z.literal("evidence-recorded"),
      to: z.literal("completed"),
      taskEventDigest: sha256DigestSchema
    })
    .strict()
]);

export const factoryPullRequestUpdateEventSchema = eventUnionSchema.superRefine(
  (event, context) => {
    if (
      event.kind === "registered" &&
      (event.sequence !== 1 || event.previousEventDigest !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["sequence"],
        message: "Only the first PR update event may register a run."
      });
    }
    if (
      event.kind !== "registered" &&
      (event.sequence === 1 || event.previousEventDigest === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["previousEventDigest"],
        message: "Every later PR update event must link to its predecessor."
      });
    }
  }
);
export type FactoryPullRequestUpdateEvent = z.infer<typeof factoryPullRequestUpdateEventSchema>;

function hasAsciiControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}
