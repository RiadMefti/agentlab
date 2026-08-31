import { z } from "zod";

import {
  factoryActorSchema,
  factoryIdentifierSchema,
  factoryPullRequestProposalSchema,
  factoryPullRequestRecordSchema,
  factoryTimestampSchema,
  sha256DigestSchema
} from "./factory.js";

export const factoryPullRequestDispatchStateSchema = z.enum([
  "ready",
  "dispatch-active",
  "remote-open",
  "evidence-recorded",
  "completed"
]);
export type FactoryPullRequestDispatchState = z.infer<typeof factoryPullRequestDispatchStateSchema>;

export const factoryPullRequestDispatchRunSchema = z
  .object({
    schemaVersion: z.literal("agentlab.pull-request-dispatch.v1"),
    dispatchId: z.uuid(),
    taskId: z.uuid(),
    contractDigest: sha256DigestSchema,
    proposalDigest: sha256DigestSchema,
    proposal: factoryPullRequestProposalSchema,
    brokerId: factoryIdentifierSchema,
    createdAt: factoryTimestampSchema,
    correlationId: z.uuid()
  })
  .strict()
  .superRefine((run, context) => {
    if (
      run.proposal.taskId !== run.taskId ||
      run.proposal.contractDigest !== run.contractDigest ||
      run.proposal.createdAt !== run.createdAt
    ) {
      context.addIssue({
        code: "custom",
        path: ["proposal"],
        message: "Dispatch proposal must match its immutable run identity and creation time."
      });
    }
  });
export type FactoryPullRequestDispatchRun = z.infer<typeof factoryPullRequestDispatchRunSchema>;

const summarySchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((value) => !hasAsciiControl(value), "Summary contains a control character.");

const commonEventShape = {
  schemaVersion: z.literal("agentlab.pull-request-dispatch-event.v1"),
  eventId: z.uuid(),
  dispatchId: z.uuid(),
  dispatchDigest: sha256DigestSchema,
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
      kind: z.literal("dispatch-started"),
      from: z.literal("ready"),
      to: z.literal("dispatch-active")
    })
    .strict(),
  z
    .object({
      ...commonEventShape,
      kind: z.literal("remote-observed"),
      from: z.literal("dispatch-active"),
      to: z.literal("remote-open"),
      record: factoryPullRequestRecordSchema,
      created: z.boolean()
    })
    .strict(),
  z
    .object({
      ...commonEventShape,
      kind: z.literal("evidence-recorded"),
      from: z.literal("remote-open"),
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

export const factoryPullRequestDispatchEventSchema = eventUnionSchema.superRefine(
  (event, context) => {
    if (
      event.kind === "registered" &&
      (event.sequence !== 1 || event.previousEventDigest !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["sequence"],
        message: "Only the first dispatch event may register a run."
      });
    }
    if (
      event.kind !== "registered" &&
      (event.sequence === 1 || event.previousEventDigest === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["previousEventDigest"],
        message: "Every later dispatch event must link to its predecessor."
      });
    }
  }
);
export type FactoryPullRequestDispatchEvent = z.infer<typeof factoryPullRequestDispatchEventSchema>;

function hasAsciiControl(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}
