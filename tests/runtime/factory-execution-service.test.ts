import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  evidenceItemSchema,
  immutableTaskContractSchema,
  type FactoryAgentRunRequest,
  type FactoryBudgetUsage,
  type FactoryResourceLimits,
  type FactorySkillPackage,
  type ImmutableTaskContract
} from "@agentlab/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { ArtifactFactorySkillSource } from "../../packages/runtime/src/application/artifact-factory-skill-source.js";
import { FactoryControlPlane } from "../../packages/runtime/src/application/factory-control-plane.js";
import {
  createFactoryEvidenceCredential,
  FactoryEvidenceIngress
} from "../../packages/runtime/src/application/factory-evidence-ingress.js";
import { FactoryExecutionService } from "../../packages/runtime/src/application/factory-execution-service.js";
import { FactoryPullRequestService } from "../../packages/runtime/src/application/factory-pull-request-service.js";
import { buildCaptainSessionName } from "../../packages/runtime/src/domain/agent-session-name.js";
import type {
  FactoryAgentExecutionInput,
  FactoryAgentExecutionOutput,
  FactoryAgentExecutor,
  FactoryAgentProviderResolver
} from "../../packages/runtime/src/domain/factory-agent-executor.js";
import type {
  FactoryGateExecutionInput,
  FactoryGateExecutionOutput,
  FactoryGateExecutor
} from "../../packages/runtime/src/domain/factory-gate.js";
import type {
  FactoryDraftPullRequestBroker,
  FactoryRepositoryGovernance,
  OpenFactoryDraftPullRequestInput
} from "../../packages/runtime/src/domain/factory-pull-request-broker.js";
import {
  defaultFactoryPolicyBundle,
  FactoryPolicyEngine
} from "../../packages/runtime/src/domain/factory-policy.js";
import type {
  CreateFactoryWorkspaceInput,
  FactoryWorkspace,
  FactoryWorkspaceManager,
  FactoryWorkspacePatch
} from "../../packages/runtime/src/domain/factory-workspace.js";
import { storedConversationSchema } from "../../packages/runtime/src/domain/conversation-record.js";
import { FileFactoryArtifactStore } from "../../packages/runtime/src/infrastructure/filesystem/file-factory-artifact-store.js";
import {
  encodeCanonicalDocument,
  NodeFactoryDocumentCodec
} from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { SqliteFactoryRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-repository.js";
import { MemoryConversationRepository } from "../helpers/fakes.js";
import {
  TEST_FACTORY_CONVERSATION_ID,
  TEST_FACTORY_TASK_ID,
  testFactoryContract
} from "../helpers/factory.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("FactoryExecutionService", () => {
  it("runs the bounded R1 loop and produces policy-authorizable independent evidence", async () => {
    const fixture = await executionFixture();
    try {
      const result = await fixture.service.execute({
        taskId: TEST_FACTORY_TASK_ID
      });

      expect(result).toMatchObject({ status: "pr-proposed", usageComplete: true });
      expect(result.patch?.value.changeSet.changedPaths).toEqual([
        "tests/runtime/factory-change.test.ts"
      ]);
      expect(result.reviews).toHaveLength(1);
      expect(fixture.workspaces.closedAttempts).toEqual([1]);
      expect(fixture.agents.roles).toEqual(["implementer", "reviewer"]);

      await fixture.controlPlane.setAuthority({
        control: "pr-broker",
        enabled: true,
        actor: requester,
        reason: "Enable the tested draft-PR broker lane."
      });
      const policy = await fixture.controlPlane.evaluatePolicy({
        taskId: TEST_FACTORY_TASK_ID,
        stage: "pull-request-creation",
        approvalSubjectDigest: requiredPatch(result),
        currentBaseRevision: result.task.contract.repository.baseRevision,
        changeSet: result.patch?.value.changeSet,
        usage: result.usage,
        usageComplete: result.usageComplete,
        approvals: [],
        scheduled: false
      });
      expect(policy.decision).toMatchObject({ outcome: "allow", reasonCodes: [] });
    } finally {
      fixture.repository.close();
    }
  });

  it("repairs a failed gate in a fresh workspace and ignores superseded patch failures", async () => {
    const fixture = await executionFixture({ failFirstGate: true });
    try {
      const result = await fixture.service.execute({
        taskId: TEST_FACTORY_TASK_ID
      });

      expect(result).toMatchObject({ status: "pr-proposed" });
      expect(result.usage.repairAttempts).toBe(1);
      expect(fixture.workspaces.createdAttempts).toEqual([1, 2]);
      expect(fixture.workspaces.appliedAttempts).toEqual([2]);
      expect(fixture.agents.roles).toEqual(["implementer", "repairer", "reviewer"]);

      await fixture.controlPlane.setAuthority({
        control: "pr-broker",
        enabled: true,
        actor: requester,
        reason: "Enable the tested draft-PR broker lane."
      });
      const decision = await fixture.controlPlane.evaluatePolicy({
        taskId: TEST_FACTORY_TASK_ID,
        stage: "pull-request-creation",
        approvalSubjectDigest: requiredPatch(result),
        currentBaseRevision: result.task.contract.repository.baseRevision,
        changeSet: result.patch?.value.changeSet,
        usage: result.usage,
        usageComplete: result.usageComplete,
        approvals: [],
        scheduled: false
      });
      expect(decision.decision.outcome).toBe("allow");
    } finally {
      fixture.repository.close();
    }
  });

  it("quarantines a gate that mutates the captured patch", async () => {
    const fixture = await executionFixture({ mutateAfterGates: true });
    try {
      const result = await fixture.service.execute({
        taskId: TEST_FACTORY_TASK_ID
      });
      expect(result.status).toBe("quarantined");
      expect(result.task.lastEvent.reasonCode).toBe("quality-gate-mutated-patch");
      expect(fixture.agents.roles).toEqual(["implementer"]);
    } finally {
      fixture.repository.close();
    }
  });

  it("records a terminal failure when isolated workspace creation fails", async () => {
    const fixture = await executionFixture({ failWorkspaceCreation: true });
    try {
      await expect(fixture.service.execute({ taskId: TEST_FACTORY_TASK_ID })).rejects.toThrow(
        /workspace creation failed/u
      );
      await expect(fixture.repository.findById(TEST_FACTORY_TASK_ID)).resolves.toMatchObject({
        state: "failed",
        lastEvent: { reasonCode: "orchestration-error" }
      });
      expect(fixture.workspaces.closedAttempts).toEqual([]);
    } finally {
      fixture.repository.close();
    }
  });

  it("requires an identified independent reviewer session", async () => {
    const fixture = await executionFixture({ missingReviewerIdentity: true });
    try {
      const result = await fixture.service.execute({ taskId: TEST_FACTORY_TASK_ID });
      expect(result).toMatchObject({
        status: "needs-attention",
        task: { lastEvent: { reasonCode: "independent-review-identity-missing" } }
      });
    } finally {
      fixture.repository.close();
    }
  });

  it("stops deterministic gates as soon as the aggregate task budget is exhausted", async () => {
    const fixture = await executionFixture({ gateWallClockSeconds: 1_000 });
    try {
      const result = await fixture.service.execute({ taskId: TEST_FACTORY_TASK_ID });
      expect(result).toMatchObject({
        status: "needs-attention",
        task: { lastEvent: { reasonCode: "task-budget-exhausted" } }
      });
      expect(fixture.gates.executed).toHaveLength(4);
      expect(fixture.agents.roles).toEqual(["implementer"]);
    } finally {
      fixture.repository.close();
    }
  });
});

describe("FactoryPullRequestService", () => {
  it("opens only a draft through the separate broker and records the exact remote result", async () => {
    const fixture = await executionFixture();
    try {
      await fixture.service.execute({ taskId: TEST_FACTORY_TASK_ID });
      await fixture.controlPlane.setAuthority({
        control: "pr-broker",
        enabled: true,
        actor: requester,
        reason: "Enable one governed draft PR."
      });
      const remote = new FakePullRequestBroker(strongGovernance);
      const broker = fixture.pullRequests(remote);
      const result = await broker.openDraft({ taskId: TEST_FACTORY_TASK_ID });

      expect(result).toMatchObject({
        status: "opened",
        record: { number: 42, draft: true, baseRevision: "a".repeat(40) }
      });
      expect(remote.opened).toHaveLength(1);
      expect(remote.opened[0]?.proposal.branchName).toBe(`agentlab/${"d".repeat(64)}`);
      expect(remote.closed).toHaveLength(0);
      await expect(fixture.repository.findById(TEST_FACTORY_TASK_ID)).resolves.toMatchObject({
        state: "pr-open"
      });
      const latest = await fixture.repository.latestEvidence(TEST_FACTORY_TASK_ID);
      expect(latest?.bundle.items.map(({ kind }) => kind)).toEqual(["policy", "pull-request"]);
    } finally {
      fixture.repository.close();
    }
  });

  it("refuses remote writes when repository governance is weaker than the factory baseline", async () => {
    const fixture = await executionFixture();
    try {
      await fixture.service.execute({ taskId: TEST_FACTORY_TASK_ID });
      await fixture.controlPlane.setAuthority({
        control: "pr-broker",
        enabled: true,
        actor: requester,
        reason: "Test governance denial."
      });
      const remote = new FakePullRequestBroker({
        ...strongGovernance,
        requiredApprovals: 0,
        requiresLastPushApproval: false
      });
      const result = await fixture.pullRequests(remote).openDraft({ taskId: TEST_FACTORY_TASK_ID });

      expect(result).toEqual({
        status: "denied",
        reasonCodes: ["repository-approval-rule-too-weak", "repository-last-push-rule-missing"],
        decision: null
      });
      expect(remote.opened).toHaveLength(0);
    } finally {
      fixture.repository.close();
    }
  });
});

async function executionFixture(
  options: {
    readonly failFirstGate?: boolean;
    readonly mutateAfterGates?: boolean;
    readonly failWorkspaceCreation?: boolean;
    readonly missingReviewerIdentity?: boolean;
    readonly gateWallClockSeconds?: number;
  } = {}
) {
  const root = mkdtempSync(join(tmpdir(), "agentlab-execution-test-"));
  temporaryRoots.push(root);
  const artifacts = new FileFactoryArtifactStore(join(root, "artifacts"));
  const documents = new NodeFactoryDocumentCodec();
  const packages = await installSkillPackages(artifacts, documents);
  const policyBundle = encodeCanonicalDocument(defaultFactoryPolicyBundle);
  const policy = new FactoryPolicyEngine(policyBundle.digest);
  const contract = executableContract(packages, policyBundle.digest);
  const repository = new SqliteFactoryRepository(":memory:");
  const conversations = new MemoryConversationRepository();
  conversations.conversations.push(
    storedConversationSchema.parse({
      id: TEST_FACTORY_CONVERSATION_ID,
      title: "Factory test",
      workspacePath: root,
      provider: "codex",
      model: null,
      reasoning: null,
      captainSessionName: buildCaptainSessionName(TEST_FACTORY_CONVERSATION_ID, "codex"),
      createdAt: "2026-08-30T12:00:00.000Z",
      updatedAt: "2026-08-30T12:00:00.000Z",
      lifecycleState: "active",
      ownershipMode: "legacy-name",
      ownershipNonce: null
    })
  );
  let id = 1_000;
  const createId = (): string => `00000000-0000-4000-8000-${String(id++).padStart(12, "0")}`;
  const now = () => "2026-08-30T13:00:00.000Z";
  const evidenceCredentials = {
    controlPlane: createFactoryEvidenceCredential(),
    executionObserver: createFactoryEvidenceCredential(),
    gateObserver: createFactoryEvidenceCredential(),
    prBroker: createFactoryEvidenceCredential()
  };
  const evidenceIngress = new FactoryEvidenceIngress({
    tasks: repository,
    evidence: repository,
    artifacts,
    documents,
    policyBundleDigest: policyBundle.digest,
    bindings: [
      { credential: evidenceCredentials.controlPlane, channel: "control-plane" },
      { credential: evidenceCredentials.executionObserver, channel: "execution-observer" },
      { credential: evidenceCredentials.gateObserver, channel: "gate-observer" },
      {
        credential: evidenceCredentials.prBroker,
        channel: "pr-broker",
        producerId: "test-pr-broker"
      }
    ],
    now,
    createId
  });
  const controlPlane = new FactoryControlPlane({
    tasks: repository,
    evidence: repository,
    controls: repository,
    conversations,
    artifacts,
    documents,
    policy,
    policyBundle,
    evidenceIngress,
    evidenceCredential: evidenceCredentials.controlPlane,
    now,
    createId
  });
  let task = await controlPlane.registerTask(contract, requester);
  for (const nextState of ["qualified", "specified", "planned"] as const) {
    task = await controlPlane.transition({
      taskId: TEST_FACTORY_TASK_ID,
      expectedState: task.state,
      nextState,
      actor: requester,
      reasonCode: "preparation-complete"
    });
  }
  for (const gateId of ["contract-validation", "scope-validation", "policy-validation"]) {
    const artifact = await artifacts.putText(`pass:${gateId}`);
    await evidenceIngress.append(evidenceCredentials.controlPlane, {
      taskId: TEST_FACTORY_TASK_ID,
      contractDigest: task.contractDigest,
      items: [
        evidenceItemSchema.parse({
          id: createId(),
          kind: "test",
          result: "pass",
          subjectDigest: task.contractDigest,
          artifact: { ...artifact, mediaType: "text/plain" },
          producer: gateActor,
          createdAt: now(),
          claims: [{ name: "gate-id", value: gateId }]
        })
      ]
    });
  }
  const executionPolicy = await controlPlane.evaluatePolicy({
    taskId: TEST_FACTORY_TASK_ID,
    stage: "execution",
    approvalSubjectDigest: task.contractDigest,
    currentBaseRevision: contract.repository.baseRevision,
    changeSet: emptyChangeSet(contract),
    usage: zeroUsage,
    usageComplete: true,
    approvals: [],
    scheduled: false
  });
  task = await controlPlane.transition({
    taskId: TEST_FACTORY_TASK_ID,
    expectedState: "planned",
    nextState: "queued",
    actor: policyActor,
    reasonCode: "execution-authorized",
    evidenceBundleDigest: executionPolicy.evidence.digest
  });
  const workspaces = new FakeWorkspaceManager(
    options.mutateAfterGates === true,
    options.failWorkspaceCreation === true
  );
  const agents = new FakeAgentExecutor(options.missingReviewerIdentity === true);
  const gates = new FakeGateExecutor(
    options.failFirstGate === true,
    options.gateWallClockSeconds ?? 1
  );
  const providers: FactoryAgentProviderResolver = {
    resolve: (provider) => Promise.resolve({ executable: `/opt/${provider}`, version: "1.0.0" })
  };
  const service = new FactoryExecutionService({
    tasks: repository,
    evidence: repository,
    conversations,
    controlPlane,
    evidenceIngress,
    evidenceCredentials,
    artifacts,
    documents,
    policy,
    skills: new ArtifactFactorySkillSource(artifacts, documents),
    workspaces,
    agents,
    providers,
    gates,
    now,
    createId
  });
  const pullRequests = (remote: FactoryDraftPullRequestBroker) =>
    new FactoryPullRequestService({
      tasks: repository,
      evidence: repository,
      controls: repository,
      conversations,
      controlPlane,
      evidenceIngress,
      evidenceCredentials,
      artifacts,
      documents,
      remote,
      now,
      createId
    });
  return {
    repository,
    controlPlane,
    service,
    pullRequests,
    workspaces,
    agents,
    gates,
    task
  };
}

class FakeWorkspaceManager implements FactoryWorkspaceManager {
  public readonly createdAttempts: number[] = [];
  public readonly appliedAttempts: number[] = [];
  public readonly closedAttempts: number[] = [];
  readonly #collectCounts = new Map<number, number>();

  public constructor(
    private readonly mutateAfterGates: boolean,
    private readonly failCreation: boolean
  ) {}

  public create(input: CreateFactoryWorkspaceInput): Promise<FactoryWorkspace> {
    this.createdAttempts.push(input.attempt);
    if (this.failCreation) return Promise.reject(new Error("workspace creation failed"));
    const workspace: FactoryWorkspace = {
      id: `00000000-0000-4000-8000-${String(input.attempt).padStart(12, "0")}`,
      taskId: input.taskId,
      attempt: input.attempt,
      repositoryRoot: input.repositoryRoot,
      root: join(input.repositoryRoot, `attempt-${String(input.attempt)}`),
      baseRevision: input.baseRevision,
      closeAndWait: () => {
        this.closedAttempts.push(input.attempt);
        return Promise.resolve();
      }
    };
    return Promise.resolve(workspace);
  }

  public apply(workspace: FactoryWorkspace) {
    this.appliedAttempts.push(workspace.attempt);
    return Promise.resolve();
  }

  public collect(workspace: FactoryWorkspace) {
    const count = (this.#collectCounts.get(workspace.attempt) ?? 0) + 1;
    this.#collectCounts.set(workspace.attempt, count);
    const mutated = this.mutateAfterGates && workspace.attempt === 1 && count >= 2;
    return Promise.resolve(workspacePatch(workspace.attempt, mutated));
  }
}

class FakeAgentExecutor implements FactoryAgentExecutor {
  public readonly roles: string[] = [];

  public constructor(private readonly missingReviewerIdentity: boolean) {}

  public capabilities() {
    return [
      {
        provider: "codex" as const,
        roles: ["implementer" as const, "repairer" as const],
        maximumToolFilesystemAccess: "workspace-write" as const,
        toolNetwork: "off" as const,
        acceptsCommandAllowlist: false,
        acceptsSecrets: false as const
      },
      {
        provider: "claude" as const,
        roles: ["reviewer" as const],
        maximumToolFilesystemAccess: "read-only" as const,
        toolNetwork: "off" as const,
        acceptsCommandAllowlist: false,
        acceptsSecrets: false as const
      }
    ];
  }

  public execute(input: FactoryAgentExecutionInput): Promise<FactoryAgentExecutionOutput> {
    this.roles.push(input.request.role);
    return Promise.resolve(
      successfulRun(
        input.request,
        input.resourceLimits,
        this.missingReviewerIdentity && input.request.role === "reviewer"
      )
    );
  }
}

class FakeGateExecutor implements FactoryGateExecutor {
  readonly #calls = new Map<string, number>();
  #isolationSequence = 1;
  public readonly executed: string[] = [];

  public constructor(
    private readonly failFirstGate: boolean,
    private readonly wallClockSeconds: number
  ) {}

  public availableGateIds(): readonly string[] {
    return externalGateIds;
  }

  public execute(input: FactoryGateExecutionInput): Promise<FactoryGateExecutionOutput> {
    this.executed.push(input.gateId);
    const count = (this.#calls.get(input.gateId) ?? 0) + 1;
    this.#calls.set(input.gateId, count);
    const failed = this.failFirstGate && input.gateId === "format" && count === 1;
    const isolationId = `55555555-5555-4555-8555-${String(this.#isolationSequence++).padStart(12, "0")}`;
    return Promise.resolve({
      gateId: input.gateId,
      evidenceKind:
        input.gateId === "build" ? "build" : input.gateId === "secret-scan" ? "security" : "test",
      command: { executable: "/usr/bin/true", args: [] },
      result: failed ? "fail" : "pass",
      exitCode: failed ? 1 : 0,
      startedAt: "2026-08-30T13:00:00.000Z",
      finishedAt: "2026-08-30T13:00:01.000Z",
      wallClockSeconds: this.wallClockSeconds,
      outputBytes: failed ? 4 : 2,
      stdout: failed ? "" : "ok",
      stderr: failed ? "fail" : "",
      isolation: testIsolation(isolationId, input.resourceLimits)
    });
  }
}

class FakePullRequestBroker implements FactoryDraftPullRequestBroker {
  public readonly opened: OpenFactoryDraftPullRequestInput[] = [];
  public readonly closed: string[] = [];

  public constructor(private readonly governance: FactoryRepositoryGovernance) {}

  public inspect(repositoryId: string) {
    return Promise.resolve({
      repositoryId,
      baseBranch: "main",
      baseRevision: "a".repeat(40),
      governance: this.governance
    });
  }

  public openDraft(input: OpenFactoryDraftPullRequestInput) {
    this.opened.push(input);
    const proposalDigest = encodeCanonicalDocument(input.proposal).digest;
    return Promise.resolve({
      created: true,
      record: {
        schemaVersion: "agentlab.pull-request-record.v1" as const,
        taskId: input.proposal.taskId,
        contractDigest: input.proposal.contractDigest,
        proposalDigest,
        repositoryId: input.proposal.repositoryId,
        number: 42,
        url: "https://github.com/example/agentlab/pull/42",
        baseRevision: input.proposal.baseRevision,
        headRevision: "b".repeat(40),
        branchName: input.proposal.branchName,
        draft: true as const,
        brokerId: "test-pr-broker",
        createdAt: "2026-08-30T13:00:00.000Z"
      }
    });
  }

  public closeDraft(record: { readonly url: string }) {
    this.closed.push(record.url);
    return Promise.resolve();
  }
}

async function installSkillPackages(
  artifacts: FileFactoryArtifactStore,
  documents: NodeFactoryDocumentCodec
) {
  const implement = documents.skillPackage(skillPackage("implement", "codex", []));
  await artifacts.putText(implement.json);
  const repair = documents.skillPackage(skillPackage("repair", "codex", [implement.digest]));
  await artifacts.putText(repair.json);
  const review = documents.skillPackage(skillPackage("review", "claude", [implement.digest]));
  await artifacts.putText(review.json);
  return { implement, repair, review };
}

function executableContract(
  packages: Awaited<ReturnType<typeof installSkillPackages>>,
  policyDigest: string
): ImmutableTaskContract {
  const base = testFactoryContract();
  return immutableTaskContractSchema.parse({
    ...base,
    scope: {
      includePaths: ["tests/runtime/factory-change.test.ts"],
      excludePaths: [],
      protectedPaths: []
    },
    skillPlan: [
      {
        id: "factory/implement",
        version: "1.0.0",
        packageDigest: packages.implement.digest,
        phase: "implement",
        dependsOn: []
      },
      {
        id: "factory/repair",
        version: "1.0.0",
        packageDigest: packages.repair.digest,
        phase: "repair",
        dependsOn: ["factory/implement"]
      },
      {
        id: "factory/review",
        version: "1.0.0",
        packageDigest: packages.review.digest,
        phase: "review",
        dependsOn: ["factory/implement"]
      }
    ],
    gateProfile: { id: "baseline/r1", version: "1.3.0", policyDigest }
  });
}

function skillPackage(
  phase: "implement" | "repair" | "review",
  provider: "codex" | "claude",
  dependencyDigests: readonly string[]
): FactorySkillPackage {
  const base = testFactoryContract();
  const reviewer = phase === "review";
  return {
    schemaVersion: "agentlab.skill-package.v1",
    manifest: {
      schemaVersion: "agentlab.skill-manifest.v1",
      id: `factory/${phase}`,
      version: "1.0.0",
      instructionPath: "SKILL.md",
      description: `${phase} one bounded task.`,
      roles: [phase === "review" ? "reviewer" : phase === "repair" ? "repairer" : "implementer"],
      triggers: [phase === "repair" ? "failure" : "manual"],
      inputSchemaDigest: null,
      outputSchemaDigest: null,
      requestedCapabilities: {
        filesystem: reviewer ? "read" : "workspace-write",
        git: reviewer ? "read" : "worktree-write",
        remoteRepository: "none",
        process: reviewer ? "none" : "sandboxed",
        network: { mode: "off" },
        commandAllowlist: [],
        secretRefs: []
      },
      riskCeiling: "R1",
      allowedFromStates: [reviewer ? "reviewing" : phase === "repair" ? "repairing" : "executing"],
      allowedToStates: [reviewer ? "pr-proposed" : "verifying"],
      providerCompatibility: { mode: "allowlist", providers: [provider] },
      budgetCeiling: base.budget,
      requiredEvidence: reviewer ? ["review"] : ["execution", "patch"],
      dependencyDigests: [...dependencyDigests]
    },
    files: { "SKILL.md": `${phase} only the immutable task contract.` }
  };
}

function successfulRun(
  request: FactoryAgentRunRequest,
  resourceLimits: FactoryResourceLimits,
  missingProviderSession = false
): FactoryAgentExecutionOutput {
  const reviewer = request.role === "reviewer";
  return {
    status: "succeeded",
    exitCode: 0,
    stdout: reviewer ? "review events" : "implementation events",
    stderr: "",
    finalOutput: reviewer
      ? JSON.stringify({ verdict: "approved", summary: "No blocking findings.", findings: [] })
      : "Implemented the bounded change.",
    providerSessionId: missingProviderSession ? null : `session-${request.executionId}`,
    providerVersion: "1.0.0",
    harnessVersion: "test-harness-v1",
    startedAt: "2026-08-30T13:00:00.000Z",
    finishedAt: "2026-08-30T13:00:01.000Z",
    usage: {
      ...zeroUsage,
      wallClockSeconds: 1,
      agentTurns: 1,
      inputTokens: 100,
      outputTokens: 20,
      processes: 1,
      outputBytes: 100,
      workers: 1
    },
    usageComplete: true,
    errorCode: null,
    isolation: testIsolation(request.executionId, resourceLimits)
  };
}

function testIsolation(isolationId: string, limits: FactoryResourceLimits) {
  return {
    isolationId,
    mechanism: { id: "linux/systemd-user-scope", version: "test-systemd-1" },
    scopeName: `agentlab-factory-${isolationId.replaceAll("-", "")}.scope`,
    limits
  } as const;
}

function workspacePatch(attempt: number, mutated: boolean): FactoryWorkspacePatch {
  const suffix = mutated ? "mutated" : `attempt-${String(attempt)}`;
  return {
    patch: `diff --git a/tests/runtime/factory-change.test.ts b/tests/runtime/factory-change.test.ts\n+${suffix}\n`,
    changeSet: {
      baseRevision: "a".repeat(40),
      headRevision: null,
      changedPaths: ["tests/runtime/factory-change.test.ts"],
      binaryPaths: [],
      changedFiles: 1,
      changedLines: 1
    }
  };
}

function emptyChangeSet(contract: ImmutableTaskContract) {
  return {
    baseRevision: contract.repository.baseRevision,
    headRevision: null,
    changedPaths: [],
    binaryPaths: [],
    changedFiles: 0,
    changedLines: 0
  };
}

function requiredPatch(result: Awaited<ReturnType<FactoryExecutionService["execute"]>>) {
  if (result.patch === null) throw new Error("Expected a patch proposal.");
  return result.patch.digest;
}

const externalGateIds = [
  "format",
  "architecture",
  "typecheck",
  "lint",
  "test",
  "build",
  "secret-scan"
] as const;

const strongGovernance: FactoryRepositoryGovernance = {
  requiresPullRequest: true,
  requiredApprovals: 1,
  dismissesStaleReviews: true,
  requiresLastPushApproval: true,
  enforcesAdmins: true,
  allowsForcePushes: false,
  allowsDeletions: false,
  requiredStatusChecks: ["verify"]
};

const requester = {
  kind: "human",
  role: "requester",
  id: "maintainer",
  sessionId: null
} as const;
const policyActor = {
  kind: "control-plane",
  role: "policy-engine",
  id: "agentlab-policy",
  sessionId: null
} as const;
const gateActor = {
  kind: "control-plane",
  role: "gate-runner",
  id: "agentlab-local-gates",
  sessionId: null
} as const;
const zeroUsage: FactoryBudgetUsage = {
  wallClockSeconds: 0,
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
};
