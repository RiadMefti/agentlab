import { describe, expect, it } from "vitest";

import {
  evidenceBundleSchema,
  factoryBudgetUsageSchema,
  factoryCostPolicySchema,
  factoryPullRequestProposalSchema,
  factoryResourceIsolationRecordSchema,
  factoryResourceLimitsSchema,
  immutableTaskContractSchema,
  skillManifestSchema,
  taskEventSchema
} from "@agentlab/contracts";

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
const EVENT_ID = "33333333-3333-4333-8333-333333333333";
const CORRELATION_ID = "44444444-4444-4444-8444-444444444444";
const BUNDLE_ID = "55555555-5555-4555-8555-555555555555";
const ITEM_ID = "66666666-6666-4666-8666-666666666666";
const digest = (character: string): string => `sha256:${character.repeat(64)}`;

const budget = {
  wallClockSeconds: 3_600,
  maxAgentTurns: 100,
  maxToolCalls: 500,
  maxInputTokens: 1_000_000,
  maxOutputTokens: 100_000,
  maxCostMicrousd: 10_000_000,
  maxProcesses: 32,
  maxOutputBytes: 10_000_000,
  maxWorkers: 1,
  maxRepairAttempts: 2,
  maxChangedFiles: 20,
  maxChangedLines: 500
};

const readOnlyCapabilities = {
  filesystem: "read" as const,
  git: "read" as const,
  remoteRepository: "read" as const,
  process: "sandboxed" as const,
  network: { mode: "off" as const },
  commandAllowlist: ["git", "rg"],
  secretRefs: []
};

const baseSkillManifest = {
  schemaVersion: "agentlab.skill-manifest.v1" as const,
  id: "quality/specifier",
  version: "1.0.0",
  packageDigest: digest("a"),
  instructionPath: "skills/specifier/SKILL.md",
  description: "Turn an accepted request into testable acceptance criteria.",
  roles: ["specifier" as const],
  triggers: ["intake" as const],
  inputSchemaDigest: digest("b"),
  outputSchemaDigest: digest("c"),
  requestedCapabilities: readOnlyCapabilities,
  riskCeiling: "R3" as const,
  allowedFromStates: ["qualified" as const],
  allowedToStates: ["specified" as const],
  providerCompatibility: { mode: "any-supported" as const },
  budgetCeiling: budget,
  requiredEvidence: ["skill" as const],
  dependencyDigests: []
};

const baseContract = {
  schemaVersion: "agentlab.task-contract.v1" as const,
  taskId: TASK_ID,
  conversationId: CONVERSATION_ID,
  supersedesContractDigest: null,
  createdAt: "2026-08-30T12:00:00.000Z",
  expiresAt: "2026-08-31T12:00:00.000Z",
  deduplicationKey: digest("d"),
  repository: { id: "agentlab", baseRevision: "a".repeat(40) },
  requestSources: [{ kind: "local" as const, ref: "request-1" }],
  trigger: "manual" as const,
  objective: "Add a deterministic factory contract.",
  acceptanceCriteria: ["All external task data is strictly validated."],
  nonGoals: ["Run an agent."],
  scope: {
    includePaths: ["packages/contracts/**"],
    excludePaths: ["node_modules/**"],
    protectedPaths: [".github/**"]
  },
  riskTier: "R1" as const,
  skillPlan: [
    {
      id: "quality/specifier",
      version: "1.0.0",
      packageDigest: digest("a"),
      phase: "specify" as const,
      dependsOn: []
    }
  ],
  agentPolicy: {
    allowedProviders: ["codex" as const, "claude" as const],
    workerProfiles: [
      {
        id: "codex-writer",
        roles: ["implementer" as const, "repairer" as const],
        provider: "codex" as const,
        model: "gpt-5.4",
        reasoning: "high"
      },
      {
        id: "claude-reviewer",
        roles: ["reviewer" as const],
        provider: "claude" as const,
        model: "claude-sonnet-4-6",
        reasoning: "high"
      }
    ],
    minimumIndependentReviews: 1,
    requireDistinctReviewSession: true
  },
  capabilities: {
    ...readOnlyCapabilities,
    filesystem: "workspace-write" as const,
    git: "worktree-write" as const
  },
  budget,
  gateProfile: { id: "baseline/r1", version: "1.0.0", policyDigest: digest("e") },
  requiredEvidence: ["contract" as const, "test" as const, "review" as const, "patch" as const],
  approvals: {
    execution: { mode: "automatic" as const },
    pullRequestCreation: { mode: "automatic" as const },
    merge: { mode: "human" as const, minimumApprovals: 1, roles: ["maintainer"] },
    release: { mode: "forbidden" as const }
  }
};

describe("factory contracts", () => {
  it("accepts only unique exact-model cost rules", () => {
    const policy = {
      schemaVersion: "agentlab.cost-policy.v1" as const,
      id: "agentlab/test-costs",
      version: "1.0.0",
      rules: [
        {
          provider: "codex" as const,
          model: "gpt-5.4",
          accounting: {
            mode: "token-rate" as const,
            inputMicrousdPerMillionTokens: 1_000_000,
            outputMicrousdPerMillionTokens: 2_000_000
          }
        }
      ]
    };
    expect(factoryCostPolicySchema.parse(policy)).toEqual(policy);
    expect(
      factoryCostPolicySchema.safeParse({ ...policy, rules: [...policy.rules, policy.rules[0]] })
        .success
    ).toBe(false);
    expect(
      factoryCostPolicySchema.safeParse({
        ...policy,
        rules: [{ ...policy.rules[0], model: "gpt-*" }]
      }).success
    ).toBe(false);
    expect(factoryCostPolicySchema.safeParse({ ...policy, fallbackRate: 0 }).success).toBe(false);
  });

  it("accepts a strict, content-addressed skill manifest", () => {
    expect(skillManifestSchema.parse(baseSkillManifest)).toEqual(baseSkillManifest);
  });

  it("rejects unsafe instruction paths and duplicate capabilities", () => {
    expect(
      skillManifestSchema.safeParse({
        ...baseSkillManifest,
        instructionPath: "../SKILL.md",
        requestedCapabilities: {
          ...readOnlyCapabilities,
          commandAllowlist: ["git", "git"]
        }
      }).success
    ).toBe(false);
  });

  it("accepts an immutable task contract and rejects unknown fields", () => {
    expect(immutableTaskContractSchema.parse(baseContract)).toEqual(baseContract);
    expect(
      immutableTaskContractSchema.safeParse({ ...baseContract, mutableState: "executing" }).success
    ).toBe(false);
  });

  it("requires canonical UTC millisecond timestamps", () => {
    expect(
      immutableTaskContractSchema.safeParse({
        ...baseContract,
        createdAt: "2026-08-30T12:00:00Z"
      }).success
    ).toBe(false);
    expect(
      immutableTaskContractSchema.safeParse({
        ...baseContract,
        expiresAt: "2026-08-30T12:00:00.000Z"
      }).success
    ).toBe(false);
  });

  it("rejects unknown or cyclic skill dependencies", () => {
    const unknown = {
      ...baseContract,
      skillPlan: [{ ...baseContract.skillPlan[0], dependsOn: ["missing/skill"] }]
    };
    expect(immutableTaskContractSchema.safeParse(unknown).success).toBe(false);

    const cyclic = {
      ...baseContract,
      skillPlan: [
        { ...baseContract.skillPlan[0], dependsOn: ["quality/reviewer"] },
        {
          ...baseContract.skillPlan[0],
          id: "quality/reviewer",
          phase: "review" as const,
          packageDigest: digest("f"),
          dependsOn: ["quality/specifier"]
        }
      ]
    };
    expect(immutableTaskContractSchema.safeParse(cyclic).success).toBe(false);
  });

  it("requires R0 to remain read-only and write tasks to have distinct review", () => {
    expect(immutableTaskContractSchema.safeParse({ ...baseContract, riskTier: "R0" }).success).toBe(
      false
    );
    expect(
      immutableTaskContractSchema.safeParse({
        ...baseContract,
        agentPolicy: {
          ...baseContract.agentPolicy,
          minimumIndependentReviews: 0,
          requireDistinctReviewSession: false
        }
      }).success
    ).toBe(false);
  });

  it("records cumulative usage beyond a task ceiling so policy can deny it", () => {
    expect(
      factoryBudgetUsageSchema.parse({
        wallClockSeconds: budget.wallClockSeconds + 1,
        agentTurns: 0,
        toolCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        costMicrousd: 0,
        processes: 0,
        outputBytes: 0,
        workers: 0,
        repairAttempts: 0,
        changedFiles: 0,
        changedLines: 0
      }).wallClockSeconds
    ).toBe(3_601);
  });

  it("strictly records the kernel resource boundary applied to one execution", () => {
    const limits = {
      maxProcesses: 32,
      maxMemoryBytes: 4 * 1_024 * 1_024 * 1_024,
      cpuQuotaPercent: 400
    };
    expect(factoryResourceLimitsSchema.parse(limits)).toEqual(limits);
    expect(
      factoryResourceIsolationRecordSchema.safeParse({
        schemaVersion: "agentlab.resource-isolation-record.v1",
        taskId: TASK_ID,
        contractDigest: digest("d"),
        policyBundleDigest: digest("e"),
        subjectDigest: digest("d"),
        attempt: 1,
        execution: { kind: "agent", executionId: EVENT_ID },
        isolation: {
          isolationId: EVENT_ID,
          mechanism: { id: "linux/systemd-user-scope", version: "systemd 261" },
          scopeName: `agentlab-factory-${EVENT_ID.replaceAll("-", "")}.scope`,
          limits
        },
        result: "enforced",
        observedAt: "2026-08-30T12:00:01.000Z"
      }).success
    ).toBe(true);
    expect(factoryResourceLimitsSchema.safeParse({ ...limits, maxMemoryBytes: 1 }).success).toBe(
      false
    );
  });

  it("rejects control characters at the pull-request authority boundary", () => {
    expect(
      factoryPullRequestProposalSchema.safeParse({
        schemaVersion: "agentlab.pull-request-proposal.v1",
        taskId: TASK_ID,
        contractDigest: digest("1"),
        patchProposalDigest: digest("2"),
        patchArtifactDigest: digest("3"),
        changeSet: {
          baseRevision: "a".repeat(40),
          headRevision: null,
          changedPaths: ["tests/example.test.ts"],
          binaryPaths: [],
          changedFiles: 1,
          changedLines: 1
        },
        policyEvaluationDigest: digest("4"),
        deduplicationKey: digest("5"),
        repositoryId: "agentlab",
        baseRevision: "a".repeat(40),
        baseBranch: "main",
        branchName: `agentlab/${"5".repeat(64)}`,
        title: "unsafe\nheading",
        body: "bounded body",
        draft: true,
        createdAt: "2026-08-30T12:00:00.000Z"
      }).success
    ).toBe(false);
  });

  it("requires the first event to initialize intake", () => {
    const event = {
      schemaVersion: "agentlab.task-event.v1" as const,
      eventId: EVENT_ID,
      taskId: TASK_ID,
      sequence: 1,
      contractDigest: digest("d"),
      previousEventDigest: null,
      from: null,
      to: "intake" as const,
      actor: {
        kind: "human" as const,
        role: "requester" as const,
        id: "maintainer",
        sessionId: null
      },
      occurredAt: "2026-08-30T12:00:00.000Z",
      reasonCode: "task-created",
      summary: null,
      evidenceBundleDigest: null,
      correlationId: CORRELATION_ID
    };
    expect(taskEventSchema.safeParse(event).success).toBe(true);
    expect(taskEventSchema.safeParse({ ...event, sequence: 2 }).success).toBe(false);
  });

  it("requires every later evidence bundle to link to its predecessor", () => {
    const bundle = {
      schemaVersion: "agentlab.evidence-bundle.v1" as const,
      bundleId: BUNDLE_ID,
      taskId: TASK_ID,
      sequence: 1,
      contractDigest: digest("d"),
      previousBundleDigest: null,
      policyBundleDigest: digest("e"),
      createdAt: "2026-08-30T12:01:00.000Z",
      items: [
        {
          id: ITEM_ID,
          kind: "contract" as const,
          result: "pass" as const,
          subjectDigest: digest("d"),
          artifact: {
            digest: digest("d"),
            mediaType: "application/json",
            sizeBytes: 1_024
          },
          producer: {
            kind: "control-plane" as const,
            role: "policy-engine" as const,
            id: "local-policy",
            sessionId: null
          },
          createdAt: "2026-08-30T12:01:00.000Z",
          claims: [{ name: "schema", value: "agentlab.task-contract.v1" }]
        }
      ],
      attestations: []
    };
    expect(evidenceBundleSchema.safeParse(bundle).success).toBe(true);
    expect(evidenceBundleSchema.safeParse({ ...bundle, sequence: 2 }).success).toBe(false);
  });
});
