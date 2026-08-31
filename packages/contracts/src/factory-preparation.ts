import { z } from "zod";

import {
  evidenceKindSchema,
  factoryAgentRunStatusSchema,
  factoryActorSchema,
  factoryArtifactReferenceSchema,
  factoryBudgetSchema,
  factoryBudgetUsageSchema,
  factoryCapabilityGrantSchema,
  factoryExecutionRoleSchema,
  factoryIdentifierSchema,
  factoryProcessIsolationSchema,
  factoryRiskTierSchema,
  factorySemanticVersionSchema,
  factorySkillPhaseSchema,
  factoryTimestampSchema,
  gitObjectIdSchema,
  repositoryPathPatternSchema,
  sha256DigestSchema,
  skillManifestSchema,
  type FactoryActorRole,
  type FactorySkillPhase,
  type FactoryTaskState
} from "./factory.js";
import { modelIdSchema, providerIdSchema, reasoningIdSchema } from "./provider.js";

export const factoryPreparationPhaseSchema = z.enum(["qualify", "specify", "plan"]);
export type FactoryPreparationPhase = z.infer<typeof factoryPreparationPhaseSchema>;

export const factoryPreparationStateSchema = z.enum([
  "registered",
  "qualifying",
  "qualified",
  "specifying",
  "specified",
  "planning",
  "planned",
  "prepared",
  "needs-human",
  "rejected",
  "failed",
  "cancelled",
  "expired"
]);
export type FactoryPreparationState = z.infer<typeof factoryPreparationStateSchema>;

const statementSchema = z
  .string()
  .trim()
  .min(1)
  .max(4_096)
  .refine((value) => !hasDisallowedNarrativeControl(value), "Text contains a control character.");

const requestTitleSchema = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .refine((value) => !hasAsciiControl(value), "Request title contains a control character.");

const requestBodySchema = z
  .string()
  .trim()
  .min(1)
  .max(65_536)
  .refine(
    (value) => !hasDisallowedNarrativeControl(value),
    "Request body contains a control character."
  );

const requestSourceSchema = z
  .object({
    kind: z.enum(["local", "github-issue", "github-pull-request", "other"]),
    ref: z
      .string()
      .trim()
      .min(1)
      .max(2_048)
      .refine((value) => !hasAsciiControl(value), "Request source contains a control character.")
  })
  .strict();

const repositoryIdentitySchema = z
  .object({
    id: factoryIdentifierSchema,
    baseRevision: gitObjectIdSchema
  })
  .strict();

const scopeSchema = z
  .object({
    includePaths: z.array(repositoryPathPatternSchema).min(1).max(256),
    excludePaths: z.array(repositoryPathPatternSchema).max(256),
    protectedPaths: z.array(repositoryPathPatternSchema).max(256)
  })
  .strict()
  .superRefine((scope, context) => {
    uniqueValues(scope.includePaths, context, ["includePaths"]);
    uniqueValues(scope.excludePaths, context, ["excludePaths"]);
    uniqueValues(scope.protectedPaths, context, ["protectedPaths"]);
  });

export const factoryIntakeRequestSchema = z
  .object({
    schemaVersion: z.literal("agentlab.intake-request.v1"),
    taskId: z.uuid(),
    conversationId: z.uuid(),
    createdAt: factoryTimestampSchema,
    deduplicationKey: sha256DigestSchema,
    repository: repositoryIdentitySchema,
    requestSources: z.array(requestSourceSchema).min(1).max(32),
    trigger: z.enum(["manual", "scheduled", "webhook"]),
    requester: factoryActorSchema,
    title: requestTitleSchema,
    body: requestBodySchema
  })
  .strict()
  .superRefine((request, context) => {
    uniqueValues(
      request.requestSources.map((source) => `${source.kind}:${source.ref}`),
      context,
      ["requestSources"]
    );
    if (request.requester.role !== "requester") {
      context.addIssue({
        code: "custom",
        path: ["requester", "role"],
        message: "An intake request must identify its requester."
      });
    }
    if (request.trigger === "manual" && request.requester.kind !== "human") {
      context.addIssue({
        code: "custom",
        path: ["requester", "kind"],
        message: "A manual intake request requires a human requester."
      });
    }
    if (request.requester.kind !== "human" && request.requester.kind !== "control-plane") {
      context.addIssue({
        code: "custom",
        path: ["requester", "kind"],
        message: "Only a human or authenticated control plane may submit intake."
      });
    }
  });
export type FactoryIntakeRequest = z.infer<typeof factoryIntakeRequestSchema>;

const qualificationBaseSchema = z.object({
  schemaVersion: z.literal("agentlab.qualification.v1"),
  taskId: z.uuid(),
  requestDigest: sha256DigestSchema,
  createdAt: factoryTimestampSchema,
  assumptions: z.array(statementSchema).max(50)
});

export const factoryQualificationSchema = z
  .discriminatedUnion("disposition", [
    qualificationBaseSchema
      .extend({
        disposition: z.literal("ready"),
        objective: statementSchema,
        openQuestions: z.array(statementSchema).max(0),
        rejectionReason: z.null()
      })
      .strict(),
    qualificationBaseSchema
      .extend({
        disposition: z.literal("needs-human"),
        objective: statementSchema.nullable(),
        openQuestions: z.array(statementSchema).min(1).max(50),
        rejectionReason: z.null()
      })
      .strict(),
    qualificationBaseSchema
      .extend({
        disposition: z.literal("rejected"),
        objective: statementSchema.nullable(),
        openQuestions: z.array(statementSchema).max(50),
        rejectionReason: statementSchema
      })
      .strict()
  ])
  .superRefine((qualification, context) => {
    uniqueValues(qualification.assumptions, context, ["assumptions"]);
    uniqueValues(qualification.openQuestions, context, ["openQuestions"]);
  });
export type FactoryQualification = z.infer<typeof factoryQualificationSchema>;

const qualificationOutputBaseSchema = z.object({
  schemaVersion: z.literal("agentlab.qualification-output.v1"),
  assumptions: z.array(statementSchema).max(50)
});

export const factoryQualificationOutputSchema = z
  .discriminatedUnion("disposition", [
    qualificationOutputBaseSchema
      .extend({
        disposition: z.literal("ready"),
        objective: statementSchema,
        openQuestions: z.array(statementSchema).max(0),
        rejectionReason: z.null()
      })
      .strict(),
    qualificationOutputBaseSchema
      .extend({
        disposition: z.literal("needs-human"),
        objective: statementSchema.nullable(),
        openQuestions: z.array(statementSchema).min(1).max(50),
        rejectionReason: z.null()
      })
      .strict(),
    qualificationOutputBaseSchema
      .extend({
        disposition: z.literal("rejected"),
        objective: statementSchema.nullable(),
        openQuestions: z.array(statementSchema).max(50),
        rejectionReason: statementSchema
      })
      .strict()
  ])
  .superRefine((qualification, context) => {
    uniqueValues(qualification.assumptions, context, ["assumptions"]);
    uniqueValues(qualification.openQuestions, context, ["openQuestions"]);
  });
export type FactoryQualificationOutput = z.infer<typeof factoryQualificationOutputSchema>;

export const factorySpecificationSchema = z
  .object({
    schemaVersion: z.literal("agentlab.specification.v1"),
    taskId: z.uuid(),
    requestDigest: sha256DigestSchema,
    qualificationDigest: sha256DigestSchema,
    createdAt: factoryTimestampSchema,
    objective: statementSchema,
    acceptanceCriteria: z.array(statementSchema).min(1).max(50),
    nonGoals: z.array(statementSchema).max(50),
    scope: scopeSchema
  })
  .strict()
  .superRefine((specification, context) => {
    uniqueValues(specification.acceptanceCriteria, context, ["acceptanceCriteria"]);
    uniqueValues(specification.nonGoals, context, ["nonGoals"]);
  });
export type FactorySpecification = z.infer<typeof factorySpecificationSchema>;

export const factorySpecificationOutputSchema = z
  .object({
    schemaVersion: z.literal("agentlab.specification-output.v1"),
    objective: statementSchema,
    acceptanceCriteria: z.array(statementSchema).min(1).max(50),
    nonGoals: z.array(statementSchema).max(50),
    scope: scopeSchema
  })
  .strict()
  .superRefine((specification, context) => {
    uniqueValues(specification.acceptanceCriteria, context, ["acceptanceCriteria"]);
    uniqueValues(specification.nonGoals, context, ["nonGoals"]);
  });
export type FactorySpecificationOutput = z.infer<typeof factorySpecificationOutputSchema>;

export const factoryPlanSchema = z
  .object({
    schemaVersion: z.literal("agentlab.plan.v1"),
    taskId: z.uuid(),
    requestDigest: sha256DigestSchema,
    qualificationDigest: sha256DigestSchema,
    specificationDigest: sha256DigestSchema,
    createdAt: factoryTimestampSchema,
    proposedRiskTier: factoryRiskTierSchema,
    selectedSkillIds: z.array(factoryIdentifierSchema).min(1).max(64),
    selectedWorkerProfileIds: z.array(factoryIdentifierSchema).min(1).max(16),
    capabilities: factoryCapabilityGrantSchema,
    budget: factoryBudgetSchema,
    requiredEvidence: z.array(evidenceKindSchema).max(32)
  })
  .strict()
  .superRefine((plan, context) => {
    uniqueValues(plan.selectedSkillIds, context, ["selectedSkillIds"]);
    uniqueValues(plan.selectedWorkerProfileIds, context, ["selectedWorkerProfileIds"]);
    uniqueValues(plan.requiredEvidence, context, ["requiredEvidence"]);
  });
export type FactoryPlan = z.infer<typeof factoryPlanSchema>;

export const factoryPlanOutputSchema = z
  .object({
    schemaVersion: z.literal("agentlab.plan-output.v1"),
    proposedRiskTier: factoryRiskTierSchema,
    selectedSkillIds: z.array(factoryIdentifierSchema).min(1).max(64),
    selectedWorkerProfileIds: z.array(factoryIdentifierSchema).min(1).max(16),
    capabilities: factoryCapabilityGrantSchema,
    budget: factoryBudgetSchema,
    requiredEvidence: z.array(evidenceKindSchema).max(32)
  })
  .strict()
  .superRefine((plan, context) => {
    uniqueValues(plan.selectedSkillIds, context, ["selectedSkillIds"]);
    uniqueValues(plan.selectedWorkerProfileIds, context, ["selectedWorkerProfileIds"]);
    uniqueValues(plan.requiredEvidence, context, ["requiredEvidence"]);
  });
export type FactoryPlanOutput = z.infer<typeof factoryPlanOutputSchema>;

const authorizedSkillSchema = z
  .object({
    phase: factorySkillPhaseSchema,
    dependsOn: z.array(factoryIdentifierSchema).max(64),
    manifest: skillManifestSchema
  })
  .strict()
  .superRefine((skill, context) => {
    uniqueValues(skill.dependsOn, context, ["dependsOn"]);
    const phase = phasePolicy[skill.phase];
    if (
      !skill.manifest.roles.includes(phase.role) ||
      !skill.manifest.allowedFromStates.includes(phase.from) ||
      !skill.manifest.allowedToStates.includes(phase.to)
    ) {
      context.addIssue({
        code: "custom",
        path: ["manifest"],
        message: "Authorized skill manifest does not permit its assigned phase."
      });
    }
  });

const workerProfileSchema = z
  .object({
    id: factoryIdentifierSchema,
    roles: z.array(factoryExecutionRoleSchema).min(1).max(3),
    provider: providerIdSchema,
    model: modelIdSchema,
    reasoning: reasoningIdSchema.nullable()
  })
  .strict()
  .superRefine((profile, context) => {
    uniqueValues(profile.roles, context, ["roles"]);
  });

export const factoryPreparationWorkerProfileSchema = z
  .object({
    id: factoryIdentifierSchema,
    phase: factoryPreparationPhaseSchema,
    skillId: factoryIdentifierSchema,
    provider: providerIdSchema,
    model: modelIdSchema,
    reasoning: reasoningIdSchema.nullable(),
    capabilities: factoryCapabilityGrantSchema,
    budget: factoryBudgetSchema
  })
  .strict()
  .superRefine((profile, context) => {
    if (
      profile.capabilities.filesystem !== "read" ||
      profile.capabilities.git !== "read" ||
      profile.capabilities.remoteRepository !== "none" ||
      profile.capabilities.network.mode !== "off" ||
      profile.capabilities.secretRefs.length > 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["capabilities"],
        message: "Preparation workers are local, read-only, offline, and receive no secrets."
      });
    }
    if (
      profile.budget.maxWorkers !== 1 ||
      profile.budget.maxRepairAttempts !== 0 ||
      profile.budget.maxChangedFiles !== 0 ||
      profile.budget.maxChangedLines !== 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["budget"],
        message: "A preparation run cannot delegate, repair, or change repository files."
      });
    }
  });
export type FactoryPreparationWorkerProfile = z.infer<typeof factoryPreparationWorkerProfileSchema>;

const approvalRolesSchema = z
  .object({
    execution: z.array(factoryIdentifierSchema).min(1).max(16),
    pullRequestCreation: z.array(factoryIdentifierSchema).min(1).max(16),
    merge: z.array(factoryIdentifierSchema).min(1).max(16),
    release: z.array(factoryIdentifierSchema).min(1).max(16)
  })
  .strict()
  .superRefine((roles, context) => {
    uniqueValues(roles.execution, context, ["execution"]);
    uniqueValues(roles.pullRequestCreation, context, ["pullRequestCreation"]);
    uniqueValues(roles.merge, context, ["merge"]);
    uniqueValues(roles.release, context, ["release"]);
  });

const authorityPolicyShape = {
  allowedIncludePaths: z.array(repositoryPathPatternSchema).min(1).max(256),
  protectedPaths: z.array(repositoryPathPatternSchema).max(256),
  maximumRiskTier: factoryRiskTierSchema,
  skills: z.array(authorizedSkillSchema).min(4).max(64),
  preparationProfiles: z.array(factoryPreparationWorkerProfileSchema).length(3),
  workerProfiles: z.array(workerProfileSchema).min(1).max(16),
  capabilityCeiling: factoryCapabilityGrantSchema,
  budgetCeiling: factoryBudgetSchema,
  evidenceFloor: z.array(evidenceKindSchema).max(32),
  approvalRoles: approvalRolesSchema,
  maximumPreparationAttempts: z.number().int().min(1).max(5),
  maximumContractLifetimeSeconds: z.number().int().min(60).max(604_800)
} as const;

export const factoryPreparationAuthorityGrantSchema = z
  .object({
    schemaVersion: z.literal("agentlab.preparation-authority-grant.v1"),
    authorityId: factoryIdentifierSchema,
    version: factorySemanticVersionSchema,
    maximumAuthorityLifetimeSeconds: z.number().int().min(60).max(604_800),
    ...authorityPolicyShape
  })
  .strict()
  .superRefine(refineAuthorityPolicy);
export type FactoryPreparationAuthorityGrant = z.infer<
  typeof factoryPreparationAuthorityGrantSchema
>;

export const factoryPreparationAuthoritySchema = z
  .object({
    schemaVersion: z.literal("agentlab.preparation-authority.v2"),
    authorityId: factoryIdentifierSchema,
    version: factorySemanticVersionSchema,
    taskId: z.uuid(),
    requestDigest: sha256DigestSchema,
    supersedesContractDigest: sha256DigestSchema.nullable(),
    issuedAt: factoryTimestampSchema,
    expiresAt: factoryTimestampSchema,
    policyBundleDigest: sha256DigestSchema,
    repository: repositoryIdentitySchema,
    ...authorityPolicyShape
  })
  .strict()
  .superRefine((authority, context) => {
    if (authority.expiresAt <= authority.issuedAt) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Preparation authority must expire after it is issued."
      });
    }
    refineAuthorityPolicy(authority, context);
  });
export type FactoryPreparationAuthority = z.infer<typeof factoryPreparationAuthoritySchema>;

function refineAuthorityPolicy(
  authority: {
    readonly allowedIncludePaths: readonly string[];
    readonly protectedPaths: readonly string[];
    readonly evidenceFloor: readonly string[];
    readonly workerProfiles: readonly { readonly id: string }[];
    readonly preparationProfiles: readonly {
      readonly id: string;
      readonly phase: FactoryPreparationPhase;
    }[];
    readonly skills: readonly z.infer<typeof authorizedSkillSchema>[];
  },
  context: z.RefinementCtx
): void {
  uniqueValues(authority.allowedIncludePaths, context, ["allowedIncludePaths"]);
  uniqueValues(authority.protectedPaths, context, ["protectedPaths"]);
  uniqueValues(authority.evidenceFloor, context, ["evidenceFloor"]);
  uniqueValues(
    authority.workerProfiles.map((profile) => profile.id),
    context,
    ["workerProfiles"]
  );
  uniqueValues(
    authority.preparationProfiles.map((profile) => profile.id),
    context,
    ["preparationProfiles"]
  );
  uniqueValues(
    authority.preparationProfiles.map((profile) => profile.phase),
    context,
    ["preparationProfiles"]
  );
  for (const phase of factoryPreparationPhaseSchema.options) {
    if (!authority.preparationProfiles.some((profile) => profile.phase === phase)) {
      context.addIssue({
        code: "custom",
        path: ["preparationProfiles"],
        message: `Preparation authority requires one ${phase} worker profile.`
      });
    }
  }
  const skillIds = authority.skills.map((skill) => skill.manifest.id);
  uniqueValues(skillIds, context, ["skills"]);
  uniqueValues(
    authority.skills.map((skill) => skill.manifest.packageDigest),
    context,
    ["skills"]
  );
  const skills = new Map(authority.skills.map((skill) => [skill.manifest.id, skill]));
  for (const [index, skill] of authority.skills.entries()) {
    const dependencyDigests: string[] = [];
    for (const dependencyId of skill.dependsOn) {
      const dependency = skills.get(dependencyId);
      if (dependency === undefined) {
        context.addIssue({
          code: "custom",
          path: ["skills", index, "dependsOn"],
          message: `Unknown authorized skill dependency ${dependencyId}.`
        });
      } else {
        dependencyDigests.push(dependency.manifest.packageDigest);
      }
    }
    if (!sameSet(dependencyDigests, skill.manifest.dependencyDigests)) {
      context.addIssue({
        code: "custom",
        path: ["skills", index, "manifest", "dependencyDigests"],
        message: "Authorized skill dependency IDs and package digests disagree."
      });
    }
  }
  if (skillGraphHasCycle(authority.skills)) {
    context.addIssue({
      code: "custom",
      path: ["skills"],
      message: "Authorized skill graph must be acyclic."
    });
  }
}

const preparationRunSchema = z
  .object({
    executionId: z.uuid(),
    phase: factoryPreparationPhaseSchema,
    skillId: factoryIdentifierSchema,
    skillPackageDigest: sha256DigestSchema,
    workerProfileId: factoryIdentifierSchema,
    provider: providerIdSchema,
    model: modelIdSchema,
    reasoning: reasoningIdSchema.nullable(),
    actor: factoryActorSchema,
    startedAt: factoryTimestampSchema,
    finishedAt: factoryTimestampSchema,
    runRecordDigest: sha256DigestSchema,
    outputDigest: sha256DigestSchema
  })
  .strict()
  .superRefine((run, context) => {
    if (run.finishedAt < run.startedAt) {
      context.addIssue({
        code: "custom",
        path: ["finishedAt"],
        message: "Preparation run cannot finish before it starts."
      });
    }
    if (
      run.actor.kind !== "agent" ||
      run.actor.role !== phasePolicy[run.phase].role ||
      run.actor.sessionId === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["actor"],
        message: "Preparation output requires a session-bound agent in the phase role."
      });
    }
  });

export const factoryPreparationBundleSchema = z
  .object({
    schemaVersion: z.literal("agentlab.preparation-bundle.v2"),
    taskId: z.uuid(),
    requestDigest: sha256DigestSchema,
    authorityDigest: sha256DigestSchema,
    qualificationDigest: sha256DigestSchema,
    specificationDigest: sha256DigestSchema,
    planDigest: sha256DigestSchema,
    runs: z.array(preparationRunSchema).length(3),
    createdAt: factoryTimestampSchema
  })
  .strict()
  .superRefine((bundle, context) => {
    uniqueValues(
      bundle.runs.map((run) => run.phase),
      context,
      ["runs"]
    );
    uniqueValues(
      bundle.runs.map((run) => run.executionId),
      context,
      ["runs"]
    );
    uniqueValues(
      bundle.runs.map((run) => run.runRecordDigest),
      context,
      ["runs"]
    );
    const expectedOutputs: Readonly<Record<(typeof bundle.runs)[number]["phase"], string>> = {
      qualify: bundle.qualificationDigest,
      specify: bundle.specificationDigest,
      plan: bundle.planDigest
    };
    for (const [index, run] of bundle.runs.entries()) {
      if (run.outputDigest !== expectedOutputs[run.phase]) {
        context.addIssue({
          code: "custom",
          path: ["runs", index, "outputDigest"],
          message: "Preparation run output does not match the bundle artifact digest."
        });
      }
      if (run.finishedAt > bundle.createdAt) {
        context.addIssue({
          code: "custom",
          path: ["createdAt"],
          message: "Preparation bundle cannot predate a recorded run."
        });
      }
    }
  });
export type FactoryPreparationBundle = z.infer<typeof factoryPreparationBundleSchema>;

export const factoryPreparationRunRequestSchema = z
  .object({
    schemaVersion: z.literal("agentlab.preparation-run-request.v1"),
    executionId: z.uuid(),
    taskId: z.uuid(),
    requestDigest: sha256DigestSchema,
    authorityDigest: sha256DigestSchema,
    phase: factoryPreparationPhaseSchema,
    attempt: z.number().int().min(1).max(5),
    provider: providerIdSchema,
    model: modelIdSchema,
    reasoning: reasoningIdSchema.nullable(),
    repository: repositoryIdentitySchema,
    skillId: factoryIdentifierSchema,
    skillPackageDigest: sha256DigestSchema,
    promptArtifact: factoryArtifactReferenceSchema,
    inputArtifactDigests: z.array(sha256DigestSchema).min(1).max(16),
    outputSchemaDigest: sha256DigestSchema,
    capabilities: factoryCapabilityGrantSchema,
    budget: factoryBudgetSchema
  })
  .strict()
  .superRefine((request, context) => {
    uniqueValues(request.inputArtifactDigests, context, ["inputArtifactDigests"]);
    if (
      request.capabilities.filesystem !== "read" ||
      request.capabilities.git !== "read" ||
      request.capabilities.remoteRepository !== "none" ||
      request.capabilities.network.mode !== "off" ||
      request.capabilities.secretRefs.length > 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["capabilities"],
        message: "Preparation execution is local, read-only, offline, and receives no secrets."
      });
    }
    if (
      request.budget.maxWorkers !== 1 ||
      request.budget.maxRepairAttempts !== 0 ||
      request.budget.maxChangedFiles !== 0 ||
      request.budget.maxChangedLines !== 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["budget"],
        message: "Preparation execution cannot delegate, repair, or change repository files."
      });
    }
  });
export type FactoryPreparationRunRequest = z.infer<typeof factoryPreparationRunRequestSchema>;

export const factoryPreparationRunRecordSchema = z
  .object({
    schemaVersion: z.literal("agentlab.preparation-run-record.v1"),
    executionId: z.uuid(),
    taskId: z.uuid(),
    requestDigest: sha256DigestSchema,
    authorityDigest: sha256DigestSchema,
    phase: factoryPreparationPhaseSchema,
    attempt: z.number().int().min(1).max(5),
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
        message: "Preparation run cannot finish before it starts."
      });
    }
    if (
      record.status === "succeeded" &&
      (record.exitCode !== 0 ||
        record.errorCode !== null ||
        record.finalOutputArtifact === null ||
        record.outputDocumentArtifact === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "A successful preparation run requires validated final and document artifacts."
      });
    }
    if (
      record.status !== "succeeded" &&
      (record.errorCode === null || record.outputDocumentArtifact !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["errorCode"],
        message: "An unsuccessful preparation run requires an error and no output document."
      });
    }
  });
export type FactoryPreparationRunRecord = z.infer<typeof factoryPreparationRunRecordSchema>;

const activePreparationStateSchema = z.enum([
  "registered",
  "qualifying",
  "qualified",
  "specifying",
  "specified",
  "planning",
  "planned"
]);

const preparationEventCommonShape = {
  schemaVersion: z.literal("agentlab.preparation-event.v1"),
  eventId: z.uuid(),
  taskId: z.uuid(),
  sequence: z.number().int().min(1).max(1_000),
  requestDigest: sha256DigestSchema,
  authorityDigest: sha256DigestSchema,
  previousEventDigest: sha256DigestSchema.nullable(),
  actor: factoryActorSchema,
  occurredAt: factoryTimestampSchema,
  reasonCode: factoryIdentifierSchema,
  summary: requestTitleSchema.nullable(),
  correlationId: z.uuid()
} as const;

const preparationRunLinkShape = {
  phase: factoryPreparationPhaseSchema,
  attempt: z.number().int().min(1).max(5),
  executionId: z.uuid(),
  runRequestDigest: sha256DigestSchema
} as const;

const factoryPreparationEventUnionSchema = z.discriminatedUnion("kind", [
  z
    .object({
      ...preparationEventCommonShape,
      kind: z.literal("registered"),
      from: z.null(),
      to: z.literal("registered")
    })
    .strict(),
  z
    .object({
      ...preparationEventCommonShape,
      ...preparationRunLinkShape,
      kind: z.literal("phase-started"),
      from: activePreparationStateSchema,
      to: activePreparationStateSchema,
      skillId: factoryIdentifierSchema,
      skillPackageDigest: sha256DigestSchema,
      workerProfileId: factoryIdentifierSchema,
      inputArtifactDigests: z.array(sha256DigestSchema).min(1).max(16)
    })
    .strict(),
  z
    .object({
      ...preparationEventCommonShape,
      ...preparationRunLinkShape,
      kind: z.literal("phase-succeeded"),
      from: activePreparationStateSchema,
      to: activePreparationStateSchema,
      runRecordArtifact: factoryArtifactReferenceSchema,
      outputArtifact: factoryArtifactReferenceSchema
    })
    .strict(),
  z
    .object({
      ...preparationEventCommonShape,
      ...preparationRunLinkShape,
      kind: z.literal("phase-failed"),
      from: activePreparationStateSchema,
      to: activePreparationStateSchema,
      runRecordArtifact: factoryArtifactReferenceSchema,
      errorCode: factoryIdentifierSchema
    })
    .strict(),
  z
    .object({
      ...preparationEventCommonShape,
      ...preparationRunLinkShape,
      kind: z.literal("phase-abandoned"),
      from: activePreparationStateSchema,
      to: activePreparationStateSchema
    })
    .strict(),
  z
    .object({
      ...preparationEventCommonShape,
      ...preparationRunLinkShape,
      kind: z.literal("needs-human"),
      from: z.literal("qualifying"),
      to: z.literal("needs-human"),
      runRecordArtifact: factoryArtifactReferenceSchema,
      outputArtifact: factoryArtifactReferenceSchema
    })
    .strict(),
  z
    .object({
      ...preparationEventCommonShape,
      ...preparationRunLinkShape,
      kind: z.literal("rejected"),
      from: z.literal("qualifying"),
      to: z.literal("rejected"),
      runRecordArtifact: factoryArtifactReferenceSchema,
      outputArtifact: factoryArtifactReferenceSchema
    })
    .strict(),
  z
    .object({
      ...preparationEventCommonShape,
      kind: z.literal("prepared"),
      from: z.literal("planned"),
      to: z.literal("prepared"),
      preparationBundleDigest: sha256DigestSchema,
      contractDigest: sha256DigestSchema,
      evidenceBundleDigest: sha256DigestSchema
    })
    .strict(),
  z
    .object({
      ...preparationEventCommonShape,
      kind: z.literal("failed"),
      from: activePreparationStateSchema,
      to: z.literal("failed"),
      errorCode: factoryIdentifierSchema
    })
    .strict(),
  z
    .object({
      ...preparationEventCommonShape,
      kind: z.literal("cancelled"),
      from: activePreparationStateSchema,
      to: z.literal("cancelled")
    })
    .strict(),
  z
    .object({
      ...preparationEventCommonShape,
      kind: z.literal("expired"),
      from: activePreparationStateSchema,
      to: z.literal("expired")
    })
    .strict()
]);

export const factoryPreparationEventSchema = factoryPreparationEventUnionSchema.superRefine(
  (event, context) => {
    if (
      event.kind === "registered" &&
      (event.sequence !== 1 || event.previousEventDigest !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["sequence"],
        message: "Only the first preparation event may register a request."
      });
    }
    if (
      event.kind !== "registered" &&
      (event.sequence === 1 || event.previousEventDigest === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["previousEventDigest"],
        message: "Every later preparation event must link to its predecessor."
      });
    }
    if ("inputArtifactDigests" in event) {
      uniqueValues(event.inputArtifactDigests, context, ["inputArtifactDigests"]);
    }
    if (
      (event.kind === "phase-started" ||
        event.kind === "phase-succeeded" ||
        event.kind === "phase-failed" ||
        event.kind === "phase-abandoned") &&
      !preparationPhaseTransitionMatches(event.phase, event.kind, event.from, event.to)
    ) {
      context.addIssue({
        code: "custom",
        path: ["to"],
        message: "Preparation phase event does not match its deterministic state transition."
      });
    }
    if ((event.kind === "needs-human" || event.kind === "rejected") && event.phase !== "qualify") {
      context.addIssue({
        code: "custom",
        path: ["phase"],
        message: "Only qualification may stop preparation before specification."
      });
    }
    if (
      (event.kind === "phase-succeeded" ||
        event.kind === "needs-human" ||
        event.kind === "rejected") &&
      (event.actor.kind !== "agent" ||
        event.actor.role !== phasePolicy[event.phase].role ||
        event.actor.sessionId === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["actor"],
        message: "A completed preparation phase requires its session-bound agent actor."
      });
    }
  }
);
export type FactoryPreparationEvent = z.infer<typeof factoryPreparationEventSchema>;

const phasePolicy: Readonly<
  Record<
    FactorySkillPhase,
    {
      readonly role: FactoryActorRole;
      readonly from: FactoryTaskState;
      readonly to: FactoryTaskState;
    }
  >
> = {
  qualify: { role: "qualifier", from: "intake", to: "qualified" },
  specify: { role: "specifier", from: "qualified", to: "specified" },
  plan: { role: "planner", from: "specified", to: "planned" },
  implement: { role: "implementer", from: "executing", to: "verifying" },
  verify: { role: "gate-runner", from: "verifying", to: "reviewing" },
  review: { role: "reviewer", from: "reviewing", to: "pr-proposed" },
  repair: { role: "repairer", from: "repairing", to: "verifying" }
};

const preparationTransitions = {
  qualify: { stable: "registered", running: "qualifying", complete: "qualified" },
  specify: { stable: "qualified", running: "specifying", complete: "specified" },
  plan: { stable: "specified", running: "planning", complete: "planned" }
} as const;

function preparationPhaseTransitionMatches(
  phase: FactoryPreparationPhase,
  kind: "phase-started" | "phase-succeeded" | "phase-failed" | "phase-abandoned",
  from: FactoryPreparationState,
  to: FactoryPreparationState
): boolean {
  const transition = preparationTransitions[phase];
  if (kind === "phase-started") return from === transition.stable && to === transition.running;
  if (kind === "phase-succeeded") return from === transition.running && to === transition.complete;
  return from === transition.running && to === transition.stable;
}

function uniqueValues(
  values: readonly string[],
  context: z.RefinementCtx,
  path: readonly PropertyKey[]
): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", path: [...path], message: "Values must be unique." });
  }
}

function skillGraphHasCycle(skills: readonly z.infer<typeof authorizedSkillSchema>[]): boolean {
  const dependencies = new Map(skills.map((skill) => [skill.manifest.id, skill.dependsOn]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return true;
    if (visited.has(id)) return false;
    visiting.add(id);
    for (const dependency of dependencies.get(id) ?? []) {
      if (visit(dependency)) return true;
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return skills.some((skill) => visit(skill.manifest.id));
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function hasAsciiControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

function hasDisallowedNarrativeControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      (codePoint <= 0x1f && codePoint !== 0x09 && codePoint !== 0x0a && codePoint !== 0x0d) ||
      codePoint === 0x7f
    );
  });
}
