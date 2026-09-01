import { z } from "zod";

import {
  factoryActorSchema,
  factoryAgentRunStatusSchema,
  factoryArtifactReferenceSchema,
  factoryBudgetSchema,
  factoryBudgetUsageSchema,
  factoryIdentifierSchema,
  factoryProcessIsolationSchema,
  factoryResourceLimitsSchema,
  factorySemanticVersionSchema,
  factoryTimestampSchema,
  gitObjectIdSchema,
  repositoryPathPatternSchema,
  repositoryRelativePathSchema,
  sha256DigestSchema,
  skillManifestSchema
} from "./factory.js";
import { factorySchedulePolicySchema } from "./factory-schedule.js";
import { modelIdSchema, providerIdSchema, reasoningIdSchema } from "./provider.js";

const narrativeSchema = z
  .string()
  .trim()
  .min(1)
  .max(2_000)
  .refine((value) => !hasDisallowedControl(value), "Text contains a control character.");

const titleSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine((value) => !hasAsciiControl(value), "Title contains a control character.");

const repositoryIdentitySchema = z
  .object({
    id: factoryIdentifierSchema,
    baseRevision: gitObjectIdSchema
  })
  .strict();

export const factoryMaintenanceChangeClassSchema = z.enum([
  "bug",
  "documentation",
  "tests",
  "non-behavioral-refactor"
]);
export type FactoryMaintenanceChangeClass = z.infer<typeof factoryMaintenanceChangeClassSchema>;

const discoveryEvidenceSchema = z
  .object({
    path: repositoryRelativePathSchema,
    lineStart: z.number().int().min(1).max(10_000_000).nullable(),
    lineEnd: z.number().int().min(1).max(10_000_000).nullable(),
    observation: narrativeSchema
  })
  .strict()
  .superRefine((evidence, context) => {
    if ((evidence.lineStart === null) !== (evidence.lineEnd === null)) {
      context.addIssue({
        code: "custom",
        path: ["lineEnd"],
        message: "Discovery evidence line coordinates must be both present or both absent."
      });
    }
    if (
      evidence.lineStart !== null &&
      evidence.lineEnd !== null &&
      evidence.lineEnd < evidence.lineStart
    ) {
      context.addIssue({
        code: "custom",
        path: ["lineEnd"],
        message: "Discovery evidence cannot end before it starts."
      });
    }
  });

export const factoryMaintenanceFindingCandidateSchema = z
  .object({
    findingKey: factoryIdentifierSchema,
    changeClass: factoryMaintenanceChangeClassSchema,
    proposedRiskTier: z.literal("R1"),
    priority: z.number().int().min(1).max(100),
    confidence: z.number().int().min(1).max(100),
    title: titleSchema,
    summary: narrativeSchema,
    rationale: narrativeSchema,
    acceptanceCriteria: z.array(narrativeSchema).min(1).max(8),
    affectedPaths: z.array(repositoryRelativePathSchema).min(1).max(16),
    evidence: z.array(discoveryEvidenceSchema).min(1).max(8)
  })
  .strict()
  .superRefine((finding, context) => {
    unique(finding.acceptanceCriteria, context, ["acceptanceCriteria"]);
    unique(finding.affectedPaths, context, ["affectedPaths"]);
    unique(
      finding.evidence.map(
        ({ path, lineStart, lineEnd, observation }) =>
          `${path}\0${String(lineStart)}\0${String(lineEnd)}\0${observation}`
      ),
      context,
      ["evidence"]
    );
  });
export type FactoryMaintenanceFindingCandidate = z.infer<
  typeof factoryMaintenanceFindingCandidateSchema
>;

/** Untrusted read-only scout output; every candidate still passes deterministic admission. */
export const factoryMaintenanceDiscoveryOutputSchema = z
  .object({
    schemaVersion: z.literal("agentlab.maintenance-discovery-output.v1"),
    findings: z.array(factoryMaintenanceFindingCandidateSchema).max(32)
  })
  .strict()
  .superRefine((output, context) => {
    unique(
      output.findings.map(({ findingKey }) => findingKey),
      context,
      ["findings"]
    );
  });
export type FactoryMaintenanceDiscoveryOutput = z.infer<
  typeof factoryMaintenanceDiscoveryOutputSchema
>;

/** Repository-owned policy for one bounded, credentialless daily maintenance scout. */
export const factoryMaintenanceDiscoveryPolicySchema = z
  .object({
    schemaVersion: z.literal("agentlab.maintenance-discovery-policy.v1"),
    id: z.literal("agentlab/daily-maintenance-discovery"),
    version: factorySemanticVersionSchema,
    profile: z
      .object({
        id: factoryIdentifierSchema,
        provider: providerIdSchema,
        model: modelIdSchema,
        reasoning: reasoningIdSchema.nullable(),
        resourceLimits: factoryResourceLimitsSchema
      })
      .strict(),
    skill: skillManifestSchema,
    maximumFindingsPerTick: z.number().int().min(1).max(32),
    maximumAdmissionsPerTick: z.number().int().min(1).max(32),
    minimumConfidence: z.number().int().min(1).max(100),
    allowedChangeClasses: z.array(factoryMaintenanceChangeClassSchema).min(1).max(4),
    allowedIncludePaths: z.array(repositoryPathPatternSchema).min(1).max(256),
    excludedPaths: z.array(repositoryPathPatternSchema).max(256),
    protectedPaths: z.array(repositoryPathPatternSchema).max(256),
    maximumRiskTier: z.literal("R1")
  })
  .strict()
  .superRefine((policy, context) => {
    unique(policy.allowedChangeClasses, context, ["allowedChangeClasses"]);
    unique(policy.allowedIncludePaths, context, ["allowedIncludePaths"]);
    unique(policy.excludedPaths, context, ["excludedPaths"]);
    unique(policy.protectedPaths, context, ["protectedPaths"]);
    if (policy.maximumAdmissionsPerTick > policy.maximumFindingsPerTick) {
      context.addIssue({
        code: "custom",
        path: ["maximumAdmissionsPerTick"],
        message: "Discovery admissions cannot exceed the finding ceiling."
      });
    }
    const capabilities = policy.skill.requestedCapabilities;
    const budget = policy.skill.budgetCeiling;
    if (
      policy.skill.roles.length !== 1 ||
      policy.skill.roles[0] !== "maintenance-scout" ||
      !policy.skill.triggers.includes("scheduled") ||
      policy.skill.riskCeiling !== "R0" ||
      !policy.skill.allowedFromStates.includes("intake") ||
      !policy.skill.allowedToStates.includes("intake") ||
      policy.skill.outputSchemaDigest === null ||
      !policy.skill.requiredEvidence.includes("discovery")
    ) {
      context.addIssue({
        code: "custom",
        path: ["skill"],
        message:
          "Discovery requires one scheduled R0 maintenance-scout skill with a pinned output schema."
      });
    }
    if (
      capabilities.filesystem !== "read" ||
      capabilities.git !== "read" ||
      capabilities.remoteRepository !== "none" ||
      capabilities.network.mode !== "off" ||
      capabilities.commandAllowlist.length > 0 ||
      capabilities.secretRefs.length > 0 ||
      budget.maxWorkers !== 1 ||
      budget.maxRepairAttempts !== 0 ||
      budget.maxChangedFiles !== 0 ||
      budget.maxChangedLines !== 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["skill"],
        message:
          "Maintenance discovery must remain local, read-only, offline, single-worker, and non-mutating."
      });
    }
    const compatibility = policy.skill.providerCompatibility;
    if (
      compatibility.mode === "allowlist" &&
      !compatibility.providers.includes(policy.profile.provider)
    ) {
      context.addIssue({
        code: "custom",
        path: ["profile", "provider"],
        message: "Discovery profile provider is incompatible with its pinned skill."
      });
    }
  });
export type FactoryMaintenanceDiscoveryPolicy = z.infer<
  typeof factoryMaintenanceDiscoveryPolicySchema
>;

export const factoryMaintenanceDiscoveryRunSchema = z
  .object({
    schemaVersion: z.literal("agentlab.maintenance-discovery-run.v1"),
    runId: z.uuid(),
    discoveryPolicyDigest: sha256DigestSchema,
    discoveryPolicy: factoryMaintenanceDiscoveryPolicySchema,
    schedulePolicyDigest: sha256DigestSchema,
    schedulePolicy: factorySchedulePolicySchema,
    factoryPolicyBundleDigest: sha256DigestSchema,
    preparationGrantDigest: sha256DigestSchema,
    roleIdentityPolicyDigest: sha256DigestSchema,
    repository: repositoryIdentitySchema,
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
        message: "Discovery deadline must follow its slot."
      });
    }
    if (run.createdAt < run.scheduledFor || run.createdAt > run.deadlineAt) {
      context.addIssue({
        code: "custom",
        path: ["createdAt"],
        message: "Discovery must start inside its admitted schedule window."
      });
    }
  });
export type FactoryMaintenanceDiscoveryRun = z.infer<typeof factoryMaintenanceDiscoveryRunSchema>;

export const factoryMaintenanceDiscoveryRunRequestSchema = z
  .object({
    schemaVersion: z.literal("agentlab.maintenance-discovery-run-request.v1"),
    executionId: z.uuid(),
    runId: z.uuid(),
    taskId: z.uuid(),
    runDigest: sha256DigestSchema,
    attempt: z.literal(1),
    provider: providerIdSchema,
    model: modelIdSchema,
    reasoning: reasoningIdSchema.nullable(),
    repository: repositoryIdentitySchema,
    skillId: factoryIdentifierSchema,
    skillPackageDigest: sha256DigestSchema,
    promptArtifact: factoryArtifactReferenceSchema,
    outputSchemaDigest: sha256DigestSchema,
    capabilities: factoryMaintenanceDiscoveryPolicySchema.shape.skill.shape.requestedCapabilities,
    budget: factoryBudgetSchema
  })
  .strict()
  .superRefine((request, context) => {
    if (request.taskId !== request.runId) {
      context.addIssue({
        code: "custom",
        path: ["taskId"],
        message: "The isolated discovery workspace identity must equal its durable run identity."
      });
    }
    if (
      request.capabilities.filesystem !== "read" ||
      request.capabilities.git !== "read" ||
      request.capabilities.remoteRepository !== "none" ||
      request.capabilities.network.mode !== "off" ||
      request.capabilities.commandAllowlist.length > 0 ||
      request.capabilities.secretRefs.length > 0 ||
      request.budget.maxWorkers !== 1 ||
      request.budget.maxRepairAttempts !== 0 ||
      request.budget.maxChangedFiles !== 0 ||
      request.budget.maxChangedLines !== 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["capabilities"],
        message: "Discovery execution must remain read-only, offline, and non-mutating."
      });
    }
  });
export type FactoryMaintenanceDiscoveryRunRequest = z.infer<
  typeof factoryMaintenanceDiscoveryRunRequestSchema
>;

export const factoryMaintenanceDiscoveryRunRecordSchema = z
  .object({
    schemaVersion: z.literal("agentlab.maintenance-discovery-run-record.v1"),
    executionId: z.uuid(),
    runId: z.uuid(),
    runDigest: sha256DigestSchema,
    provider: providerIdSchema,
    providerVersion: z.string().trim().min(1).max(180),
    harnessVersion: z.string().trim().min(1).max(180),
    model: modelIdSchema,
    reasoning: reasoningIdSchema.nullable(),
    providerSessionId: z.string().trim().min(1).max(256).nullable(),
    status: factoryAgentRunStatusSchema,
    startedAt: factoryTimestampSchema,
    finishedAt: factoryTimestampSchema,
    exitCode: z.number().int().min(0).max(255).nullable(),
    stdoutArtifact: factoryArtifactReferenceSchema,
    stderrArtifact: factoryArtifactReferenceSchema,
    finalOutputArtifact: factoryArtifactReferenceSchema.nullable(),
    outputDocumentArtifact: factoryArtifactReferenceSchema.nullable(),
    usage: factoryBudgetUsageSchema,
    usageComplete: z.boolean(),
    errorCode: factoryIdentifierSchema.nullable(),
    isolation: factoryProcessIsolationSchema
  })
  .strict()
  .superRefine((record, context) => {
    if (record.finishedAt < record.startedAt) {
      context.addIssue({
        code: "custom",
        path: ["finishedAt"],
        message: "Discovery run cannot finish before it starts."
      });
    }
    const succeeded = record.status === "succeeded";
    if (
      succeeded !==
      (record.exitCode === 0 &&
        record.providerSessionId !== null &&
        record.finalOutputArtifact !== null &&
        record.outputDocumentArtifact !== null &&
        record.usageComplete &&
        record.errorCode === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "Discovery run status disagrees with its captured output and accounting."
      });
    }
  });
export type FactoryMaintenanceDiscoveryRunRecord = z.infer<
  typeof factoryMaintenanceDiscoveryRunRecordSchema
>;

export const factoryMaintenanceFindingSchema = z
  .object({
    schemaVersion: z.literal("agentlab.maintenance-finding.v1"),
    runId: z.uuid(),
    runDigest: sha256DigestSchema,
    discoveredAt: factoryTimestampSchema,
    candidate: factoryMaintenanceFindingCandidateSchema
  })
  .strict();
export type FactoryMaintenanceFinding = z.infer<typeof factoryMaintenanceFindingSchema>;

export const factoryMaintenanceDiscoveryStateSchema = z.enum([
  "ready",
  "agent-active",
  "admitting",
  "completed",
  "failed"
]);
export type FactoryMaintenanceDiscoveryState = z.infer<
  typeof factoryMaintenanceDiscoveryStateSchema
>;

const eventBase = {
  schemaVersion: z.literal("agentlab.maintenance-discovery-event.v1"),
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

export const factoryMaintenanceDiscoveryEventSchema = z
  .discriminatedUnion("kind", [
    z
      .object({
        ...eventBase,
        kind: z.literal("registered"),
        from: z.null(),
        to: z.literal("ready")
      })
      .strict(),
    z
      .object({
        ...eventBase,
        kind: z.literal("agent-started"),
        from: z.literal("ready"),
        to: z.literal("agent-active"),
        executionId: z.uuid(),
        runRequestDigest: sha256DigestSchema
      })
      .strict(),
    z
      .object({
        ...eventBase,
        kind: z.literal("agent-finished"),
        from: z.literal("agent-active"),
        to: z.literal("admitting"),
        executionId: z.uuid(),
        runRecordDigest: sha256DigestSchema,
        outputDigest: sha256DigestSchema,
        findings: z.number().int().min(0).max(32),
        usage: factoryBudgetUsageSchema
      })
      .strict(),
    z
      .object({
        ...eventBase,
        kind: z.literal("agent-failed"),
        from: z.literal("agent-active"),
        to: z.literal("failed"),
        executionId: z.uuid(),
        runRecordDigest: sha256DigestSchema,
        errorCode: factoryIdentifierSchema,
        usage: factoryBudgetUsageSchema
      })
      .strict(),
    z
      .object({
        ...eventBase,
        kind: z.literal("finding-admitted"),
        from: z.literal("admitting"),
        to: z.literal("admitting"),
        findingKey: factoryIdentifierSchema,
        findingDigest: sha256DigestSchema,
        taskId: z.uuid(),
        requestDigest: sha256DigestSchema,
        authorityDigest: sha256DigestSchema
      })
      .strict(),
    z
      .object({
        ...eventBase,
        kind: z.literal("finding-skipped"),
        from: z.literal("admitting"),
        to: z.literal("admitting"),
        findingKey: factoryIdentifierSchema,
        findingDigest: sha256DigestSchema,
        skipReason: factoryIdentifierSchema
      })
      .strict(),
    z
      .object({
        ...eventBase,
        kind: z.literal("completed"),
        from: z.literal("admitting"),
        to: z.literal("completed"),
        findings: z.number().int().min(0).max(32),
        admitted: z.number().int().min(0).max(32),
        skipped: z.number().int().min(0).max(32),
        usage: factoryBudgetUsageSchema
      })
      .strict()
  ])
  .superRefine((event, context) => {
    if (event.actor.kind !== "control-plane" || event.actor.role !== "policy-engine") {
      context.addIssue({
        code: "custom",
        path: ["actor"],
        message: "Only the maintenance discovery control plane may append journal events."
      });
    }
    if (
      event.kind === "registered" &&
      (event.sequence !== 1 || event.previousEventDigest !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["sequence"],
        message: "Only the first discovery event may register a run."
      });
    }
    if (
      event.kind !== "registered" &&
      (event.sequence === 1 || event.previousEventDigest === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["previousEventDigest"],
        message: "Every later discovery event must link to its predecessor."
      });
    }
    if (event.kind === "completed" && event.admitted + event.skipped !== event.findings) {
      context.addIssue({
        code: "custom",
        path: ["findings"],
        message: "Discovery completion counts must cover every finding."
      });
    }
  });
export type FactoryMaintenanceDiscoveryEvent = z.infer<
  typeof factoryMaintenanceDiscoveryEventSchema
>;

function unique(values: readonly string[], context: z.RefinementCtx, path: PropertyKey[]): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", path, message: "Values must be unique." });
  }
}

function hasAsciiControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function hasDisallowedControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (codePoint <= 0x1f && codePoint !== 0x09 && codePoint !== 0x0a) || codePoint === 0x7f;
  });
}
