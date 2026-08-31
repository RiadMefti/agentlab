import { z } from "zod";

import {
  factoryActorSchema,
  factoryExecutionRoleSchema,
  factoryIdentifierSchema,
  factoryTimestampSchema,
  gitObjectIdSchema,
  sha256DigestSchema
} from "./factory.js";

const repositoryIdentitySchema = z
  .object({
    id: factoryIdentifierSchema,
    baseRevision: gitObjectIdSchema
  })
  .strict();

export const factoryExecutionJournalStateSchema = z.enum([
  "ready",
  "workspace-active",
  "operation-active",
  "completed",
  "abandoned"
]);
export type FactoryExecutionJournalState = z.infer<typeof factoryExecutionJournalStateSchema>;

export const factoryExecutionRunSchema = z
  .object({
    schemaVersion: z.literal("agentlab.execution-run.v1"),
    runId: z.uuid(),
    taskId: z.uuid(),
    contractDigest: sha256DigestSchema,
    repository: repositoryIdentitySchema,
    maximumAttempts: z.number().int().min(1).max(20),
    createdAt: factoryTimestampSchema,
    correlationId: z.uuid()
  })
  .strict();
export type FactoryExecutionRun = z.infer<typeof factoryExecutionRunSchema>;

const requestSummarySchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((value) => !hasAsciiControl(value), "Summary contains a control character.");

const executionEventCommonShape = {
  schemaVersion: z.literal("agentlab.execution-event.v1"),
  eventId: z.uuid(),
  runId: z.uuid(),
  runDigest: sha256DigestSchema,
  taskId: z.uuid(),
  contractDigest: sha256DigestSchema,
  sequence: z.number().int().min(1).max(10_000),
  previousEventDigest: sha256DigestSchema.nullable(),
  actor: factoryActorSchema,
  occurredAt: factoryTimestampSchema,
  reasonCode: factoryIdentifierSchema,
  summary: requestSummarySchema.nullable(),
  correlationId: z.uuid()
} as const;

const attemptCoordinatesShape = {
  attempt: z.number().int().min(1).max(20),
  workspaceId: z.uuid()
} as const;

const agentOperationShape = {
  operationKind: z.literal("agent"),
  operationId: z.uuid(),
  role: factoryExecutionRoleSchema,
  gateId: z.null(),
  requestDigest: sha256DigestSchema
} as const;

const gateOperationShape = {
  operationKind: z.literal("gate"),
  operationId: z.uuid(),
  role: z.null(),
  gateId: factoryIdentifierSchema,
  requestDigest: z.null()
} as const;

const operationResultSchema = z.enum(["succeeded", "failed", "timed-out", "error"]);

const executionEventUnionSchema = z.union([
  z
    .object({
      ...executionEventCommonShape,
      kind: z.literal("registered"),
      from: z.null(),
      to: z.literal("ready")
    })
    .strict(),
  z
    .object({
      ...executionEventCommonShape,
      ...attemptCoordinatesShape,
      kind: z.literal("attempt-started"),
      from: z.literal("ready"),
      to: z.literal("workspace-active")
    })
    .strict(),
  z
    .object({
      ...executionEventCommonShape,
      ...attemptCoordinatesShape,
      ...agentOperationShape,
      kind: z.literal("operation-started"),
      from: z.literal("workspace-active"),
      to: z.literal("operation-active")
    })
    .strict(),
  z
    .object({
      ...executionEventCommonShape,
      ...attemptCoordinatesShape,
      ...gateOperationShape,
      kind: z.literal("operation-started"),
      from: z.literal("workspace-active"),
      to: z.literal("operation-active")
    })
    .strict(),
  z
    .object({
      ...executionEventCommonShape,
      ...attemptCoordinatesShape,
      ...agentOperationShape,
      kind: z.literal("operation-finished"),
      from: z.literal("operation-active"),
      to: z.literal("workspace-active"),
      result: operationResultSchema,
      recordDigest: sha256DigestSchema
    })
    .strict(),
  z
    .object({
      ...executionEventCommonShape,
      ...attemptCoordinatesShape,
      ...gateOperationShape,
      kind: z.literal("operation-finished"),
      from: z.literal("operation-active"),
      to: z.literal("workspace-active"),
      result: operationResultSchema,
      recordDigest: sha256DigestSchema
    })
    .strict(),
  z
    .object({
      ...executionEventCommonShape,
      ...attemptCoordinatesShape,
      kind: z.literal("attempt-closed"),
      from: z.literal("workspace-active"),
      to: z.literal("ready"),
      disposition: z.enum(["continue", "finish"])
    })
    .strict(),
  z
    .object({
      ...executionEventCommonShape,
      kind: z.literal("execution-finished"),
      from: z.literal("ready"),
      to: z.literal("completed"),
      taskState: z.enum(["pr-proposed", "needs-attention", "failed", "quarantined"])
    })
    .strict(),
  z
    .object({
      ...executionEventCommonShape,
      kind: z.literal("execution-abandoned"),
      from: z.enum(["ready", "workspace-active", "operation-active"]),
      to: z.literal("abandoned"),
      attempt: z.number().int().min(1).max(20).nullable(),
      workspaceId: z.uuid().nullable(),
      operationId: z.uuid().nullable()
    })
    .strict()
]);

export const factoryExecutionEventSchema = executionEventUnionSchema.superRefine(
  (event, context) => {
    if (
      event.kind === "registered" &&
      (event.sequence !== 1 || event.previousEventDigest !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["sequence"],
        message: "Only the first execution event may register a run."
      });
    }
    if (
      event.kind !== "registered" &&
      (event.sequence === 1 || event.previousEventDigest === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["previousEventDigest"],
        message: "Every later execution event must link to its predecessor."
      });
    }
    if (event.kind === "execution-abandoned") {
      const hasAttempt = event.attempt !== null && event.workspaceId !== null;
      const hasOperation = event.operationId !== null;
      const valid =
        (event.from === "ready" && !hasAttempt && !hasOperation) ||
        (event.from === "workspace-active" && hasAttempt && !hasOperation) ||
        (event.from === "operation-active" && hasAttempt && hasOperation);
      if (!valid) {
        context.addIssue({
          code: "custom",
          path: ["from"],
          message: "Abandonment coordinates must identify exactly the active durable resource."
        });
      }
    }
  }
);
export type FactoryExecutionEvent = z.infer<typeof factoryExecutionEventSchema>;

function hasAsciiControl(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) return true;
  }
  return false;
}
