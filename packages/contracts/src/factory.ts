import { z } from "zod";

import { modelIdSchema, providerIdSchema, reasoningIdSchema } from "./provider.js";

export const sha256DigestSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/u, "Expected a lowercase SHA-256 content digest.");
export type Sha256Digest = z.infer<typeof sha256DigestSchema>;

export const gitObjectIdSchema = z
  .string()
  .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u, "Expected an exact Git object identifier.");
export type GitObjectId = z.infer<typeof gitObjectIdSchema>;

/** Canonical UTC timestamp used anywhere lexical ordering or hashing must remain deterministic. */
export const factoryTimestampSchema = z.iso.datetime({ precision: 3 });

const factoryIdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._/-]*$/u, "Expected a stable lowercase identifier.");

const semanticVersionSchema = z
  .string()
  .max(80)
  .regex(
    /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u,
    "Expected a semantic version."
  );

export const repositoryPathPatternSchema = z
  .string()
  .min(1)
  .max(1_024)
  .refine(
    (path) =>
      !path.startsWith("/") &&
      !path.startsWith("./") &&
      !path.includes("\\") &&
      !path.includes("\0") &&
      path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
    "Expected a normalized repository-relative path or glob."
  )
  .refine(
    (path) => path.split("/").every((segment) => !segment.includes("**") || segment === "**"),
    "A recursive wildcard must occupy a complete path segment."
  );

export const repositoryRelativePathSchema = repositoryPathPatternSchema.refine(
  (path) => !path.includes("*"),
  "A concrete repository path cannot contain wildcards."
);

const boundedTextSchema = z.string().trim().min(1).max(4_096);
const shortTextSchema = z.string().trim().min(1).max(500);

function hasAsciiControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}

export const factoryTaskStateSchema = z.enum([
  "intake",
  "qualified",
  "specified",
  "planned",
  "awaiting-execution-approval",
  "queued",
  "executing",
  "verifying",
  "reviewing",
  "repairing",
  "pr-proposed",
  "pr-open",
  "merge-ready",
  "awaiting-merge-approval",
  "merge-queued",
  "merged",
  "canary",
  "released",
  "observing",
  "completed",
  "needs-attention",
  "rejected",
  "cancelled",
  "expired",
  "failed",
  "quarantined",
  "rolled-back"
]);
export type FactoryTaskState = z.infer<typeof factoryTaskStateSchema>;

export const factoryRiskTierSchema = z.enum(["R0", "R1", "R2", "R3", "R4"]);
export type FactoryRiskTier = z.infer<typeof factoryRiskTierSchema>;

export const factoryActorRoleSchema = z.enum([
  "requester",
  "qualifier",
  "specifier",
  "planner",
  "implementer",
  "repairer",
  "reviewer",
  "gate-runner",
  "policy-engine",
  "pr-broker",
  "merger",
  "release-controller",
  "incident-commander"
]);
export type FactoryActorRole = z.infer<typeof factoryActorRoleSchema>;

export const factoryActorSchema = z
  .object({
    kind: z.enum(["human", "agent", "control-plane", "ci", "broker"]),
    role: factoryActorRoleSchema,
    id: factoryIdentifierSchema,
    sessionId: z.string().trim().min(1).max(256).nullable()
  })
  .strict();
export type FactoryActor = z.infer<typeof factoryActorSchema>;

const networkCapabilitySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("off") }).strict(),
  z
    .object({
      mode: z.literal("allowlist"),
      hosts: z
        .array(
          z
            .string()
            .min(1)
            .max(253)
            .refine(
              (host) =>
                !host.includes("://") &&
                !host.includes("/") &&
                !host.includes("\0") &&
                !host.startsWith("."),
              "Expected a hostname, not a URL."
            )
        )
        .min(1)
        .max(64)
    })
    .strict()
    .superRefine((network, context) => {
      if (new Set(network.hosts).size !== network.hosts.length) {
        context.addIssue({ code: "custom", path: ["hosts"], message: "Hosts must be unique." });
      }
    })
]);

export const factoryCapabilityGrantSchema = z
  .object({
    filesystem: z.enum(["none", "read", "workspace-write"]),
    git: z.enum(["none", "read", "worktree-write"]),
    remoteRepository: z.enum(["none", "read"]),
    process: z.enum(["none", "sandboxed"]),
    network: networkCapabilitySchema,
    commandAllowlist: z
      .array(
        z
          .string()
          .min(1)
          .max(128)
          .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/u, "Expected an executable name, not a command.")
      )
      .max(128),
    secretRefs: z.array(factoryIdentifierSchema).max(32)
  })
  .strict()
  .superRefine((grant, context) => {
    for (const [path, values] of [
      ["commandAllowlist", grant.commandAllowlist],
      ["secretRefs", grant.secretRefs]
    ] as const) {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: "custom",
          path: [path],
          message: `${path} values must be unique.`
        });
      }
    }
    if (grant.filesystem === "none" && grant.git !== "none") {
      context.addIssue({
        code: "custom",
        path: ["git"],
        message: "Git capability requires filesystem access."
      });
    }
    if ((grant.filesystem === "workspace-write") !== (grant.git === "worktree-write")) {
      context.addIssue({
        code: "custom",
        path: ["git"],
        message: "Workspace writes and worktree writes must be granted together."
      });
    }
    if (grant.process === "none" && grant.commandAllowlist.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["commandAllowlist"],
        message: "Commands cannot be granted when process execution is disabled."
      });
    }
  });
export type FactoryCapabilityGrant = z.infer<typeof factoryCapabilityGrantSchema>;

export const factoryBudgetSchema = z
  .object({
    wallClockSeconds: z.number().int().min(1).max(86_400),
    maxAgentTurns: z.number().int().min(1).max(2_000),
    maxToolCalls: z.number().int().min(1).max(20_000),
    maxInputTokens: z.number().int().min(1).max(100_000_000),
    maxOutputTokens: z.number().int().min(1).max(10_000_000),
    maxCostMicrousd: z.number().int().min(0).max(10_000_000_000),
    maxProcesses: z.number().int().min(1).max(512),
    maxOutputBytes: z.number().int().min(1).max(1_073_741_824),
    maxWorkers: z.number().int().min(1).max(32),
    maxRepairAttempts: z.number().int().min(0).max(20),
    maxChangedFiles: z.number().int().min(0).max(10_000),
    maxChangedLines: z.number().int().min(0).max(1_000_000)
  })
  .strict();
export type FactoryBudget = z.infer<typeof factoryBudgetSchema>;

export const factoryBudgetUsageSchema = z
  .object({
    wallClockSeconds: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    agentTurns: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    toolCalls: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    inputTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    outputTokens: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    costMicrousd: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    processes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    outputBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    workers: z.number().int().min(0).max(32),
    repairAttempts: z.number().int().min(0).max(20),
    changedFiles: z.number().int().min(0).max(10_000),
    changedLines: z.number().int().min(0).max(1_000_000)
  })
  .strict();
export type FactoryBudgetUsage = z.infer<typeof factoryBudgetUsageSchema>;

/** Kernel-enforced instantaneous ceilings. Cumulative task accounting remains in FactoryBudget. */
export const factoryResourceLimitsSchema = z
  .object({
    maxProcesses: z.number().int().min(1).max(512),
    maxMemoryBytes: z
      .number()
      .int()
      .min(64 * 1_024 * 1_024)
      .max(64 * 1_024 * 1_024 * 1_024),
    cpuQuotaPercent: z.number().int().min(1).max(3_200)
  })
  .strict();
export type FactoryResourceLimits = z.infer<typeof factoryResourceLimitsSchema>;

export const factoryProcessIsolationSchema = z
  .object({
    isolationId: z.uuid(),
    mechanism: z
      .object({
        id: factoryIdentifierSchema,
        version: z.string().trim().min(1).max(180)
      })
      .strict(),
    scopeName: z
      .string()
      .regex(
        /^agentlab-factory-[0-9a-f]{32}\.scope$/u,
        "Expected an AgentLab-owned transient scope name."
      ),
    limits: factoryResourceLimitsSchema
  })
  .strict();
export type FactoryProcessIsolation = z.infer<typeof factoryProcessIsolationSchema>;

export const evidenceKindSchema = z.enum([
  "request",
  "contract",
  "skill",
  "execution",
  "usage",
  "command",
  "test",
  "build",
  "security",
  "review",
  "policy",
  "patch",
  "pull-request",
  "merge",
  "sbom",
  "provenance",
  "release",
  "canary",
  "rollback",
  "incident"
]);
export type EvidenceKind = z.infer<typeof evidenceKindSchema>;

const skillTriggerSchema = z.enum(["manual", "intake", "scheduled", "policy", "failure"]);

const skillManifestBaseSchema = z
  .object({
    schemaVersion: z.literal("agentlab.skill-manifest.v1"),
    id: factoryIdentifierSchema,
    version: semanticVersionSchema,
    packageDigest: sha256DigestSchema,
    instructionPath: repositoryRelativePathSchema,
    description: shortTextSchema,
    roles: z.array(factoryActorRoleSchema).min(1).max(16),
    triggers: z.array(skillTriggerSchema).min(1).max(5),
    inputSchemaDigest: sha256DigestSchema.nullable(),
    outputSchemaDigest: sha256DigestSchema.nullable(),
    requestedCapabilities: factoryCapabilityGrantSchema,
    riskCeiling: factoryRiskTierSchema,
    allowedFromStates: z.array(factoryTaskStateSchema).min(1).max(27),
    allowedToStates: z.array(factoryTaskStateSchema).min(1).max(27),
    providerCompatibility: z.discriminatedUnion("mode", [
      z.object({ mode: z.literal("any-supported") }).strict(),
      z
        .object({
          mode: z.literal("allowlist"),
          providers: z.array(providerIdSchema).min(1).max(3)
        })
        .strict()
    ]),
    budgetCeiling: factoryBudgetSchema,
    requiredEvidence: z.array(evidenceKindSchema).min(1).max(20),
    dependencyDigests: z.array(sha256DigestSchema).max(64)
  })
  .strict();

const skillManifestPackageBodySchema = skillManifestBaseSchema.omit({ packageDigest: true });

function refineSkillManifest(
  manifest: z.infer<typeof skillManifestPackageBodySchema>,
  context: z.RefinementCtx
): void {
  for (const [path, values] of [
    ["roles", manifest.roles],
    ["triggers", manifest.triggers],
    ["allowedFromStates", manifest.allowedFromStates],
    ["allowedToStates", manifest.allowedToStates],
    ["requiredEvidence", manifest.requiredEvidence],
    ["dependencyDigests", manifest.dependencyDigests]
  ] as const) {
    if (new Set(values).size !== values.length) {
      context.addIssue({
        code: "custom",
        path: [path],
        message: `${path} values must be unique.`
      });
    }
  }
  if (
    manifest.providerCompatibility.mode === "allowlist" &&
    new Set(manifest.providerCompatibility.providers).size !==
      manifest.providerCompatibility.providers.length
  ) {
    context.addIssue({
      code: "custom",
      path: ["providerCompatibility", "providers"],
      message: "Providers must be unique."
    });
  }
}

export const skillManifestSchema = skillManifestBaseSchema.superRefine(refineSkillManifest);
export type SkillManifest = z.infer<typeof skillManifestSchema>;

const factorySkillFileSchema = z.string().max(512 * 1_024);

/** Canonical package payload. Its artifact digest becomes the manifest packageDigest. */
export const factorySkillPackageSchema = z
  .object({
    schemaVersion: z.literal("agentlab.skill-package.v1"),
    manifest: skillManifestPackageBodySchema.superRefine(refineSkillManifest),
    files: z.record(repositoryRelativePathSchema, factorySkillFileSchema)
  })
  .strict()
  .superRefine((skillPackage, context) => {
    const entries = Object.entries(skillPackage.files);
    if (entries.length === 0 || entries.length > 128) {
      context.addIssue({
        code: "custom",
        path: ["files"],
        message: "A skill package requires between one and 128 files."
      });
    }
    if (!(skillPackage.manifest.instructionPath in skillPackage.files)) {
      context.addIssue({
        code: "custom",
        path: ["files"],
        message: "The declared instruction file must be included in the package."
      });
    }
    const totalCharacters = entries.reduce(
      (total, [path, content]) => total + path.length + content.length,
      0
    );
    if (totalCharacters > 4 * 1_024 * 1_024) {
      context.addIssue({
        code: "custom",
        path: ["files"],
        message: "Skill package text exceeds four million characters."
      });
    }
  });
export type FactorySkillPackage = z.infer<typeof factorySkillPackageSchema>;

const approvalRequirementSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("automatic") }).strict(),
  z
    .object({
      mode: z.literal("human"),
      minimumApprovals: z.number().int().min(1).max(5),
      roles: z.array(factoryIdentifierSchema).min(1).max(16)
    })
    .strict()
    .superRefine((approval, context) => {
      if (new Set(approval.roles).size !== approval.roles.length) {
        context.addIssue({ code: "custom", path: ["roles"], message: "Roles must be unique." });
      }
    }),
  z.object({ mode: z.literal("forbidden") }).strict()
]);

export const factoryApprovalPolicySchema = z
  .object({
    execution: approvalRequirementSchema,
    pullRequestCreation: approvalRequirementSchema,
    merge: approvalRequirementSchema,
    release: approvalRequirementSchema
  })
  .strict();
export type FactoryApprovalPolicy = z.infer<typeof factoryApprovalPolicySchema>;

export const factoryExecutionRoleSchema = z.enum(["implementer", "repairer", "reviewer"]);
export type FactoryExecutionRole = z.infer<typeof factoryExecutionRoleSchema>;

const skillPlanEntrySchema = z
  .object({
    id: factoryIdentifierSchema,
    version: semanticVersionSchema,
    packageDigest: sha256DigestSchema,
    phase: z.enum(["qualify", "specify", "plan", "implement", "verify", "review", "repair"]),
    dependsOn: z.array(factoryIdentifierSchema).max(64)
  })
  .strict();

function skillPlanHasCycle(skills: readonly z.infer<typeof skillPlanEntrySchema>[]): boolean {
  const dependencies = new Map(skills.map((skill) => [skill.id, skill.dependsOn]));
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
  return skills.some((skill) => visit(skill.id));
}

export const immutableTaskContractSchema = z
  .object({
    schemaVersion: z.literal("agentlab.task-contract.v1"),
    taskId: z.uuid(),
    conversationId: z.uuid(),
    supersedesContractDigest: sha256DigestSchema.nullable(),
    createdAt: factoryTimestampSchema,
    expiresAt: factoryTimestampSchema,
    deduplicationKey: sha256DigestSchema,
    repository: z
      .object({
        id: factoryIdentifierSchema,
        baseRevision: gitObjectIdSchema
      })
      .strict(),
    requestSources: z
      .array(
        z
          .object({
            kind: z.enum(["local", "github-issue", "github-pull-request", "other"]),
            ref: z.string().trim().min(1).max(2_048)
          })
          .strict()
      )
      .min(1)
      .max(32),
    trigger: z.enum(["manual", "scheduled", "webhook"]),
    objective: boundedTextSchema,
    acceptanceCriteria: z.array(boundedTextSchema).min(1).max(50),
    nonGoals: z.array(boundedTextSchema).max(50),
    scope: z
      .object({
        includePaths: z.array(repositoryPathPatternSchema).min(1).max(256),
        excludePaths: z.array(repositoryPathPatternSchema).max(256),
        protectedPaths: z.array(repositoryPathPatternSchema).max(256)
      })
      .strict(),
    riskTier: factoryRiskTierSchema,
    skillPlan: z.array(skillPlanEntrySchema).min(1).max(64),
    agentPolicy: z
      .object({
        allowedProviders: z.array(providerIdSchema).min(1).max(3),
        workerProfiles: z
          .array(
            z
              .object({
                id: factoryIdentifierSchema,
                roles: z.array(factoryExecutionRoleSchema).min(1).max(3),
                provider: providerIdSchema,
                model: modelIdSchema,
                reasoning: reasoningIdSchema.nullable()
              })
              .strict()
              .superRefine((profile, profileContext) => {
                if (new Set(profile.roles).size !== profile.roles.length) {
                  profileContext.addIssue({
                    code: "custom",
                    path: ["roles"],
                    message: "Worker profile roles must be unique."
                  });
                }
              })
          )
          .min(1)
          .max(16),
        minimumIndependentReviews: z.number().int().min(0).max(5),
        requireDistinctReviewSession: z.boolean()
      })
      .strict(),
    capabilities: factoryCapabilityGrantSchema,
    budget: factoryBudgetSchema,
    gateProfile: z
      .object({
        id: factoryIdentifierSchema,
        version: semanticVersionSchema,
        policyDigest: sha256DigestSchema
      })
      .strict(),
    requiredEvidence: z.array(evidenceKindSchema).min(1).max(20),
    approvals: factoryApprovalPolicySchema
  })
  .strict()
  .superRefine((contract, context) => {
    if (contract.expiresAt <= contract.createdAt) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Contract expiry must be later than creation."
      });
    }
    for (const [path, values] of [
      ["requestSources", contract.requestSources.map((source) => `${source.kind}:${source.ref}`)],
      ["acceptanceCriteria", contract.acceptanceCriteria],
      ["nonGoals", contract.nonGoals],
      ["includePaths", contract.scope.includePaths],
      ["excludePaths", contract.scope.excludePaths],
      ["protectedPaths", contract.scope.protectedPaths],
      ["allowedProviders", contract.agentPolicy.allowedProviders],
      ["workerProfiles", contract.agentPolicy.workerProfiles.map(({ id }) => id)],
      ["requiredEvidence", contract.requiredEvidence]
    ] as const) {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: "custom",
          path: [path],
          message: `${path} values must be unique.`
        });
      }
    }
    const skillIds = new Set(contract.skillPlan.map((skill) => skill.id));
    if (skillIds.size !== contract.skillPlan.length) {
      context.addIssue({
        code: "custom",
        path: ["skillPlan"],
        message: "Skill IDs must be unique."
      });
    }
    for (const [index, skill] of contract.skillPlan.entries()) {
      if (new Set(skill.dependsOn).size !== skill.dependsOn.length) {
        context.addIssue({
          code: "custom",
          path: ["skillPlan", index, "dependsOn"],
          message: "Skill dependencies must be unique."
        });
      }
      for (const dependency of skill.dependsOn) {
        if (!skillIds.has(dependency)) {
          context.addIssue({
            code: "custom",
            path: ["skillPlan", index, "dependsOn"],
            message: `Unknown skill dependency ${dependency}.`
          });
        }
      }
    }
    if (skillPlanHasCycle(contract.skillPlan)) {
      context.addIssue({
        code: "custom",
        path: ["skillPlan"],
        message: "Skill plan must be acyclic."
      });
    }
    if (
      contract.capabilities.filesystem === "workspace-write" &&
      (contract.agentPolicy.minimumIndependentReviews < 1 ||
        !contract.agentPolicy.requireDistinctReviewSession)
    ) {
      context.addIssue({
        code: "custom",
        path: ["agentPolicy"],
        message: "Workspace-writing tasks require an independent review in a distinct session."
      });
    }
    for (const [index, profile] of contract.agentPolicy.workerProfiles.entries()) {
      if (!contract.agentPolicy.allowedProviders.includes(profile.provider)) {
        context.addIssue({
          code: "custom",
          path: ["agentPolicy", "workerProfiles", index, "provider"],
          message: "Worker profile provider must be allowed by the task."
        });
      }
    }
    if (
      contract.capabilities.filesystem === "workspace-write" &&
      !contract.agentPolicy.workerProfiles.some(({ roles }) => roles.includes("implementer"))
    ) {
      context.addIssue({
        code: "custom",
        path: ["agentPolicy", "workerProfiles"],
        message: "A writing task requires a pinned implementer profile."
      });
    }
    const reviewerProfiles = contract.agentPolicy.workerProfiles.filter(({ roles }) =>
      roles.includes("reviewer")
    );
    if (reviewerProfiles.length < contract.agentPolicy.minimumIndependentReviews) {
      context.addIssue({
        code: "custom",
        path: ["agentPolicy", "workerProfiles"],
        message: "Task requires enough pinned independent reviewer profiles."
      });
    }
    if (
      contract.budget.maxRepairAttempts > 0 &&
      !contract.agentPolicy.workerProfiles.some(({ roles }) => roles.includes("repairer"))
    ) {
      context.addIssue({
        code: "custom",
        path: ["agentPolicy", "workerProfiles"],
        message: "A repair budget requires a pinned repairer profile."
      });
    }
    if (
      contract.riskTier === "R0" &&
      (contract.capabilities.filesystem === "workspace-write" ||
        contract.capabilities.git === "worktree-write")
    ) {
      context.addIssue({
        code: "custom",
        path: ["capabilities"],
        message: "R0 tasks are read-only."
      });
    }
  });
export type ImmutableTaskContract = z.infer<typeof immutableTaskContractSchema>;

export const taskEventSchema = z
  .object({
    schemaVersion: z.literal("agentlab.task-event.v1"),
    eventId: z.uuid(),
    taskId: z.uuid(),
    sequence: z.number().int().min(1),
    contractDigest: sha256DigestSchema,
    previousEventDigest: sha256DigestSchema.nullable(),
    from: factoryTaskStateSchema.nullable(),
    to: factoryTaskStateSchema,
    actor: factoryActorSchema,
    occurredAt: factoryTimestampSchema,
    reasonCode: factoryIdentifierSchema,
    summary: shortTextSchema.nullable(),
    evidenceBundleDigest: sha256DigestSchema.nullable(),
    correlationId: z.uuid()
  })
  .strict()
  .superRefine((event, context) => {
    if (
      event.sequence === 1 &&
      (event.previousEventDigest !== null || event.from !== null || event.to !== "intake")
    ) {
      context.addIssue({
        code: "custom",
        path: ["previousEventDigest"],
        message: "Only sequence one may initialize a task, and it must initialize intake."
      });
    }
    if (event.sequence > 1 && (event.previousEventDigest === null || event.from === null)) {
      context.addIssue({
        code: "custom",
        path: ["previousEventDigest"],
        message: "Every later event must link to its predecessor and previous state."
      });
    }
  });
export type TaskEvent = z.infer<typeof taskEventSchema>;

export const factoryApprovalStageSchema = z.enum([
  "execution",
  "pull-request-creation",
  "merge",
  "release"
]);
export type FactoryApprovalStage = z.infer<typeof factoryApprovalStageSchema>;

export const factoryApprovalRecordSchema = z
  .object({
    schemaVersion: z.literal("agentlab.approval-record.v1"),
    approvalId: z.uuid(),
    stage: factoryApprovalStageSchema,
    decision: z.enum(["approved", "rejected"]),
    subjectDigest: sha256DigestSchema,
    actor: factoryActorSchema,
    authorityRoles: z.array(factoryIdentifierSchema).min(1).max(16),
    occurredAt: factoryTimestampSchema,
    reason: shortTextSchema
  })
  .strict()
  .superRefine((approval, context) => {
    if (approval.actor.kind !== "human") {
      context.addIssue({
        code: "custom",
        path: ["actor"],
        message: "A factory approval record requires a human actor."
      });
    }
    if (new Set(approval.authorityRoles).size !== approval.authorityRoles.length) {
      context.addIssue({
        code: "custom",
        path: ["authorityRoles"],
        message: "Approval authority roles must be unique."
      });
    }
  });
export type FactoryApprovalRecord = z.infer<typeof factoryApprovalRecordSchema>;

export const factoryChangeSetSchema = z
  .object({
    baseRevision: gitObjectIdSchema,
    headRevision: gitObjectIdSchema.nullable(),
    changedPaths: z.array(repositoryRelativePathSchema).max(10_000),
    binaryPaths: z.array(repositoryRelativePathSchema).max(10_000),
    changedFiles: z.number().int().min(0).max(10_000),
    changedLines: z.number().int().min(0).max(1_000_000)
  })
  .strict()
  .superRefine((changeSet, context) => {
    if (new Set(changeSet.changedPaths).size !== changeSet.changedPaths.length) {
      context.addIssue({
        code: "custom",
        path: ["changedPaths"],
        message: "Changed paths must be unique."
      });
    }
    if (new Set(changeSet.binaryPaths).size !== changeSet.binaryPaths.length) {
      context.addIssue({
        code: "custom",
        path: ["binaryPaths"],
        message: "Binary paths must be unique."
      });
    }
    const changedPaths = new Set(changeSet.changedPaths);
    if (changeSet.binaryPaths.some((path) => !changedPaths.has(path))) {
      context.addIssue({
        code: "custom",
        path: ["binaryPaths"],
        message: "Every binary path must also be present in changed paths."
      });
    }
    if (changeSet.changedFiles !== changeSet.changedPaths.length) {
      context.addIssue({
        code: "custom",
        path: ["changedFiles"],
        message: "Changed file count must equal the concrete path inventory."
      });
    }
  });
export type FactoryChangeSet = z.infer<typeof factoryChangeSetSchema>;

export const factoryPolicyCheckInputSchema = z
  .object({
    taskId: z.uuid(),
    stage: factoryApprovalStageSchema,
    approvalSubjectDigest: sha256DigestSchema,
    currentBaseRevision: gitObjectIdSchema,
    changeSet: factoryChangeSetSchema,
    usage: factoryBudgetUsageSchema,
    usageComplete: z.boolean(),
    approvals: z.array(factoryApprovalRecordSchema).max(32),
    scheduled: z.boolean()
  })
  .strict();
export type FactoryPolicyCheckInput = z.infer<typeof factoryPolicyCheckInputSchema>;

export const factoryPolicyOutcomeSchema = z.enum(["allow", "deny", "needs-human"]);
export type FactoryPolicyOutcome = z.infer<typeof factoryPolicyOutcomeSchema>;

export const factoryPolicyDecisionSchema = z
  .object({
    outcome: factoryPolicyOutcomeSchema,
    effectiveRiskTier: factoryRiskTierSchema,
    profileId: factoryIdentifierSchema,
    reasonCodes: z.array(factoryIdentifierSchema).max(256),
    requiredGateIds: z.array(factoryIdentifierSchema).max(256),
    requiredEvidence: z.array(evidenceKindSchema).max(20),
    requiredHumanApprovals: z.number().int().min(0).max(5),
    satisfiedHumanApprovals: z.number().int().min(0).max(32)
  })
  .strict()
  .superRefine((decision, context) => {
    for (const [path, values] of [
      ["reasonCodes", decision.reasonCodes],
      ["requiredGateIds", decision.requiredGateIds],
      ["requiredEvidence", decision.requiredEvidence]
    ] as const) {
      if (new Set(values).size !== values.length) {
        context.addIssue({
          code: "custom",
          path: [path],
          message: `${path} values must be unique.`
        });
      }
    }
  });
export type FactoryPolicyDecision = z.infer<typeof factoryPolicyDecisionSchema>;

export const factoryPolicyEvaluationRecordSchema = z
  .object({
    schemaVersion: z.literal("agentlab.policy-evaluation.v1"),
    taskId: z.uuid(),
    contractDigest: sha256DigestSchema,
    policyBundleDigest: sha256DigestSchema,
    stage: factoryApprovalStageSchema,
    approvalSubjectDigest: sha256DigestSchema,
    evaluatedAt: factoryTimestampSchema,
    currentBaseRevision: gitObjectIdSchema,
    changeSet: factoryChangeSetSchema,
    usage: factoryBudgetUsageSchema,
    usageComplete: z.boolean(),
    evidenceBundleDigests: z.array(sha256DigestSchema).max(1_024),
    approvals: z.array(factoryApprovalRecordSchema).max(32),
    authority: z
      .object({
        scheduler: z.boolean(),
        prBroker: z.boolean()
      })
      .strict(),
    scheduled: z.boolean(),
    decision: factoryPolicyDecisionSchema
  })
  .strict()
  .superRefine((record, context) => {
    if (new Set(record.evidenceBundleDigests).size !== record.evidenceBundleDigests.length) {
      context.addIssue({
        code: "custom",
        path: ["evidenceBundleDigests"],
        message: "Evidence bundle digests must be unique."
      });
    }
  });
export type FactoryPolicyEvaluationRecord = z.infer<typeof factoryPolicyEvaluationRecordSchema>;

export const factoryControlNameSchema = z.enum(["scheduler", "pr-broker"]);
export type FactoryControlName = z.infer<typeof factoryControlNameSchema>;

export const factoryControlEventSchema = z
  .object({
    schemaVersion: z.literal("agentlab.control-event.v1"),
    eventId: z.uuid(),
    control: factoryControlNameSchema,
    enabled: z.boolean(),
    actor: factoryActorSchema,
    occurredAt: factoryTimestampSchema,
    reason: shortTextSchema
  })
  .strict()
  .superRefine((event, context) => {
    if (event.enabled && event.actor.kind !== "human") {
      context.addIssue({
        code: "custom",
        path: ["actor"],
        message: "Only a human actor may enable a factory authority control."
      });
    }
  });
export type FactoryControlEvent = z.infer<typeof factoryControlEventSchema>;

export const factoryArtifactReferenceSchema = z
  .object({
    digest: sha256DigestSchema,
    mediaType: z.string().trim().min(1).max(255),
    sizeBytes: z.number().int().min(0).max(10_737_418_240)
  })
  .strict();

export const evidenceItemSchema = z
  .object({
    id: z.uuid(),
    kind: evidenceKindSchema,
    result: z.enum(["pass", "fail", "informational"]),
    subjectDigest: sha256DigestSchema,
    artifact: factoryArtifactReferenceSchema,
    producer: factoryActorSchema,
    createdAt: factoryTimestampSchema,
    claims: z
      .array(
        z
          .object({
            name: factoryIdentifierSchema,
            value: z.string().max(4_096)
          })
          .strict()
      )
      .max(128)
  })
  .strict()
  .superRefine((item, context) => {
    const names = item.claims.map((claim) => claim.name);
    if (new Set(names).size !== names.length) {
      context.addIssue({
        code: "custom",
        path: ["claims"],
        message: "Claim names must be unique."
      });
    }
  });
export type EvidenceItem = z.infer<typeof evidenceItemSchema>;

const evidenceAttestationSchema = z
  .object({
    statementDigest: sha256DigestSchema,
    predicateType: z.url().max(2_048),
    issuer: z.string().trim().min(1).max(2_048),
    subject: z.string().trim().min(1).max(2_048),
    transparencyLogUrl: z.url().max(2_048).nullable()
  })
  .strict();

export const evidenceBundleSchema = z
  .object({
    schemaVersion: z.literal("agentlab.evidence-bundle.v1"),
    bundleId: z.uuid(),
    taskId: z.uuid(),
    sequence: z.number().int().min(1),
    contractDigest: sha256DigestSchema,
    previousBundleDigest: sha256DigestSchema.nullable(),
    policyBundleDigest: sha256DigestSchema,
    createdAt: factoryTimestampSchema,
    items: z.array(evidenceItemSchema).min(1).max(1_000),
    attestations: z.array(evidenceAttestationSchema).max(128)
  })
  .strict()
  .superRefine((bundle, context) => {
    if (bundle.sequence === 1 && bundle.previousBundleDigest !== null) {
      context.addIssue({
        code: "custom",
        path: ["previousBundleDigest"],
        message: "The first evidence bundle cannot reference a predecessor."
      });
    }
    if (bundle.sequence > 1 && bundle.previousBundleDigest === null) {
      context.addIssue({
        code: "custom",
        path: ["previousBundleDigest"],
        message: "Later evidence bundles must link to their predecessor."
      });
    }
    const itemIds = bundle.items.map((item) => item.id);
    if (new Set(itemIds).size !== itemIds.length) {
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: "Evidence item IDs must be unique."
      });
    }
  });
export type EvidenceBundle = z.infer<typeof evidenceBundleSchema>;

export const factoryAgentRunRequestSchema = z
  .object({
    schemaVersion: z.literal("agentlab.agent-run-request.v1"),
    executionId: z.uuid(),
    taskId: z.uuid(),
    contractDigest: sha256DigestSchema,
    role: factoryExecutionRoleSchema,
    attempt: z.number().int().min(1).max(20),
    provider: providerIdSchema,
    model: modelIdSchema.nullable(),
    reasoning: reasoningIdSchema.nullable(),
    repository: z
      .object({
        id: factoryIdentifierSchema,
        baseRevision: gitObjectIdSchema
      })
      .strict(),
    promptArtifact: factoryArtifactReferenceSchema,
    outputSchemaDigest: sha256DigestSchema.nullable(),
    skillDigests: z.array(sha256DigestSchema).min(1).max(64),
    capabilities: factoryCapabilityGrantSchema,
    budget: factoryBudgetSchema
  })
  .strict()
  .superRefine((request, context) => {
    if (new Set(request.skillDigests).size !== request.skillDigests.length) {
      context.addIssue({
        code: "custom",
        path: ["skillDigests"],
        message: "Execution skill digests must be unique."
      });
    }
    if (
      request.role === "reviewer" &&
      (request.capabilities.filesystem === "workspace-write" ||
        request.capabilities.git === "worktree-write")
    ) {
      context.addIssue({
        code: "custom",
        path: ["capabilities"],
        message: "Independent reviewers are read-only."
      });
    }
    if (
      (request.role === "implementer" || request.role === "repairer") &&
      request.capabilities.filesystem !== "workspace-write"
    ) {
      context.addIssue({
        code: "custom",
        path: ["capabilities"],
        message: "Implementation and repair runs require isolated workspace write."
      });
    }
  });
export type FactoryAgentRunRequest = z.infer<typeof factoryAgentRunRequestSchema>;

export const factoryAgentRunStatusSchema = z.enum([
  "succeeded",
  "failed",
  "timed-out",
  "cancelled"
]);
export type FactoryAgentRunStatus = z.infer<typeof factoryAgentRunStatusSchema>;

export const factoryAgentRunRecordSchema = z
  .object({
    schemaVersion: z.literal("agentlab.agent-run-record.v1"),
    executionId: z.uuid(),
    taskId: z.uuid(),
    contractDigest: sha256DigestSchema,
    role: factoryExecutionRoleSchema,
    attempt: z.number().int().min(1).max(20),
    provider: providerIdSchema,
    providerVersion: z.string().trim().min(1).max(180),
    harnessVersion: z.string().trim().min(1).max(180),
    model: modelIdSchema.nullable(),
    reasoning: reasoningIdSchema.nullable(),
    providerSessionId: z.string().trim().min(1).max(256).nullable(),
    status: factoryAgentRunStatusSchema,
    startedAt: factoryTimestampSchema,
    finishedAt: factoryTimestampSchema,
    exitCode: z.number().int().min(0).max(255).nullable(),
    stdoutArtifact: factoryArtifactReferenceSchema,
    stderrArtifact: factoryArtifactReferenceSchema,
    finalOutputArtifact: factoryArtifactReferenceSchema.nullable(),
    usage: factoryBudgetUsageSchema,
    usageComplete: z.boolean(),
    errorCode: factoryIdentifierSchema.nullable()
  })
  .strict()
  .superRefine((record, context) => {
    if (record.finishedAt < record.startedAt) {
      context.addIssue({
        code: "custom",
        path: ["finishedAt"],
        message: "Agent run cannot finish before it starts."
      });
    }
    if (record.status === "succeeded" && (record.exitCode !== 0 || record.errorCode !== null)) {
      context.addIssue({
        code: "custom",
        path: ["status"],
        message: "A successful agent run requires exit code zero and no error code."
      });
    }
    if (record.status !== "succeeded" && record.errorCode === null) {
      context.addIssue({
        code: "custom",
        path: ["errorCode"],
        message: "An unsuccessful agent run requires a stable error code."
      });
    }
  });
export type FactoryAgentRunRecord = z.infer<typeof factoryAgentRunRecordSchema>;

export const factoryTaskUsageRecordSchema = z
  .object({
    schemaVersion: z.literal("agentlab.task-usage-record.v1"),
    taskId: z.uuid(),
    contractDigest: sha256DigestSchema,
    patchProposalDigest: sha256DigestSchema,
    usage: factoryBudgetUsageSchema,
    complete: z.boolean(),
    calculatedAt: factoryTimestampSchema
  })
  .strict();
export type FactoryTaskUsageRecord = z.infer<typeof factoryTaskUsageRecordSchema>;

export const factoryGateObservationSchema = z
  .object({
    schemaVersion: z.literal("agentlab.gate-observation.v1"),
    gateId: factoryIdentifierSchema,
    taskId: z.uuid(),
    contractDigest: sha256DigestSchema,
    baseRevision: gitObjectIdSchema,
    result: z.enum(["pass", "fail", "error", "timed-out"]),
    command: z
      .object({
        executable: z
          .string()
          .min(1)
          .max(256)
          .refine((value) => !value.includes("\0"), "Executable cannot contain null bytes."),
        args: z
          .array(
            z
              .string()
              .max(4_096)
              .refine((value) => !value.includes("\0"), "Argument cannot contain null bytes.")
          )
          .max(256)
      })
      .strict(),
    startedAt: factoryTimestampSchema,
    finishedAt: factoryTimestampSchema,
    exitCode: z.number().int().min(0).max(255).nullable(),
    stdoutArtifact: factoryArtifactReferenceSchema,
    stderrArtifact: factoryArtifactReferenceSchema
  })
  .strict()
  .superRefine((observation, context) => {
    if (observation.finishedAt < observation.startedAt) {
      context.addIssue({
        code: "custom",
        path: ["finishedAt"],
        message: "Gate cannot finish before it starts."
      });
    }
    if (observation.result === "pass" && observation.exitCode !== 0) {
      context.addIssue({
        code: "custom",
        path: ["exitCode"],
        message: "A passing gate requires exit code zero."
      });
    }
  });
export type FactoryGateObservation = z.infer<typeof factoryGateObservationSchema>;

export const factoryResourceIsolationRecordSchema = z
  .object({
    schemaVersion: z.literal("agentlab.resource-isolation-record.v1"),
    taskId: z.uuid(),
    contractDigest: sha256DigestSchema,
    policyBundleDigest: sha256DigestSchema,
    subjectDigest: sha256DigestSchema,
    attempt: z.number().int().min(1).max(20),
    execution: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("agent"),
          executionId: z.uuid()
        })
        .strict(),
      z
        .object({
          kind: z.literal("gate"),
          gateId: factoryIdentifierSchema
        })
        .strict()
    ]),
    isolation: factoryProcessIsolationSchema,
    result: z.enum(["enforced", "failed"]),
    observedAt: factoryTimestampSchema
  })
  .strict();
export type FactoryResourceIsolationRecord = z.infer<typeof factoryResourceIsolationRecordSchema>;

export const factoryPatchProposalSchema = z
  .object({
    schemaVersion: z.literal("agentlab.patch-proposal.v1"),
    taskId: z.uuid(),
    contractDigest: sha256DigestSchema,
    executionId: z.uuid(),
    baseRevision: gitObjectIdSchema,
    changeSet: factoryChangeSetSchema,
    patchArtifact: factoryArtifactReferenceSchema,
    createdAt: factoryTimestampSchema
  })
  .strict()
  .superRefine((proposal, context) => {
    if (proposal.changeSet.baseRevision !== proposal.baseRevision) {
      context.addIssue({
        code: "custom",
        path: ["changeSet", "baseRevision"],
        message: "Patch proposal and change set must share an exact base revision."
      });
    }
  });
export type FactoryPatchProposal = z.infer<typeof factoryPatchProposalSchema>;

export const factoryReviewDecisionSchema = z
  .object({
    verdict: z.enum(["approved", "changes-requested"]),
    summary: z.string().trim().min(1).max(4_096),
    findings: z
      .array(
        z
          .object({
            id: factoryIdentifierSchema,
            severity: z.enum(["low", "medium", "high", "critical"]),
            path: repositoryRelativePathSchema.nullable(),
            line: z.number().int().min(1).max(10_000_000).nullable(),
            title: shortTextSchema,
            detail: boundedTextSchema
          })
          .strict()
      )
      .max(100)
  })
  .strict()
  .superRefine((review, context) => {
    const findingIds = review.findings.map(({ id }) => id);
    if (new Set(findingIds).size !== findingIds.length) {
      context.addIssue({
        code: "custom",
        path: ["findings"],
        message: "Review finding IDs must be unique."
      });
    }
    if (
      review.verdict === "approved" &&
      review.findings.some(({ severity }) => severity !== "low")
    ) {
      context.addIssue({
        code: "custom",
        path: ["verdict"],
        message: "An approved review cannot retain blocking findings."
      });
    }
  });
export type FactoryReviewDecision = z.infer<typeof factoryReviewDecisionSchema>;

export const factoryReviewResultSchema = factoryReviewDecisionSchema.safeExtend({
  schemaVersion: z.literal("agentlab.review-result.v1"),
  taskId: z.uuid(),
  contractDigest: sha256DigestSchema,
  patchProposalDigest: sha256DigestSchema,
  executionId: z.uuid(),
  reviewerRunId: z.uuid(),
  createdAt: factoryTimestampSchema
});
export type FactoryReviewResult = z.infer<typeof factoryReviewResultSchema>;

export const factoryPullRequestProposalSchema = z
  .object({
    schemaVersion: z.literal("agentlab.pull-request-proposal.v1"),
    taskId: z.uuid(),
    contractDigest: sha256DigestSchema,
    patchProposalDigest: sha256DigestSchema,
    patchArtifactDigest: sha256DigestSchema,
    changeSet: factoryChangeSetSchema,
    policyEvaluationDigest: sha256DigestSchema,
    deduplicationKey: sha256DigestSchema,
    repositoryId: factoryIdentifierSchema,
    baseRevision: gitObjectIdSchema,
    baseBranch: factoryIdentifierSchema,
    branchName: factoryIdentifierSchema,
    title: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .refine((value) => !hasAsciiControl(value), "PR title contains controls."),
    body: z
      .string()
      .trim()
      .min(1)
      .max(16_384)
      .refine((value) => !value.includes("\0"), "PR body contains null bytes."),
    draft: z.literal(true),
    createdAt: factoryTimestampSchema
  })
  .strict()
  .superRefine((proposal, context) => {
    if (proposal.changeSet.baseRevision !== proposal.baseRevision) {
      context.addIssue({
        code: "custom",
        path: ["changeSet", "baseRevision"],
        message: "PR proposal change set must match its exact base revision."
      });
    }
  });
export type FactoryPullRequestProposal = z.infer<typeof factoryPullRequestProposalSchema>;

export const factoryPullRequestRecordSchema = z
  .object({
    schemaVersion: z.literal("agentlab.pull-request-record.v1"),
    taskId: z.uuid(),
    contractDigest: sha256DigestSchema,
    proposalDigest: sha256DigestSchema,
    repositoryId: factoryIdentifierSchema,
    number: z.number().int().min(1),
    url: z.url().max(2_048),
    baseRevision: gitObjectIdSchema,
    headRevision: gitObjectIdSchema,
    branchName: factoryIdentifierSchema,
    draft: z.literal(true),
    brokerId: factoryIdentifierSchema,
    createdAt: factoryTimestampSchema
  })
  .strict();
export type FactoryPullRequestRecord = z.infer<typeof factoryPullRequestRecordSchema>;
