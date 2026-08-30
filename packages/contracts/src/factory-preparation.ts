import { z } from "zod";

import {
  evidenceKindSchema,
  factoryActorSchema,
  factoryBudgetSchema,
  factoryCapabilityGrantSchema,
  factoryExecutionRoleSchema,
  factoryIdentifierSchema,
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

export const factoryPreparationAuthoritySchema = z
  .object({
    schemaVersion: z.literal("agentlab.preparation-authority.v1"),
    authorityId: factoryIdentifierSchema,
    version: factorySemanticVersionSchema,
    taskId: z.uuid(),
    requestDigest: sha256DigestSchema,
    supersedesContractDigest: sha256DigestSchema.nullable(),
    issuedAt: factoryTimestampSchema,
    expiresAt: factoryTimestampSchema,
    policyBundleDigest: sha256DigestSchema,
    repository: repositoryIdentitySchema,
    allowedIncludePaths: z.array(repositoryPathPatternSchema).min(1).max(256),
    protectedPaths: z.array(repositoryPathPatternSchema).max(256),
    maximumRiskTier: factoryRiskTierSchema,
    skills: z.array(authorizedSkillSchema).min(4).max(64),
    workerProfiles: z.array(workerProfileSchema).min(1).max(16),
    capabilityCeiling: factoryCapabilityGrantSchema,
    budgetCeiling: factoryBudgetSchema,
    evidenceFloor: z.array(evidenceKindSchema).max(32),
    approvalRoles: approvalRolesSchema,
    maximumContractLifetimeSeconds: z.number().int().min(60).max(604_800)
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
    uniqueValues(authority.allowedIncludePaths, context, ["allowedIncludePaths"]);
    uniqueValues(authority.protectedPaths, context, ["protectedPaths"]);
    uniqueValues(authority.evidenceFloor, context, ["evidenceFloor"]);
    uniqueValues(
      authority.workerProfiles.map((profile) => profile.id),
      context,
      ["workerProfiles"]
    );
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
  });
export type FactoryPreparationAuthority = z.infer<typeof factoryPreparationAuthoritySchema>;

const preparationRunSchema = z
  .object({
    phase: z.enum(["qualify", "specify", "plan"]),
    skillId: factoryIdentifierSchema,
    skillPackageDigest: sha256DigestSchema,
    actor: factoryActorSchema,
    startedAt: factoryTimestampSchema,
    finishedAt: factoryTimestampSchema,
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
    schemaVersion: z.literal("agentlab.preparation-bundle.v1"),
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
