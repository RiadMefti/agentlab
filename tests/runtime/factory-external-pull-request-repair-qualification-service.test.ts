import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  FactoryExternalPullRequestRepairQualificationBundle,
  FactoryExternalPullRequestRepairQualificationEvent,
  FactoryExternalPullRequestRepairQualificationPolicy,
  FactoryExternalPullRequestRepairQualificationRun,
  FactoryResourceLimits
} from "@agentlab/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfiguredFactorySkillSource } from "../../packages/runtime/src/application/configured-factory-skill-source.js";
import { FactoryExternalPullRequestRepairQualificationService } from "../../packages/runtime/src/application/factory-external-pull-request-repair-qualification-service.js";
import type {
  FactoryAgentExecutionOutput,
  FactoryAgentExecutor
} from "../../packages/runtime/src/domain/factory-agent-executor.js";
import {
  assertExternalPullRequestRepairQualificationBundle,
  assertExternalPullRequestRepairQualificationEvent,
  assertExternalPullRequestRepairQualificationRegistration,
  assertExternalPullRequestRepairQualificationRun
} from "../../packages/runtime/src/domain/factory-external-pull-request-repair-qualification-integrity.js";
import type {
  FactoryExternalPullRequestRepairQualificationCandidate,
  FactoryExternalPullRequestRepairQualificationJournalSnapshot,
  FactoryExternalPullRequestRepairQualificationRepository
} from "../../packages/runtime/src/domain/factory-external-pull-request-repair-qualification-repository.js";
import type { CanonicalFactoryDocument } from "../../packages/runtime/src/domain/factory-documents.js";
import type {
  FactoryGateExecutionInput,
  FactoryGateExecutionOutput,
  FactoryGateExecutor
} from "../../packages/runtime/src/domain/factory-gate.js";
import { FileFactoryArtifactStore } from "../../packages/runtime/src/infrastructure/filesystem/file-factory-artifact-store.js";
import {
  testExternalPullRequestRepairQualificationFixture,
  type ExternalPullRequestRepairQualificationFixture
} from "../helpers/factory-external-pull-request-repair-qualification.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("FactoryExternalPullRequestRepairQualificationService", () => {
  it("runs every strict gate, obtains an independent approval, and records qualification", async () => {
    const fixture = testExternalPullRequestRepairQualificationFixture();
    const repository = new MemoryQualificationRepository(fixture);
    const gates = new FakeGateExecutor(fixture);
    const prompts: string[] = [];
    let workspaceClosures = 0;
    const { service } = await serviceFor(fixture, repository, {
      gates,
      execute: (input) => {
        prompts.push(input.prompt);
        return Promise.resolve(
          successfulReviewOutput(input.request.executionId, input.resourceLimits)
        );
      },
      closeWorkspace: () => {
        workspaceClosures += 1;
      }
    });

    await expect(service.preflight()).resolves.toMatchObject({
      status: "ready",
      reviewers: 1,
      remoteWrite: false,
      autoMerge: false,
      release: false
    });
    await expect(service.tick(pins(fixture))).resolves.toMatchObject({
      status: "completed",
      completed: 1,
      qualified: 1,
      rejected: 0,
      quarantined: 0
    });
    expect(gates.executed).toEqual(fixture.policy.gateProfile.gates.map(({ id }) => id));
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("BEGIN UNTRUSTED SELECTED FINDINGS");
    expect(prompts[0]).toContain("BEGIN UNTRUSTED REPAIRED PATCH");
    expect(prompts[0]).toContain("contact a network service");
    expect(workspaceClosures).toBe(1);
    expect(repository.snapshot?.bundle).toMatchObject({
      decision: "qualified",
      workspaceUnchanged: true,
      workspaceClosed: true,
      remoteWrite: false,
      autoMerge: false,
      release: false
    });
    expect(repository.snapshot?.bundle?.gateObservations).toHaveLength(7);
    expect(repository.snapshot?.bundle?.reviews).toHaveLength(1);
    await expect(service.tick(pins(fixture))).resolves.toMatchObject({ status: "idle" });
  });

  it("rejects a failed strict gate without running a reviewer", async () => {
    const fixture = testExternalPullRequestRepairQualificationFixture();
    const repository = new MemoryQualificationRepository(fixture);
    const gates = new FakeGateExecutor(fixture, { failGateId: "lint" });
    const execute = vi.fn();
    const { service } = await serviceFor(fixture, repository, { gates, execute });

    await expect(service.tick(pins(fixture))).resolves.toMatchObject({
      status: "completed",
      qualified: 0,
      rejected: 1
    });
    expect(gates.executed).toEqual(["format", "architecture", "typecheck", "lint"]);
    expect(execute).not.toHaveBeenCalled();
    expect(repository.snapshot?.bundle?.decision).toBe("rejected");
  });

  it("quarantines a reviewer that reuses the repairer provider session", async () => {
    const fixture = testExternalPullRequestRepairQualificationFixture();
    const repository = new MemoryQualificationRepository(fixture);
    const gates = new FakeGateExecutor(fixture);
    const { service } = await serviceFor(fixture, repository, {
      gates,
      execute: (input) =>
        Promise.resolve({
          ...successfulReviewOutput(input.request.executionId, input.resourceLimits),
          providerSessionId: fixture.repairerRecord.value.providerSessionId
        })
    });

    await expect(service.tick(pins(fixture))).resolves.toMatchObject({
      status: "blocked",
      quarantined: 1,
      reasonCodes: ["repair-qualification-reviewer-independence-invalid"]
    });
    expect(repository.snapshot?.state).toBe("quarantined");
    expect(repository.snapshot?.bundle).toBeNull();
  });

  it("journals an uncertain gate and quarantines it on recovery without rerunning", async () => {
    const fixture = testExternalPullRequestRepairQualificationFixture();
    const repository = new MemoryQualificationRepository(fixture);
    const gates = new FakeGateExecutor(fixture, { rejectGate: true });
    const reconcile = vi.fn(() => Promise.resolve({ status: "inactive" as const }));
    const { service } = await serviceFor(fixture, repository, {
      gates,
      execute: vi.fn(),
      reconcile
    });

    await expect(service.tick(pins(fixture))).rejects.toThrow("gate outcome lost");
    expect(repository.snapshot?.state).toBe("gate-active");
    await expect(service.tick(pins(fixture))).resolves.toMatchObject({
      status: "blocked",
      quarantined: 1,
      reasonCodes: ["gate-outcome-unrecoverable"]
    });
    expect(gates.executed).toEqual(["format"]);
    expect(reconcile).toHaveBeenCalledOnce();
  });
});

async function serviceFor(
  fixture: ExternalPullRequestRepairQualificationFixture,
  repository: MemoryQualificationRepository,
  options: {
    readonly gates: FactoryGateExecutor;
    readonly execute: FactoryAgentExecutor["execute"];
    readonly closeWorkspace?: () => void;
    readonly reconcile?: () => Promise<{ readonly status: "inactive" }>;
  }
) {
  const root = mkdtempSync(join(tmpdir(), "agentlab-external-repair-qualification-"));
  roots.push(root);
  const artifacts = new FileFactoryArtifactStore(join(root, "artifacts"));
  await Promise.all([
    artifacts.putText(fixture.repairedPatch),
    artifacts.putText(fixture.repairerRecord.json)
  ]);
  const service = new FactoryExternalPullRequestRepairQualificationService({
    repositoryRoot: "/srv/agentlab",
    qualificationPolicy: fixture.policyDocument,
    repairExecutionPolicy: fixture.execution.executionPolicyDocument,
    repository,
    controls: { state: () => Promise.resolve({ scheduler: true, prBroker: false }) },
    artifacts,
    documents: fixture.documents,
    skills: new ConfiguredFactorySkillSource([fixture.reviewerSkill], artifacts, fixture.documents),
    workspaces: {
      prepare: (input) =>
        Promise.resolve({
          workspace: {
            id: input.workspaceId,
            taskId: input.qualificationRunId,
            attempt: 1,
            repositoryRoot: input.repositoryRoot,
            root: "/srv/agentlab-external-repair-qualification-worktree",
            baseRevision: input.expectedHeadRevision,
            closeAndWait: () => Promise.resolve()
          },
          patch: input.patch,
          patchDigest: input.expectedPatchDigest,
          patchArtifact: fixture.repairBundle.value.patchArtifact,
          changeSet: input.expectedChangeSet,
          assertUnchanged: () => Promise.resolve(),
          close: () => {
            options.closeWorkspace?.();
            return Promise.resolve();
          }
        })
    },
    recovery: { reconcile: options.reconcile ?? (() => Promise.resolve({ status: "inactive" })) },
    gates: options.gates,
    agents: {
      capabilities: () => [agentCapability()],
      preflight: () => undefined,
      execute: options.execute
    },
    providers: {
      resolve: () => Promise.resolve({ executable: "/opt/codex", version: "codex 1" })
    },
    now: () => "2026-09-01T12:30:00.000Z",
    createId: idFactory()
  });
  return { service, artifacts };
}

class FakeGateExecutor implements FactoryGateExecutor {
  public readonly executed: string[] = [];

  public constructor(
    private readonly fixture: ExternalPullRequestRepairQualificationFixture,
    private readonly options: { readonly failGateId?: string; readonly rejectGate?: boolean } = {}
  ) {}

  public availableGateIds() {
    return this.fixture.policy.gateProfile.gates.map(({ id }) => id);
  }

  public execute(input: FactoryGateExecutionInput): Promise<FactoryGateExecutionOutput> {
    this.executed.push(input.gateId);
    if (this.options.rejectGate === true) return Promise.reject(new Error("gate outcome lost"));
    const definition = this.fixture.policy.gateProfile.gates.find(({ id }) => id === input.gateId);
    if (definition === undefined) return Promise.reject(new Error("missing gate"));
    const failed = this.options.failGateId === input.gateId;
    return Promise.resolve({
      gateId: input.gateId,
      evidenceKind: definition.evidenceKind,
      command: { executable: definition.command.executable, args: definition.command.args },
      result: failed ? "fail" : "pass",
      exitCode: failed ? 1 : 0,
      startedAt: "2026-09-01T12:30:00.000Z",
      finishedAt: "2026-09-01T12:30:01.000Z",
      wallClockSeconds: 1,
      outputBytes: 2,
      stdout: failed ? "" : "ok",
      stderr: failed ? "failed" : "",
      isolation: isolation(input.isolationId, input.resourceLimits)
    });
  }
}

class MemoryQualificationRepository implements FactoryExternalPullRequestRepairQualificationRepository {
  public snapshot: FactoryExternalPullRequestRepairQualificationJournalSnapshot | null = null;
  #candidateAvailable = true;

  public constructor(private readonly fixture: ExternalPullRequestRepairQualificationFixture) {}

  public listCompletedRepairs() {
    return Promise.resolve(this.#candidateAvailable ? [this.fixture.candidate] : []);
  }

  public listActive() {
    return Promise.resolve(
      this.snapshot !== null &&
        !["completed", "failed", "quarantined"].includes(this.snapshot.state)
        ? [this.snapshot]
        : []
    );
  }

  public findCandidateByRepairBundle() {
    return Promise.resolve(this.fixture.candidate);
  }

  public register(
    policy: CanonicalFactoryDocument<FactoryExternalPullRequestRepairQualificationPolicy>,
    run: CanonicalFactoryDocument<FactoryExternalPullRequestRepairQualificationRun>,
    event: CanonicalFactoryDocument<FactoryExternalPullRequestRepairQualificationEvent>,
    candidate: FactoryExternalPullRequestRepairQualificationCandidate
  ) {
    this.#candidateAvailable = false;
    assertExternalPullRequestRepairQualificationRun(
      policy,
      candidate,
      run,
      this.fixture.repairerRecord,
      this.fixture.documents
    );
    assertExternalPullRequestRepairQualificationRegistration(run, event);
    this.snapshot = snapshot(run, [event], null);
    return Promise.resolve(this.snapshot);
  }

  public findByRepairBundle() {
    return Promise.resolve(this.snapshot);
  }

  public append(
    event: CanonicalFactoryDocument<FactoryExternalPullRequestRepairQualificationEvent>
  ) {
    if (this.snapshot === null) return Promise.resolve(null);
    const run = this.fixture.documents.externalPullRequestRepairQualificationRun(this.snapshot.run);
    const history = this.snapshot.history.map((value) =>
      this.fixture.documents.externalPullRequestRepairQualificationEvent(value)
    );
    assertExternalPullRequestRepairQualificationEvent(run, event, history);
    this.snapshot = snapshot(run, [...history, event], this.snapshot.bundle);
    return Promise.resolve(this.snapshot);
  }

  public recordBundle(
    event: CanonicalFactoryDocument<FactoryExternalPullRequestRepairQualificationEvent>,
    bundle: CanonicalFactoryDocument<FactoryExternalPullRequestRepairQualificationBundle>
  ) {
    if (this.snapshot === null) return Promise.resolve(null);
    const run = this.fixture.documents.externalPullRequestRepairQualificationRun(this.snapshot.run);
    const history = this.snapshot.history.map((value) =>
      this.fixture.documents.externalPullRequestRepairQualificationEvent(value)
    );
    assertExternalPullRequestRepairQualificationEvent(run, event, history);
    assertExternalPullRequestRepairQualificationBundle(
      run,
      bundle,
      event,
      history,
      this.fixture.documents
    );
    this.snapshot = snapshot(run, [...history, event], bundle.value);
    return Promise.resolve(this.snapshot);
  }

  public close(): void {
    return undefined;
  }
}

function snapshot(
  run: CanonicalFactoryDocument<FactoryExternalPullRequestRepairQualificationRun>,
  history: readonly CanonicalFactoryDocument<FactoryExternalPullRequestRepairQualificationEvent>[],
  bundle: FactoryExternalPullRequestRepairQualificationBundle | null
): FactoryExternalPullRequestRepairQualificationJournalSnapshot {
  const last = history.at(-1);
  if (last === undefined) throw new Error("Test qualification journal is empty.");
  return {
    run: run.value,
    runDigest: run.digest,
    state: last.value.to,
    sequence: last.value.sequence,
    lastEvent: last.value,
    lastEventDigest: last.digest,
    history: history.map(({ value }) => value),
    bundle
  };
}

function pins(fixture: ExternalPullRequestRepairQualificationFixture) {
  return {
    expectedQualificationPolicyDigest: fixture.policyDocument.digest,
    expectedRepairExecutionPolicyDigest: fixture.execution.executionPolicyDocument.digest,
    expectedCostPolicyDigest: fixture.policy.costPolicyDigest,
    expectedRoleIdentityPolicyDigest: fixture.policy.roleIdentityPolicyDigest,
    expectedGateProfileDigest: fixture.policy.gateProfileDigest
  };
}

function agentCapability() {
  return {
    provider: "codex" as const,
    roles: ["reviewer"] as const,
    preparationPhases: [],
    maintenanceDiscovery: false,
    maximumToolFilesystemAccess: "workspace-write" as const,
    toolNetwork: "off" as const,
    acceptsCommandAllowlist: false,
    acceptsSecrets: false as const
  };
}

function successfulReviewOutput(
  executionId: string,
  limits: FactoryResourceLimits
): FactoryAgentExecutionOutput {
  return {
    status: "succeeded",
    exitCode: 0,
    stdout: "{}\n",
    stderr: "",
    finalOutput: JSON.stringify({
      verdict: "approved",
      summary: "The selected finding is repaired with focused coverage.",
      findings: []
    }),
    providerSessionId: "independent-reviewer-session",
    providerVersion: "codex 1",
    harnessVersion: "agentlab-test-harness/1",
    startedAt: "2026-09-01T12:30:10.000Z",
    finishedAt: "2026-09-01T12:30:20.000Z",
    usage: {
      wallClockSeconds: 10,
      agentTurns: 1,
      toolCalls: 1,
      inputTokens: 1_000,
      outputTokens: 200,
      costMicrousd: 100,
      processes: 1,
      outputBytes: 1_000,
      workers: 1,
      repairAttempts: 0,
      changedFiles: 0,
      changedLines: 0
    },
    usageComplete: true,
    errorCode: null,
    isolation: isolation(executionId, limits)
  };
}

function isolation(isolationId: string, limits: FactoryResourceLimits) {
  return {
    isolationId,
    mechanism: { id: "linux/systemd-user-scope" as const, version: "systemd 261" },
    scopeName: `agentlab-factory-${isolationId.replaceAll("-", "")}.scope`,
    limits
  };
}

function idFactory(): () => string {
  let next = 20;
  return () => `96000000-0000-4000-8000-${String(next++).padStart(12, "0")}`;
}
