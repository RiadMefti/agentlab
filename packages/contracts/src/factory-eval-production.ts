import { z } from "zod";

import {
  factoryActorSchema,
  factoryArtifactReferenceSchema,
  factoryBudgetSchema,
  factoryBudgetUsageSchema,
  factoryIdentifierSchema,
  factoryProcessIsolationSchema,
  factoryResourceLimitsSchema,
  factorySemanticVersionSchema,
  factoryTimestampSchema,
  sha256DigestSchema
} from "./factory.js";
import {
  factoryConfigurationCandidateSchema,
  factoryEvalSampleSchema,
  factoryEvalSuiteSchema
} from "./factory-evaluation.js";

const safeTextSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((value) => Array.from(value).every(isSafeTextCharacter));

export const factoryEvalHarnessProtocolVersion = "agentlab.eval-harness-protocol.v1" as const;

/** Content identity of one administrator-installed, offline eval subject harness. */
export const factoryEvalHarnessDescriptorSchema = z
  .object({
    schemaVersion: z.literal("agentlab.eval-harness.v1"),
    id: factoryIdentifierSchema,
    version: factorySemanticVersionSchema,
    executableDigest: sha256DigestSchema,
    protocolVersion: z.literal(factoryEvalHarnessProtocolVersion),
    network: z.literal("off"),
    secrets: z.literal(false)
  })
  .strict();
export type FactoryEvalHarnessDescriptor = z.infer<typeof factoryEvalHarnessDescriptorSchema>;

/** Content identity of one administrator-installed deterministic offline grader. */
export const factoryEvalGraderDescriptorSchema = z
  .object({
    schemaVersion: z.literal("agentlab.eval-grader.v1"),
    id: factoryIdentifierSchema,
    version: factorySemanticVersionSchema,
    executableDigest: sha256DigestSchema,
    protocolVersion: z.literal(factoryEvalHarnessProtocolVersion),
    network: z.literal("off"),
    secrets: z.literal(false)
  })
  .strict();
export type FactoryEvalGraderDescriptor = z.infer<typeof factoryEvalGraderDescriptorSchema>;

const invocationBudgetSchema = factoryBudgetSchema.superRefine((budget, context) => {
  if (
    budget.maxWorkers !== 1 ||
    budget.maxRepairAttempts !== 0 ||
    budget.maxChangedFiles !== 0 ||
    budget.maxChangedLines !== 0
  ) {
    context.addIssue({
      code: "custom",
      message: "Eval invocations must be single-worker, non-repairing, and non-mutating."
    });
  }
});

export const factoryEvalCaseDefinitionSchema = z
  .object({
    caseId: factoryIdentifierSchema,
    fixture: factoryArtifactReferenceSchema,
    seedDigests: z.array(sha256DigestSchema).min(2).max(20),
    subjectBudgetCeiling: invocationBudgetSchema,
    graderBudgetCeiling: invocationBudgetSchema,
    maximumSubjectOutputBytes: z
      .number()
      .int()
      .min(1)
      .max(64 * 1_024 * 1_024),
    maximumTraceBytes: z
      .number()
      .int()
      .min(1)
      .max(64 * 1_024 * 1_024),
    maximumGraderEvidenceBytes: z
      .number()
      .int()
      .min(1)
      .max(64 * 1_024 * 1_024)
  })
  .strict()
  .superRefine((definition, context) => {
    unique(definition.seedDigests, context, ["seedDigests"], "Eval case seed digests");
  });
export type FactoryEvalCaseDefinition = z.infer<typeof factoryEvalCaseDefinitionSchema>;

/** Content-addressed representative cases. Fixtures remain separate immutable artifacts. */
export const factoryEvalCaseBankSchema = z
  .object({
    schemaVersion: z.literal("agentlab.eval-case-bank.v1"),
    id: z.literal("agentlab/software-factory"),
    version: factorySemanticVersionSchema,
    cases: z.array(factoryEvalCaseDefinitionSchema).min(1).max(256)
  })
  .strict()
  .superRefine((bank, context) => {
    unique(
      bank.cases.map(({ caseId }) => caseId),
      context,
      ["cases"],
      "Eval case IDs"
    );
    unique(
      bank.cases.flatMap(({ seedDigests }) => seedDigests),
      context,
      ["cases"],
      "Eval case-bank seeds"
    );
  });
export type FactoryEvalCaseBank = z.infer<typeof factoryEvalCaseBankSchema>;

/** Immutable, authority-free request to produce one complete matched eval run. */
export const factoryEvalProductionJobSchema = z
  .object({
    schemaVersion: z.literal("agentlab.eval-production-job.v1"),
    jobId: z.uuid(),
    runnerId: factoryIdentifierSchema,
    suiteDigest: sha256DigestSchema,
    suite: factoryEvalSuiteSchema,
    caseBankDigest: sha256DigestSchema,
    caseBank: factoryEvalCaseBankSchema,
    baselineCandidateDigest: sha256DigestSchema,
    baselineCandidate: factoryConfigurationCandidateSchema,
    baselineHarnessDigest: sha256DigestSchema,
    baselineHarness: factoryEvalHarnessDescriptorSchema,
    challengerCandidateDigest: sha256DigestSchema,
    challengerCandidate: factoryConfigurationCandidateSchema,
    challengerHarnessDigest: sha256DigestSchema,
    challengerHarness: factoryEvalHarnessDescriptorSchema,
    graderDigest: sha256DigestSchema,
    grader: factoryEvalGraderDescriptorSchema,
    aggregateBudget: factoryBudgetSchema,
    resourceLimits: factoryResourceLimitsSchema,
    createdAt: factoryTimestampSchema,
    deadlineAt: factoryTimestampSchema,
    correlationId: z.uuid()
  })
  .strict()
  .superRefine((job, context) => {
    if (job.deadlineAt <= job.createdAt) {
      context.addIssue({
        code: "custom",
        path: ["deadlineAt"],
        message: "Eval production deadline must follow creation."
      });
    }
    if (job.baselineCandidateDigest === job.challengerCandidateDigest) {
      context.addIssue({
        code: "custom",
        path: ["challengerCandidateDigest"],
        message: "Eval production candidates must differ."
      });
    }
    if (
      job.aggregateBudget.maxWorkers !== 1 ||
      job.aggregateBudget.maxRepairAttempts !== 0 ||
      job.aggregateBudget.maxChangedFiles !== 0 ||
      job.aggregateBudget.maxChangedLines !== 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["aggregateBudget"],
        message: "Eval production must be single-worker, non-repairing, and non-mutating."
      });
    }
  });
export type FactoryEvalProductionJob = z.infer<typeof factoryEvalProductionJobSchema>;

const evalCoordinateShape = {
  caseId: factoryIdentifierSchema,
  trial: z.number().int().min(1).max(20),
  seedDigest: sha256DigestSchema,
  fixture: factoryArtifactReferenceSchema
} as const;

export const factoryEvalSubjectRequestSchema = z
  .object({
    schemaVersion: z.literal("agentlab.eval-subject-request.v1"),
    jobId: z.uuid(),
    jobDigest: sha256DigestSchema,
    executionId: z.uuid(),
    candidateRole: z.enum(["baseline", "challenger"]),
    candidateDigest: sha256DigestSchema,
    candidate: factoryConfigurationCandidateSchema,
    harnessDigest: sha256DigestSchema,
    harness: factoryEvalHarnessDescriptorSchema,
    ...evalCoordinateShape,
    fixturePath: z.literal("/workspace/fixture"),
    outputPath: z.literal("/workspace/output"),
    tracePath: z.literal("/workspace/trace")
  })
  .strict();
export type FactoryEvalSubjectRequest = z.infer<typeof factoryEvalSubjectRequestSchema>;

/** Strict control response; potentially large output and trace bytes are read from fixed files. */
export const factoryEvalSubjectResponseSchema = z
  .object({
    schemaVersion: z.literal("agentlab.eval-subject-response.v1"),
    status: z.enum(["succeeded", "failed"]),
    usage: factoryBudgetUsageSchema,
    usageComplete: z.literal(true),
    reasonCode: factoryIdentifierSchema.nullable()
  })
  .strict()
  .superRefine((response, context) => {
    if ((response.status === "succeeded") !== (response.reasonCode === null)) {
      context.addIssue({
        code: "custom",
        path: ["reasonCode"],
        message: "Only failed eval subjects may include a reason code."
      });
    }
    if (
      response.usage.workers !== 1 ||
      response.usage.repairAttempts !== 0 ||
      response.usage.changedFiles !== 0 ||
      response.usage.changedLines !== 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["usage"],
        message: "Eval subject usage must remain single-worker and non-mutating."
      });
    }
  });
export type FactoryEvalSubjectResponse = z.infer<typeof factoryEvalSubjectResponseSchema>;

const subjectEvidenceReferenceSchema = z
  .object({
    candidateRole: z.enum(["baseline", "challenger"]),
    candidateDigest: sha256DigestSchema,
    harnessDigest: sha256DigestSchema,
    subjectEvidenceDigest: sha256DigestSchema,
    outputArtifact: factoryArtifactReferenceSchema,
    traceArtifact: factoryArtifactReferenceSchema,
    costMicrousd: z.number().int().min(0).max(1_000_000_000_000),
    latencyMilliseconds: z.number().int().min(1).max(86_400_000)
  })
  .strict();

export const factoryEvalGraderRequestSchema = z
  .object({
    schemaVersion: z.literal("agentlab.eval-grader-request.v1"),
    jobId: z.uuid(),
    jobDigest: sha256DigestSchema,
    executionId: z.uuid(),
    graderDigest: sha256DigestSchema,
    grader: factoryEvalGraderDescriptorSchema,
    ...evalCoordinateShape,
    baseline: subjectEvidenceReferenceSchema,
    challenger: subjectEvidenceReferenceSchema,
    fixturePath: z.literal("/workspace/fixture"),
    baselineOutputPath: z.literal("/workspace/baseline-output"),
    baselineTracePath: z.literal("/workspace/baseline-trace"),
    challengerOutputPath: z.literal("/workspace/challenger-output"),
    challengerTracePath: z.literal("/workspace/challenger-trace"),
    evidencePath: z.literal("/workspace/grader-evidence")
  })
  .strict()
  .superRefine((request, context) => {
    if (
      request.baseline.candidateRole !== "baseline" ||
      request.challenger.candidateRole !== "challenger"
    ) {
      context.addIssue({
        code: "custom",
        path: ["baseline"],
        message: "Eval grader subjects must retain their matched candidate roles."
      });
    }
  });
export type FactoryEvalGraderRequest = z.infer<typeof factoryEvalGraderRequestSchema>;

const graderOutcomeSchema = z
  .object({
    taskSuccess: z.boolean(),
    safetyPass: z.boolean(),
    criticalSafetyViolation: z.boolean(),
    falsePositive: z.boolean()
  })
  .strict()
  .superRefine((outcome, context) => {
    if (outcome.criticalSafetyViolation && outcome.safetyPass) {
      context.addIssue({
        code: "custom",
        path: ["criticalSafetyViolation"],
        message: "A critical violation cannot be a safety pass."
      });
    }
  });

export const factoryEvalGraderResponseSchema = z
  .object({
    schemaVersion: z.literal("agentlab.eval-grader-response.v1"),
    status: z.enum(["succeeded", "failed"]),
    baseline: graderOutcomeSchema.nullable(),
    challenger: graderOutcomeSchema.nullable(),
    usage: factoryBudgetUsageSchema,
    usageComplete: z.literal(true),
    reasonCode: factoryIdentifierSchema.nullable()
  })
  .strict()
  .superRefine((response, context) => {
    const succeeded = response.status === "succeeded";
    if (
      succeeded !== (response.baseline !== null && response.challenger !== null) ||
      succeeded !== (response.reasonCode === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Eval grader success requires both outcomes and no failure reason."
      });
    }
    if (
      response.usage.workers !== 1 ||
      response.usage.repairAttempts !== 0 ||
      response.usage.changedFiles !== 0 ||
      response.usage.changedLines !== 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["usage"],
        message: "Eval grader usage must remain single-worker and non-mutating."
      });
    }
  });
export type FactoryEvalGraderResponse = z.infer<typeof factoryEvalGraderResponseSchema>;

/** Content-addressed provenance for one sandboxed subject invocation. */
export const factoryEvalSubjectEvidenceSchema = z
  .object({
    schemaVersion: z.literal("agentlab.eval-subject-evidence.v1"),
    jobId: z.uuid(),
    jobDigest: sha256DigestSchema,
    requestDigest: sha256DigestSchema,
    executionId: z.uuid(),
    candidateRole: z.enum(["baseline", "challenger"]),
    candidateDigest: sha256DigestSchema,
    harnessDigest: sha256DigestSchema,
    executableDigest: sha256DigestSchema,
    ...evalCoordinateShape,
    outputArtifact: factoryArtifactReferenceSchema,
    traceArtifact: factoryArtifactReferenceSchema,
    stdoutArtifact: factoryArtifactReferenceSchema,
    stderrArtifact: factoryArtifactReferenceSchema,
    usage: factoryBudgetUsageSchema,
    latencyMilliseconds: z.number().int().min(1).max(86_400_000),
    isolation: factoryProcessIsolationSchema,
    startedAt: factoryTimestampSchema,
    finishedAt: factoryTimestampSchema
  })
  .strict()
  .superRefine((evidence, context) => {
    if (evidence.finishedAt < evidence.startedAt) {
      context.addIssue({
        code: "custom",
        path: ["finishedAt"],
        message: "Eval subject evidence cannot finish before it starts."
      });
    }
  });
export type FactoryEvalSubjectEvidence = z.infer<typeof factoryEvalSubjectEvidenceSchema>;

/** Content-addressed provenance and outcome for one independently sandboxed matched grader. */
export const factoryEvalGraderEvidenceSchema = z
  .object({
    schemaVersion: z.literal("agentlab.eval-grader-evidence.v1"),
    jobId: z.uuid(),
    jobDigest: sha256DigestSchema,
    requestDigest: sha256DigestSchema,
    executionId: z.uuid(),
    graderDigest: sha256DigestSchema,
    executableDigest: sha256DigestSchema,
    ...evalCoordinateShape,
    baselineSubjectEvidenceDigest: sha256DigestSchema,
    challengerSubjectEvidenceDigest: sha256DigestSchema,
    baseline: graderOutcomeSchema,
    challenger: graderOutcomeSchema,
    evidenceArtifact: factoryArtifactReferenceSchema,
    stdoutArtifact: factoryArtifactReferenceSchema,
    stderrArtifact: factoryArtifactReferenceSchema,
    usage: factoryBudgetUsageSchema,
    isolation: factoryProcessIsolationSchema,
    startedAt: factoryTimestampSchema,
    finishedAt: factoryTimestampSchema
  })
  .strict()
  .superRefine((evidence, context) => {
    if (evidence.finishedAt < evidence.startedAt) {
      context.addIssue({
        code: "custom",
        path: ["finishedAt"],
        message: "Eval grader evidence cannot finish before it starts."
      });
    }
  });
export type FactoryEvalGraderEvidence = z.infer<typeof factoryEvalGraderEvidenceSchema>;

/** Auditable terminal evidence for an invocation that did not produce a usable subject or grade. */
export const factoryEvalInvocationFailureEvidenceSchema = z
  .object({
    schemaVersion: z.literal("agentlab.eval-invocation-failure-evidence.v1"),
    jobId: z.uuid(),
    jobDigest: sha256DigestSchema,
    requestDigest: sha256DigestSchema,
    executionId: z.uuid(),
    phase: z.enum(["subject", "grader"]),
    candidateRole: z.enum(["baseline", "challenger"]).nullable(),
    descriptorDigest: sha256DigestSchema,
    executableDigest: sha256DigestSchema,
    ...evalCoordinateShape,
    status: z.enum(["failed", "timed-out", "error"]),
    reasonCode: factoryIdentifierSchema,
    stdoutArtifact: factoryArtifactReferenceSchema,
    stderrArtifact: factoryArtifactReferenceSchema,
    reportedUsage: factoryBudgetUsageSchema.nullable(),
    accountedUsage: factoryBudgetUsageSchema,
    usageComplete: z.boolean(),
    isolation: factoryProcessIsolationSchema,
    startedAt: factoryTimestampSchema,
    finishedAt: factoryTimestampSchema
  })
  .strict()
  .superRefine((evidence, context) => {
    if (
      (evidence.phase === "subject") !== (evidence.candidateRole !== null) ||
      evidence.usageComplete !== (evidence.reportedUsage !== null) ||
      evidence.finishedAt < evidence.startedAt
    ) {
      context.addIssue({
        code: "custom",
        message: "Eval invocation failure evidence has inconsistent phase, usage, or time."
      });
    }
  });
export type FactoryEvalInvocationFailureEvidence = z.infer<
  typeof factoryEvalInvocationFailureEvidenceSchema
>;

export const factoryEvalProductionStateSchema = z.enum([
  "ready",
  "subject-active",
  "grader-active",
  "completed",
  "failed"
]);
export type FactoryEvalProductionState = z.infer<typeof factoryEvalProductionStateSchema>;

export const factoryEvalProductionEventKindSchema = z.enum([
  "registered",
  "subject-started",
  "subject-finished",
  "grader-started",
  "sample-recorded",
  "completed",
  "failed"
]);
export type FactoryEvalProductionEventKind = z.infer<typeof factoryEvalProductionEventKindSchema>;

/** Append-only crash journal. A dangling active event is terminally failed on recovery. */
export const factoryEvalProductionEventSchema = z
  .object({
    schemaVersion: z.literal("agentlab.eval-production-event.v1"),
    eventId: z.uuid(),
    jobId: z.uuid(),
    jobDigest: sha256DigestSchema,
    sequence: z.number().int().min(1).max(100_000),
    previousEventDigest: sha256DigestSchema.nullable(),
    kind: factoryEvalProductionEventKindSchema,
    from: factoryEvalProductionStateSchema.nullable(),
    to: factoryEvalProductionStateSchema,
    caseId: factoryIdentifierSchema.nullable(),
    trial: z.number().int().min(1).max(20).nullable(),
    candidateRole: z.enum(["baseline", "challenger"]).nullable(),
    executionId: z.uuid().nullable(),
    evidenceDigest: sha256DigestSchema.nullable(),
    sampleDigest: sha256DigestSchema.nullable(),
    evalRunDigest: sha256DigestSchema.nullable(),
    evalRunArtifact: factoryArtifactReferenceSchema.nullable(),
    usage: factoryBudgetUsageSchema.nullable(),
    occurredAt: factoryTimestampSchema,
    reasonCode: factoryIdentifierSchema,
    detail: safeTextSchema,
    correlationId: z.uuid(),
    actor: factoryActorSchema
  })
  .strict()
  .superRefine((event, context) => {
    validateEvalProductionEvent(event, context);
  });
export type FactoryEvalProductionEvent = z.infer<typeof factoryEvalProductionEventSchema>;

export const factoryEvalProductionResultSchema = z
  .object({
    schemaVersion: z.literal("agentlab.eval-production-result.v1"),
    status: z.enum(["completed", "existing", "failed"]),
    jobId: z.uuid(),
    jobDigest: sha256DigestSchema,
    state: z.enum(["completed", "failed"]),
    evalRunDigest: sha256DigestSchema.nullable(),
    evalRunArtifact: factoryArtifactReferenceSchema.nullable(),
    sampleCount: z.number().int().min(0).max(5_120),
    usage: factoryBudgetUsageSchema,
    reasonCode: factoryIdentifierSchema
  })
  .strict()
  .superRefine((result, context) => {
    if (
      (result.state === "completed") !==
      (result.evalRunDigest !== null && result.evalRunArtifact !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["state"],
        message: "Only completed eval production may reference a run artifact."
      });
    }
  });
export type FactoryEvalProductionResult = z.infer<typeof factoryEvalProductionResultSchema>;

export const factoryEvalProductionSampleRecordSchema = z
  .object({
    sample: factoryEvalSampleSchema,
    sampleDigest: sha256DigestSchema,
    baselineSubjectEvidenceDigest: sha256DigestSchema,
    challengerSubjectEvidenceDigest: sha256DigestSchema,
    graderEvidenceDigest: sha256DigestSchema
  })
  .strict();
export type FactoryEvalProductionSampleRecord = z.infer<
  typeof factoryEvalProductionSampleRecordSchema
>;

function validateEvalProductionEvent(
  event: z.infer<typeof factoryEvalProductionEventSchema>,
  context: z.RefinementCtx
): void {
  if (
    event.actor.kind !== "control-plane" ||
    event.actor.role !== "gate-runner" ||
    event.actor.id !== "agentlab-eval-producer"
  ) {
    context.addIssue({ code: "custom", path: ["actor"], message: "Invalid eval producer actor." });
  }
  const coordinatePresent =
    event.caseId !== null && event.trial !== null && event.executionId !== null;
  const coordinateAbsent =
    event.caseId === null &&
    event.trial === null &&
    event.candidateRole === null &&
    event.executionId === null;
  const legal =
    (event.kind === "registered" &&
      event.from === null &&
      event.to === "ready" &&
      coordinateAbsent &&
      event.evidenceDigest === null &&
      event.sampleDigest === null &&
      event.evalRunDigest === null &&
      event.evalRunArtifact === null &&
      event.usage === null) ||
    (event.kind === "subject-started" &&
      (event.from === "ready" || event.from === "subject-active") &&
      event.to === "subject-active" &&
      coordinatePresent &&
      event.candidateRole !== null &&
      event.evidenceDigest === null &&
      event.sampleDigest === null &&
      event.evalRunDigest === null &&
      event.evalRunArtifact === null &&
      event.usage === null) ||
    (event.kind === "subject-finished" &&
      event.from === "subject-active" &&
      event.to === "subject-active" &&
      coordinatePresent &&
      event.candidateRole !== null &&
      event.evidenceDigest !== null &&
      event.sampleDigest === null &&
      event.evalRunDigest === null &&
      event.evalRunArtifact === null &&
      event.usage !== null) ||
    (event.kind === "grader-started" &&
      event.from === "subject-active" &&
      event.to === "grader-active" &&
      coordinatePresent &&
      event.candidateRole === null &&
      event.evidenceDigest === null &&
      event.sampleDigest === null &&
      event.evalRunDigest === null &&
      event.evalRunArtifact === null &&
      event.usage === null) ||
    (event.kind === "sample-recorded" &&
      event.from === "grader-active" &&
      event.to === "subject-active" &&
      coordinatePresent &&
      event.candidateRole === null &&
      event.evidenceDigest !== null &&
      event.sampleDigest !== null &&
      event.evalRunDigest === null &&
      event.evalRunArtifact === null &&
      event.usage !== null) ||
    (event.kind === "completed" &&
      event.from === "subject-active" &&
      event.to === "completed" &&
      coordinateAbsent &&
      event.evidenceDigest === null &&
      event.sampleDigest === null &&
      event.evalRunDigest !== null &&
      event.evalRunArtifact !== null &&
      event.usage !== null) ||
    (event.kind === "failed" &&
      event.from !== "completed" &&
      event.from !== "failed" &&
      event.to === "failed" &&
      event.evalRunDigest === null &&
      event.evalRunArtifact === null &&
      event.usage !== null);
  if (!legal) {
    context.addIssue({
      code: "custom",
      path: ["kind"],
      message: "Eval production event fields do not match its transition."
    });
  }
}

function unique(
  values: readonly string[],
  context: z.RefinementCtx,
  path: PropertyKey[],
  label: string
): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", path, message: `${label} must be unique.` });
  }
}

function isSafeTextCharacter(value: string): boolean {
  const code = value.codePointAt(0) ?? 0;
  return code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127);
}
