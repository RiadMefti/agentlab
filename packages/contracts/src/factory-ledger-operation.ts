import { z } from "zod";

import {
  factoryAgentRunRequestSchema,
  factoryAgentRunStatusSchema,
  factoryBudgetUsageSchema,
  factoryChangeSetSchema,
  factoryIdentifierSchema,
  factoryProcessIsolationSchema,
  factoryResourceLimitsSchema,
  factoryTimestampSchema,
  gitObjectIdSchema,
  sha256DigestSchema
} from "./factory.js";
import {
  factoryLedgerArtifactExecutionSchema,
  maximumLedgerArtifactBytes
} from "./factory-ledger-artifacts.js";

export const factoryLedgerOperationPrincipalSchema = z.strictObject({
  uid: z.number().int().min(1).max(0xffff_fffe),
  id: factoryIdentifierSchema,
  kind: z.enum(["implementer", "reviewer", "gate-observer"])
});
export const factoryLedgerOperationPatchSchema = z.strictObject({
  patch: z.string().max(maximumLedgerArtifactBytes),
  changeSet: factoryChangeSetSchema
});
export const factoryLedgerOperationLimitsSchema = z.strictObject({
  maximumChangedFiles: z.number().int().min(0).max(10_000),
  maximumChangedLines: z.number().int().min(0).max(1_000_000),
  maximumPatchBytes: z.number().int().min(1).max(maximumLedgerArtifactBytes),
  maximumResultBytes: z.number().int().min(1).max(maximumLedgerArtifactBytes),
  maximumRunSeconds: z.number().int().min(1).max(3600),
  cleanupReserveSeconds: z.number().int().min(30).max(300)
});
const operationIdentity = {
  schemaVersion: z.literal("agentlab.ledger-operation.v1"),
  jobId: z.uuid(),
  taskId: z.uuid(),
  contractDigest: sha256DigestSchema,
  expectedTaskEventDigest: sha256DigestSchema,
  execution: factoryLedgerArtifactExecutionSchema,
  attempt: z.number().int().min(1).max(20),
  logicalWorkspaceId: z.uuid(),
  principal: factoryLedgerOperationPrincipalSchema,
  workerPolicyDigest: sha256DigestSchema,
  factoryPolicyDigest: sha256DigestSchema,
  repository: z.strictObject({ id: factoryIdentifierSchema, baseRevision: gitObjectIdSchema }),
  createdAt: factoryTimestampSchema,
  expiresAt: factoryTimestampSchema,
  resourceLimits: factoryResourceLimitsSchema,
  limits: factoryLedgerOperationLimitsSchema,
  seedPatch: factoryLedgerOperationPatchSchema.nullable()
};

/** The job names installed capabilities, never a caller-selected executable or storage path. */
export const factoryLedgerOperationSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      ...operationIdentity,
      kind: z.literal("agent"),
      request: factoryAgentRunRequestSchema,
      prompt: z.string().max(maximumLedgerArtifactBytes),
      providerVersion: z.string().trim().min(1).max(180)
    }),
    z.strictObject({
      ...operationIdentity,
      kind: z.literal("gate"),
      gateId: factoryIdentifierSchema
    })
  ])
  .superRefine((job, context) => {
    const badAgent =
      job.kind === "agent" &&
      (job.request.executionId !== job.jobId ||
        job.request.taskId !== job.taskId ||
        job.request.contractDigest !== job.contractDigest ||
        job.request.attempt !== job.attempt ||
        job.request.repository.id !== job.repository.id ||
        job.request.repository.baseRevision !== job.repository.baseRevision ||
        job.request.budget.wallClockSeconds > job.limits.maximumRunSeconds ||
        (job.request.role === "reviewer"
          ? job.principal.kind !== "reviewer"
          : job.principal.kind !== "implementer"));
    if (
      job.createdAt >= job.expiresAt ||
      badAgent ||
      (job.kind === "gate" && job.principal.kind !== "gate-observer") ||
      (job.seedPatch !== null &&
        job.seedPatch.changeSet.baseRevision !== job.repository.baseRevision)
    ) {
      context.addIssue({
        code: "custom",
        message: "Operation identity, role, budget or seed base is inconsistent."
      });
    }
  });
export type FactoryLedgerOperation = z.infer<typeof factoryLedgerOperationSchema>;

const outputText = z.string().max(maximumLedgerArtifactBytes);
export const factoryLedgerAgentOutputSchema = z
  .strictObject({
    status: factoryAgentRunStatusSchema,
    exitCode: z.number().int().min(0).max(255).nullable(),
    stdout: outputText,
    stderr: outputText,
    finalOutput: outputText.nullable(),
    providerSessionId: z.string().trim().min(1).max(256).nullable(),
    providerVersion: z.string().trim().min(1).max(180),
    harnessVersion: z.string().trim().min(1).max(180),
    startedAt: factoryTimestampSchema,
    finishedAt: factoryTimestampSchema,
    usage: factoryBudgetUsageSchema,
    usageComplete: z.boolean(),
    errorCode: factoryIdentifierSchema.nullable(),
    isolation: factoryProcessIsolationSchema
  })
  .superRefine((output, context) => {
    if (
      output.finishedAt < output.startedAt ||
      (output.status === "succeeded"
        ? output.exitCode !== 0 || output.errorCode !== null
        : output.errorCode === null)
    )
      context.addIssue({ code: "custom", message: "Agent outcome is internally inconsistent." });
  });
const commandText = z
  .string()
  .max(4096)
  .refine((value) => !value.includes("\0"));
export const factoryLedgerGateOutputSchema = z
  .strictObject({
    gateId: factoryIdentifierSchema,
    evidenceKind: z.enum(["test", "build", "security", "provenance"]),
    command: z.strictObject({
      executable: commandText.min(1),
      args: z.array(commandText).max(256),
      environment: z.record(z.string().min(1).max(128), commandText).optional()
    }),
    result: z.enum(["pass", "fail", "error", "timed-out"]),
    exitCode: z.number().int().min(0).max(255).nullable(),
    startedAt: factoryTimestampSchema,
    finishedAt: factoryTimestampSchema,
    wallClockSeconds: z.number().int().min(0).max(86400),
    outputBytes: z.number().int().min(0).max(maximumLedgerArtifactBytes),
    stdout: outputText,
    stderr: outputText,
    isolation: factoryProcessIsolationSchema
  })
  .superRefine((output, context) => {
    if (output.finishedAt < output.startedAt || (output.result === "pass" && output.exitCode !== 0))
      context.addIssue({ code: "custom", message: "Gate outcome is internally inconsistent." });
  });
const resultIdentity = {
  schemaVersion: z.literal("agentlab.ledger-operation-result.v1"),
  jobId: z.uuid(),
  jobDigest: sha256DigestSchema,
  patch: factoryLedgerOperationPatchSchema,
  workspace: z.literal("closed"),
  completedAt: factoryTimestampSchema
};
/** An executor report is still a claim; the authenticated ledger decides its evidentiary meaning. */
export const factoryLedgerOperationResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...resultIdentity,
    kind: z.literal("agent"),
    output: factoryLedgerAgentOutputSchema
  }),
  z.strictObject({
    ...resultIdentity,
    kind: z.literal("gate"),
    output: factoryLedgerGateOutputSchema
  })
]);
export type FactoryLedgerOperationResult = z.infer<typeof factoryLedgerOperationResultSchema>;
