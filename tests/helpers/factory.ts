import {
  evidenceBundleSchema,
  evidenceItemSchema,
  immutableTaskContractSchema,
  taskEventSchema,
  type EvidenceBundle,
  type EvidenceItem,
  type FactoryActor,
  type FactoryControlEvent,
  type FactoryTaskState,
  type ImmutableTaskContract,
  type Sha256Digest,
  type TaskEvent
} from "@agentlab/contracts";

export const TEST_FACTORY_TASK_ID = "11111111-1111-4111-8111-111111111111";
export const TEST_FACTORY_CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
export const TEST_FACTORY_CORRELATION_ID = "44444444-4444-4444-8444-444444444444";

export function testDigest(character: string): Sha256Digest {
  return `sha256:${character.repeat(64)}`;
}

export const testFactoryActor: FactoryActor = {
  kind: "human",
  role: "requester",
  id: "maintainer",
  sessionId: null
};

export function testFactoryContract(): ImmutableTaskContract {
  return immutableTaskContractSchema.parse({
    schemaVersion: "agentlab.task-contract.v1",
    taskId: TEST_FACTORY_TASK_ID,
    conversationId: TEST_FACTORY_CONVERSATION_ID,
    supersedesContractDigest: null,
    createdAt: "2026-08-30T12:00:00.000Z",
    expiresAt: "2026-08-31T12:00:00.000Z",
    deduplicationKey: testDigest("d"),
    repository: { id: "agentlab", baseRevision: "a".repeat(40) },
    requestSources: [{ kind: "local", ref: "request-1" }],
    trigger: "manual",
    objective: "Add a deterministic factory contract.",
    acceptanceCriteria: ["All external task data is strictly validated."],
    nonGoals: ["Run an agent."],
    scope: {
      includePaths: ["packages/contracts/**", "tests/**"],
      excludePaths: ["node_modules/**"],
      protectedPaths: [".github/**"]
    },
    riskTier: "R1",
    skillPlan: [
      {
        id: "quality/specifier",
        version: "1.0.0",
        packageDigest: testDigest("a"),
        phase: "specify",
        dependsOn: []
      }
    ],
    agentPolicy: {
      allowedProviders: ["codex", "claude"],
      workerProfiles: [
        {
          id: "codex-writer",
          roles: ["implementer", "repairer"],
          provider: "codex",
          model: "gpt-5.4",
          reasoning: "high"
        },
        {
          id: "claude-reviewer",
          roles: ["reviewer"],
          provider: "claude",
          model: "claude-sonnet-4-6",
          reasoning: "high"
        }
      ],
      minimumIndependentReviews: 1,
      requireDistinctReviewSession: true
    },
    capabilities: {
      filesystem: "workspace-write",
      git: "worktree-write",
      remoteRepository: "read",
      process: "sandboxed",
      network: { mode: "off" },
      commandAllowlist: ["git", "rg"],
      secretRefs: []
    },
    budget: {
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
    },
    gateProfile: {
      id: "baseline/r1",
      version: "1.0.0",
      policyDigest: testDigest("e")
    },
    requiredEvidence: ["contract", "test", "review", "patch"],
    approvals: {
      execution: { mode: "automatic" },
      pullRequestCreation: { mode: "automatic" },
      merge: { mode: "human", minimumApprovals: 1, roles: ["maintainer"] },
      release: { mode: "forbidden" }
    }
  });
}

export function testTaskEvent(input: {
  readonly contractDigest: Sha256Digest;
  readonly eventId: string;
  readonly sequence: number;
  readonly previousEventDigest: Sha256Digest | null;
  readonly from: FactoryTaskState | null;
  readonly to: FactoryTaskState;
}): TaskEvent {
  return taskEventSchema.parse({
    schemaVersion: "agentlab.task-event.v1",
    eventId: input.eventId,
    taskId: TEST_FACTORY_TASK_ID,
    sequence: input.sequence,
    contractDigest: input.contractDigest,
    previousEventDigest: input.previousEventDigest,
    from: input.from,
    to: input.to,
    actor: testFactoryActor,
    occurredAt: `2026-08-30T12:0${String(input.sequence - 1)}:00.000Z`,
    reasonCode: input.sequence === 1 ? "task-created" : "stage-complete",
    summary: null,
    evidenceBundleDigest: null,
    correlationId: TEST_FACTORY_CORRELATION_ID
  });
}

export function testControlEvent(input: {
  readonly eventId: string;
  readonly control: "scheduler" | "pr-broker";
  readonly enabled: boolean;
}): FactoryControlEvent {
  return {
    schemaVersion: "agentlab.control-event.v1",
    eventId: input.eventId,
    control: input.control,
    enabled: input.enabled,
    actor: testFactoryActor,
    occurredAt: "2026-08-30T12:00:00.000Z",
    reason: input.enabled ? "Approved for a bounded test." : "Emergency stop."
  };
}

export function testEvidenceItem(index: number): EvidenceItem {
  return evidenceItemSchema.parse({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    kind: "contract",
    result: "pass",
    subjectDigest: testDigest("d"),
    artifact: {
      digest: testDigest("a"),
      mediaType: "application/json",
      sizeBytes: 100
    },
    producer: {
      kind: "control-plane",
      role: "policy-engine",
      id: "local-policy",
      sessionId: null
    },
    createdAt: "2026-08-30T12:01:00.000Z",
    claims: []
  });
}

export function testEvidenceBundle(input: {
  readonly contractDigest: Sha256Digest;
  readonly bundleId: string;
  readonly sequence: number;
  readonly previousBundleDigest: Sha256Digest | null;
  readonly policyBundleDigest?: Sha256Digest;
}): EvidenceBundle {
  return evidenceBundleSchema.parse({
    schemaVersion: "agentlab.evidence-bundle.v1",
    bundleId: input.bundleId,
    taskId: TEST_FACTORY_TASK_ID,
    sequence: input.sequence,
    contractDigest: input.contractDigest,
    previousBundleDigest: input.previousBundleDigest,
    policyBundleDigest: input.policyBundleDigest ?? testDigest("e"),
    createdAt: `2026-08-30T12:${String(input.sequence).padStart(2, "0")}:00.000Z`,
    items: [testEvidenceItem(input.sequence)],
    attestations: []
  });
}
