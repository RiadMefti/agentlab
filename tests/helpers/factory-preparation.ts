import {
  factoryPlanSchema,
  factoryPreparationAuthoritySchema,
  factoryPreparationBundleSchema,
  factoryQualificationSchema,
  factorySpecificationSchema,
  factoryIntakeRequestSchema,
  skillManifestSchema,
  type FactoryBudget,
  type FactoryCapabilityGrant,
  type FactoryPreparationAuthority,
  type FactoryQualification,
  type FactoryRiskTier,
  type FactorySkillPhase,
  type SkillManifest
} from "@agentlab/contracts";

import type { FactoryPreparationCompilationInput } from "../../packages/runtime/src/domain/factory-preparation.js";
import {
  defaultFactoryPolicyBundle,
  FactoryPolicyEngine
} from "../../packages/runtime/src/domain/factory-policy.js";
import {
  encodeCanonicalDocument,
  NodeFactoryDocumentCodec
} from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { TEST_FACTORY_CONVERSATION_ID, TEST_FACTORY_TASK_ID, testDigest } from "./factory.js";

export interface FactoryPreparationFixtureOptions {
  readonly qualificationDisposition?: FactoryQualification["disposition"];
  readonly includePaths?: readonly string[];
  readonly allowedIncludePaths?: readonly string[];
  readonly maximumRiskTier?: FactoryRiskTier;
  readonly proposedRiskTier?: FactoryRiskTier;
  readonly planCapabilities?: FactoryCapabilityGrant;
  readonly capabilityCeiling?: FactoryCapabilityGrant;
  readonly planBudget?: FactoryBudget;
  readonly budgetCeiling?: FactoryBudget;
  readonly selectedSkillIds?: readonly string[];
  readonly selectedWorkerProfileIds?: readonly string[];
  readonly reviewerCount?: 1 | 2;
  readonly contractExpiresAt?: string;
  readonly maximumContractLifetimeSeconds?: number;
  readonly preparationMaxProcesses?: number;
}

export function testFactoryPreparationFixture(options: FactoryPreparationFixtureOptions = {}) {
  const documents = new NodeFactoryDocumentCodec();
  const policyDigest = encodeCanonicalDocument(defaultFactoryPolicyBundle).digest;
  const policy = new FactoryPolicyEngine(policyDigest);
  const request = factoryIntakeRequestSchema.parse({
    schemaVersion: "agentlab.intake-request.v1",
    taskId: TEST_FACTORY_TASK_ID,
    conversationId: TEST_FACTORY_CONVERSATION_ID,
    createdAt: "2026-08-30T12:00:00.000Z",
    deduplicationKey: testDigest("d"),
    repository: { id: "agentlab", baseRevision: "a".repeat(40) },
    requestSources: [{ kind: "local", ref: "request-1" }],
    trigger: "manual",
    requester: { kind: "human", role: "requester", id: "maintainer", sessionId: null },
    title: "Document the factory boundary",
    body: "Add a durable explanation of the governed request-to-contract boundary."
  });
  const requestDocument = documents.intakeRequest(request);
  const budget = options.planBudget ?? defaultBudget();
  const authorityBudget = options.budgetCeiling ?? defaultBudget();
  const planCapabilities = options.planCapabilities ?? writeCapabilities();
  const capabilityCeiling = options.capabilityCeiling ?? writeCapabilities();
  const skills = authorizedSkills(authorityBudget);
  const includePaths = [...(options.includePaths ?? ["README.md"])];
  const reviewerCount = options.reviewerCount ?? 1;
  const workerProfiles = [
    {
      id: "codex-writer",
      roles: ["implementer", "repairer"] as const,
      provider: "codex" as const,
      model: "gpt-5.4",
      reasoning: "high"
    },
    {
      id: "claude-reviewer",
      roles: ["reviewer"] as const,
      provider: "claude" as const,
      model: "claude-sonnet-4-6",
      reasoning: "high"
    },
    ...(reviewerCount === 2
      ? [
          {
            id: "codex-reviewer",
            roles: ["reviewer"] as const,
            provider: "codex" as const,
            model: "gpt-5.4",
            reasoning: "high"
          }
        ]
      : [])
  ];
  const preparationProfiles = [
    preparationProfile("qualify", options.preparationMaxProcesses),
    preparationProfile("specify", options.preparationMaxProcesses),
    preparationProfile("plan", options.preparationMaxProcesses)
  ];
  const authority = factoryPreparationAuthoritySchema.parse({
    schemaVersion: "agentlab.preparation-authority.v2",
    authorityId: "local/repository-policy",
    version: "1.0.0",
    taskId: request.taskId,
    requestDigest: requestDocument.digest,
    supersedesContractDigest: null,
    issuedAt: "2026-08-30T12:01:00.000Z",
    expiresAt: "2026-08-31T12:01:00.000Z",
    policyBundleDigest: policyDigest,
    repository: request.repository,
    allowedIncludePaths: [
      ...(options.allowedIncludePaths ?? options.includePaths ?? ["README.md"])
    ],
    protectedPaths: [".github/**"],
    maximumRiskTier: options.maximumRiskTier ?? "R1",
    skills,
    preparationProfiles,
    workerProfiles,
    capabilityCeiling,
    budgetCeiling: authorityBudget,
    evidenceFloor: ["contract", "policy", "skill"],
    approvalRoles: {
      execution: ["maintainer"],
      pullRequestCreation: ["maintainer"],
      merge: ["maintainer", "security-owner"],
      release: ["release-owner", "security-owner"]
    },
    maximumPreparationAttempts: 2,
    maximumContractLifetimeSeconds: options.maximumContractLifetimeSeconds ?? 86_400
  });
  const authorityDocument = documents.preparationAuthority(authority);
  const qualification = buildQualification(
    options.qualificationDisposition ?? "ready",
    request.taskId,
    requestDocument.digest
  );
  const qualificationDocument = documents.qualification(qualification);
  const specification = factorySpecificationSchema.parse({
    schemaVersion: "agentlab.specification.v1",
    taskId: request.taskId,
    requestDigest: requestDocument.digest,
    qualificationDigest: qualificationDocument.digest,
    createdAt: "2026-08-30T12:05:00.000Z",
    objective: "Document the governed request-to-contract boundary.",
    acceptanceCriteria: ["The boundary is explicit and testable."],
    nonGoals: ["Enable autonomous merge."],
    scope: { includePaths, excludePaths: [], protectedPaths: [] }
  });
  const specificationDocument = documents.specification(specification);
  const defaultSelectedSkills = [
    "execution/implement",
    "execution/verify",
    "execution/review",
    "execution/repair"
  ];
  const defaultProfiles = [
    "codex-writer",
    "claude-reviewer",
    ...(reviewerCount === 2 ? ["codex-reviewer"] : [])
  ];
  const plan = factoryPlanSchema.parse({
    schemaVersion: "agentlab.plan.v1",
    taskId: request.taskId,
    requestDigest: requestDocument.digest,
    qualificationDigest: qualificationDocument.digest,
    specificationDigest: specificationDocument.digest,
    createdAt: "2026-08-30T12:07:00.000Z",
    proposedRiskTier: options.proposedRiskTier ?? "R1",
    selectedSkillIds: [...(options.selectedSkillIds ?? defaultSelectedSkills)],
    selectedWorkerProfileIds: [...(options.selectedWorkerProfileIds ?? defaultProfiles)],
    capabilities: planCapabilities,
    budget,
    requiredEvidence: ["test", "review", "patch"]
  });
  const planDocument = documents.plan(plan);
  const bundle = factoryPreparationBundleSchema.parse({
    schemaVersion: "agentlab.preparation-bundle.v2",
    taskId: request.taskId,
    requestDigest: requestDocument.digest,
    authorityDigest: authorityDocument.digest,
    qualificationDigest: qualificationDocument.digest,
    specificationDigest: specificationDocument.digest,
    planDigest: planDocument.digest,
    runs: [
      preparationRun("qualify", "preparation/qualify", "1", qualificationDocument.digest),
      preparationRun("specify", "preparation/specify", "2", specificationDocument.digest),
      preparationRun("plan", "preparation/plan", "3", planDocument.digest)
    ],
    createdAt: "2026-08-30T12:08:00.000Z"
  });

  const input: FactoryPreparationCompilationInput = {
    request,
    qualification,
    specification,
    plan,
    bundle,
    contractCreatedAt: "2026-08-30T12:09:00.000Z",
    contractExpiresAt: options.contractExpiresAt ?? "2026-08-31T12:00:00.000Z"
  };
  return {
    documents,
    policy,
    policyDigest,
    input,
    request,
    authority,
    qualification,
    specification,
    plan,
    bundle
  };
}

function buildQualification(
  disposition: FactoryQualification["disposition"],
  taskId: string,
  requestDigest: string
): FactoryQualification {
  const common = {
    schemaVersion: "agentlab.qualification.v1" as const,
    taskId,
    requestDigest,
    createdAt: "2026-08-30T12:03:00.000Z",
    assumptions: ["The request targets the current repository."]
  };
  if (disposition === "ready") {
    return factoryQualificationSchema.parse({
      ...common,
      disposition,
      objective: "Document the governed request-to-contract boundary.",
      openQuestions: [],
      rejectionReason: null
    });
  }
  if (disposition === "needs-human") {
    return factoryQualificationSchema.parse({
      ...common,
      disposition,
      objective: "Document the governed request-to-contract boundary.",
      openQuestions: ["Which repository paths may change?"],
      rejectionReason: null
    });
  }
  return factoryQualificationSchema.parse({
    ...common,
    disposition,
    objective: null,
    openQuestions: [],
    rejectionReason: "The request is outside repository policy."
  });
}

function authorizedSkills(budget: FactoryBudget): FactoryPreparationAuthority["skills"] {
  const definitions: readonly {
    readonly id: string;
    readonly phase: FactorySkillPhase;
    readonly digestCharacter: string;
    readonly dependsOn: readonly string[];
  }[] = [
    { id: "preparation/qualify", phase: "qualify", digestCharacter: "1", dependsOn: [] },
    {
      id: "preparation/specify",
      phase: "specify",
      digestCharacter: "2",
      dependsOn: ["preparation/qualify"]
    },
    {
      id: "preparation/plan",
      phase: "plan",
      digestCharacter: "3",
      dependsOn: ["preparation/specify"]
    },
    {
      id: "execution/implement",
      phase: "implement",
      digestCharacter: "4",
      dependsOn: ["preparation/plan"]
    },
    {
      id: "execution/verify",
      phase: "verify",
      digestCharacter: "5",
      dependsOn: ["execution/implement"]
    },
    {
      id: "execution/review",
      phase: "review",
      digestCharacter: "6",
      dependsOn: ["execution/verify"]
    },
    {
      id: "execution/repair",
      phase: "repair",
      digestCharacter: "7",
      dependsOn: ["execution/review"]
    }
  ];
  const packageById = new Map(
    definitions.map((definition) => [definition.id, testDigest(definition.digestCharacter)])
  );
  return definitions.map((definition) => ({
    phase: definition.phase,
    dependsOn: [...definition.dependsOn],
    manifest: skillManifest(definition, budget, packageById)
  }));
}

function skillManifest(
  definition: {
    readonly id: string;
    readonly phase: FactorySkillPhase;
    readonly digestCharacter: string;
    readonly dependsOn: readonly string[];
  },
  budget: FactoryBudget,
  packageById: ReadonlyMap<string, string>
): SkillManifest {
  const phase = phasePolicy[definition.phase];
  return skillManifestSchema.parse({
    schemaVersion: "agentlab.skill-manifest.v1",
    id: definition.id,
    version: "1.0.0",
    packageDigest: testDigest(definition.digestCharacter),
    instructionPath: `skills/${definition.id}/SKILL.md`,
    description: `Authorized ${definition.phase} skill.`,
    roles: [phase.role],
    triggers: [definition.phase === "repair" ? "failure" : "intake"],
    inputSchemaDigest: testDigest("8"),
    outputSchemaDigest: testDigest("9"),
    requestedCapabilities:
      definition.phase === "implement" || definition.phase === "repair"
        ? writeCapabilities()
        : readCapabilities(),
    riskCeiling: "R3",
    allowedFromStates: [phase.from],
    allowedToStates: [phase.to],
    providerCompatibility: { mode: "any-supported" },
    budgetCeiling: budget,
    requiredEvidence: ["skill"],
    dependencyDigests: definition.dependsOn.map((id) => packageById.get(id) ?? testDigest("0"))
  });
}

function preparationRun(
  phase: "qualify" | "specify" | "plan",
  skillId: string,
  digestCharacter: string,
  outputDigest: string
) {
  const times = {
    qualify: ["2026-08-30T12:02:00.000Z", "2026-08-30T12:03:00.000Z"],
    specify: ["2026-08-30T12:04:00.000Z", "2026-08-30T12:05:00.000Z"],
    plan: ["2026-08-30T12:06:00.000Z", "2026-08-30T12:07:00.000Z"]
  } as const;
  return {
    executionId: `${digestCharacter.repeat(8)}-${digestCharacter.repeat(4)}-4${digestCharacter.repeat(3)}-8${digestCharacter.repeat(3)}-${digestCharacter.repeat(12)}`,
    phase,
    skillId,
    skillPackageDigest: testDigest(digestCharacter),
    workerProfileId: `preparation/${phase}-worker`,
    provider: "codex" as const,
    model: "gpt-5.4",
    reasoning: "high",
    actor: {
      kind: "agent" as const,
      role: phasePolicy[phase].role,
      id: `preparation/${phase}-worker`,
      sessionId: `${phase}-session`
    },
    startedAt: times[phase][0],
    finishedAt: times[phase][1],
    runRecordDigest: testDigest(phase === "qualify" ? "a" : phase === "specify" ? "b" : "c"),
    outputDigest
  };
}

function preparationProfile(phase: "qualify" | "specify" | "plan", maximumProcesses = 8) {
  return {
    id: `preparation/${phase}-worker`,
    phase,
    skillId: `preparation/${phase}`,
    provider: "codex" as const,
    model: "gpt-5.4",
    reasoning: "high",
    capabilities: readCapabilities(),
    budget: preparationBudget(maximumProcesses)
  };
}

function preparationBudget(maximumProcesses = 8): FactoryBudget {
  return {
    wallClockSeconds: 600,
    maxAgentTurns: 20,
    maxToolCalls: 100,
    maxInputTokens: 100_000,
    maxOutputTokens: 20_000,
    maxCostMicrousd: 1_000_000,
    maxProcesses: maximumProcesses,
    maxOutputBytes: 1_000_000,
    maxWorkers: 1,
    maxRepairAttempts: 0,
    maxChangedFiles: 0,
    maxChangedLines: 0
  };
}

function defaultBudget(): FactoryBudget {
  return {
    wallClockSeconds: 3_600,
    maxAgentTurns: 100,
    maxToolCalls: 500,
    maxInputTokens: 1_000_000,
    maxOutputTokens: 100_000,
    maxCostMicrousd: 10_000_000,
    maxProcesses: 32,
    maxOutputBytes: 10_000_000,
    maxWorkers: 2,
    maxRepairAttempts: 2,
    maxChangedFiles: 20,
    maxChangedLines: 500
  };
}

function readCapabilities(): FactoryCapabilityGrant {
  return {
    filesystem: "read",
    git: "read",
    remoteRepository: "none",
    process: "sandboxed",
    network: { mode: "off" },
    commandAllowlist: [],
    secretRefs: []
  };
}

function writeCapabilities(): FactoryCapabilityGrant {
  return { ...readCapabilities(), filesystem: "workspace-write", git: "worktree-write" };
}

const phasePolicy = {
  qualify: { role: "qualifier", from: "intake", to: "qualified" },
  specify: { role: "specifier", from: "qualified", to: "specified" },
  plan: { role: "planner", from: "specified", to: "planned" },
  implement: { role: "implementer", from: "executing", to: "verifying" },
  verify: { role: "gate-runner", from: "verifying", to: "reviewing" },
  review: { role: "reviewer", from: "reviewing", to: "pr-proposed" },
  repair: { role: "repairer", from: "repairing", to: "verifying" }
} as const;
