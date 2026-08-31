import { z } from "zod";

import {
  factoryActorSchema,
  factoryBudgetSchema,
  factoryBudgetUsageSchema,
  factoryIdentifierSchema,
  factorySemanticVersionSchema,
  factoryTaskStateSchema,
  factoryTimestampSchema,
  sha256DigestSchema
} from "./factory.js";
import { factoryPreparationStateSchema } from "./factory-preparation.js";

const utcTimeSchema = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/u, "Expected a UTC time in HH:MM format.");

/** Repository-owned limits for one idempotent daily autonomous worker tick. */
export const factorySchedulePolicySchema = z
  .object({
    schemaVersion: z.literal("agentlab.schedule-policy.v1"),
    id: z.literal("agentlab/daily-maintenance"),
    version: factorySemanticVersionSchema,
    cadence: z
      .object({
        kind: z.literal("daily"),
        timeZone: z.literal("UTC"),
        at: utcTimeSchema,
        startDeadlineSeconds: z.number().int().min(60).max(86_400)
      })
      .strict(),
    maximumTasksPerTick: z.number().int().min(1).max(32),
    maximumCandidatesPerTick: z.number().int().min(1).max(100),
    tickBudget: factoryBudgetSchema
  })
  .strict()
  .superRefine((policy, context) => {
    if (policy.maximumCandidatesPerTick < policy.maximumTasksPerTick) {
      context.addIssue({
        code: "custom",
        path: ["maximumCandidatesPerTick"],
        message: "Candidate limit must be at least the task limit."
      });
    }
  });
export type FactorySchedulePolicy = z.infer<typeof factorySchedulePolicySchema>;

export const factoryScheduleRunStateSchema = z.enum(["ready", "task-active", "completed"]);
export type FactoryScheduleRunState = z.infer<typeof factoryScheduleRunStateSchema>;

/** Immutable identity for one exact daily slot under one schedule and factory policy. */
export const factoryScheduleRunSchema = z
  .object({
    schemaVersion: z.literal("agentlab.schedule-run.v1"),
    runId: z.uuid(),
    schedulePolicyDigest: sha256DigestSchema,
    schedulePolicy: factorySchedulePolicySchema,
    factoryPolicyBundleDigest: sha256DigestSchema,
    scheduledFor: factoryTimestampSchema,
    deadlineAt: factoryTimestampSchema,
    createdAt: factoryTimestampSchema,
    correlationId: z.uuid()
  })
  .strict()
  .superRefine((run, context) => {
    if (run.deadlineAt <= run.scheduledFor) {
      context.addIssue({
        code: "custom",
        path: ["deadlineAt"],
        message: "Schedule deadline must follow its slot."
      });
    }
    if (run.createdAt < run.scheduledFor || run.createdAt > run.deadlineAt) {
      context.addIssue({
        code: "custom",
        path: ["createdAt"],
        message: "Schedule run must start inside its admitted slot window."
      });
    }
  });
export type FactoryScheduleRun = z.infer<typeof factoryScheduleRunSchema>;

const commonEventShape = {
  schemaVersion: z.literal("agentlab.schedule-event.v1"),
  eventId: z.uuid(),
  runId: z.uuid(),
  runDigest: sha256DigestSchema,
  sequence: z.number().int().min(1).max(1_000),
  previousEventDigest: sha256DigestSchema.nullable(),
  actor: factoryActorSchema,
  occurredAt: factoryTimestampSchema,
  reasonCode: factoryIdentifierSchema,
  correlationId: z.uuid()
} as const;

const taskIdentityShape = {
  taskId: z.uuid(),
  requestDigest: sha256DigestSchema,
  authorityDigest: sha256DigestSchema
} as const;

const workerResultSchema = z.enum(["ready-for-broker", "already-advanced", "stopped"]);
export type FactoryScheduledWorkerResult = z.infer<typeof workerResultSchema>;

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
      ...taskIdentityShape,
      kind: z.literal("task-claimed"),
      from: z.literal("ready"),
      to: z.literal("task-active"),
      taskCorrelationId: z.uuid(),
      reservation: factoryBudgetSchema
    })
    .strict(),
  z
    .object({
      ...commonEventShape,
      kind: z.literal("task-finished"),
      from: z.literal("task-active"),
      to: z.literal("ready"),
      taskId: z.uuid(),
      taskCorrelationId: z.uuid(),
      result: workerResultSchema,
      preparationState: factoryPreparationStateSchema,
      taskState: factoryTaskStateSchema.nullable(),
      contractDigest: sha256DigestSchema.nullable(),
      reasonCodes: z.array(factoryIdentifierSchema).max(32)
    })
    .strict(),
  z
    .object({
      ...commonEventShape,
      ...taskIdentityShape,
      kind: z.literal("task-skipped"),
      from: z.literal("ready"),
      to: z.literal("ready"),
      skipReason: factoryIdentifierSchema
    })
    .strict(),
  z
    .object({
      ...commonEventShape,
      kind: z.literal("completed"),
      from: z.literal("ready"),
      to: z.literal("completed"),
      tasksClaimed: z.number().int().min(0).max(32),
      tasksFinished: z.number().int().min(0).max(32),
      tasksSkipped: z.number().int().min(0).max(100),
      reservedUsage: factoryBudgetUsageSchema
    })
    .strict()
]);

/** Append-only scheduler trace; task claims are durable before model work starts. */
export const factoryScheduleEventSchema = eventUnionSchema.superRefine((event, context) => {
  if (event.kind === "registered" && (event.sequence !== 1 || event.previousEventDigest !== null)) {
    context.addIssue({
      code: "custom",
      path: ["sequence"],
      message: "Only the first schedule event may register a run."
    });
  }
  if (event.kind !== "registered" && (event.sequence === 1 || event.previousEventDigest === null)) {
    context.addIssue({
      code: "custom",
      path: ["previousEventDigest"],
      message: "Every later schedule event must link to its predecessor."
    });
  }
});
export type FactoryScheduleEvent = z.infer<typeof factoryScheduleEventSchema>;
