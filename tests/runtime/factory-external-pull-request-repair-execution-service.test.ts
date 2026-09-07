import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  FactoryExternalPullRequestRepairBundle,
  FactoryExternalPullRequestRepairExecutionEvent,
  FactoryExternalPullRequestRepairExecutionPolicy,
  FactoryExternalPullRequestRepairExecutionRun,
  FactoryExternalPullRequestRepairAdmissionPolicy,
  FactoryResourceLimits,
  Sha256Digest
} from "@agentlab/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfiguredFactorySkillSource } from "../../packages/runtime/src/application/configured-factory-skill-source.js";
import { FactoryExternalPullRequestRepairExecutionService } from "../../packages/runtime/src/application/factory-external-pull-request-repair-execution-service.js";
import type {
  FactoryAgentExecutionOutput,
  FactoryAgentExecutor
} from "../../packages/runtime/src/domain/factory-agent-executor.js";
import {
  assertExternalPullRequestRepairBundle,
  assertExternalPullRequestRepairExecutionEvent,
  assertExternalPullRequestRepairExecutionRegistration,
  assertExternalPullRequestRepairExecutionRun
} from "../../packages/runtime/src/domain/factory-external-pull-request-repair-execution-integrity.js";
import type {
  FactoryExternalPullRequestRepairExecutionCandidate,
  FactoryExternalPullRequestRepairExecutionJournalSnapshot,
  FactoryExternalPullRequestRepairExecutionRepository
} from "../../packages/runtime/src/domain/factory-external-pull-request-repair-execution-repository.js";
import { FactoryExternalPullRequestRepairWorkspaceCleanupUnconfirmedError } from "../../packages/runtime/src/domain/factory-external-pull-request-repair-workspace.js";
import type { CanonicalFactoryDocument } from "../../packages/runtime/src/domain/factory-documents.js";
import { FileFactoryArtifactStore } from "../../packages/runtime/src/infrastructure/filesystem/file-factory-artifact-store.js";
import { testDigest } from "../helpers/factory.js";
import {
  externalPullRequestRepairExecutionRun,
  registeredExternalPullRequestRepairExecutionEvent,
  testExternalPullRequestRepairExecutionFixture,
  type ExternalPullRequestRepairExecutionFixture
} from "../helpers/factory-external-pull-request-repair-execution.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("FactoryExternalPullRequestRepairExecutionService", () => {
  it("executes one credentialless repair and emits a closed-workspace patch bundle", async () => {
    const fixture = testExternalPullRequestRepairExecutionFixture();
    const repository = new MemoryRepairExecutionRepository(fixture);
    const prompts: string[] = [];
    let workspaceClosures = 0;
    const service = serviceFor(fixture, repository, {
      controls: { state: () => Promise.resolve({ scheduler: true, prBroker: false }) },
      execute: (input) => {
        prompts.push(input.prompt);
        return Promise.resolve(successfulOutput(input.request.executionId, input.resourceLimits));
      },
      closeWorkspace: () => {
        workspaceClosures += 1;
      }
    });

    await expect(service.preflight()).resolves.toMatchObject({
      status: "ready",
      repairAttempts: 1,
      remoteWrite: false,
      autoMerge: false,
      release: false
    });
    await expect(service.tick(pins(fixture))).resolves.toMatchObject({
      status: "completed",
      inspected: 1,
      completed: 1,
      failed: 0,
      quarantined: 0
    });

    expect(workspaceClosures).toBe(1);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("BEGIN UNTRUSTED SELECTED REVIEW EVIDENCE");
    expect(prompts[0]).toContain("Correct the behavior and retain the focused regression test.");
    expect(prompts[0]).toContain("Never contact a network service");
    expect(repository.snapshot?.bundle).toMatchObject({
      publicationMode: "replacement-draft",
      remoteWrite: false,
      autoMerge: false,
      release: false,
      workspaceClosed: true,
      repairAttempt: 1,
      changeSet: { changedPaths: ["tracked.txt"], changedFiles: 1, changedLines: 2 }
    });
    await expect(service.tick(pins(fixture))).resolves.toMatchObject({
      status: "idle",
      inspected: 0
    });
  });

  it("stops before agent execution when the scheduler is revoked", async () => {
    const fixture = testExternalPullRequestRepairExecutionFixture();
    const repository = new MemoryRepairExecutionRepository(fixture);
    let controlReads = 0;
    const execute = vi.fn();
    const service = serviceFor(fixture, repository, {
      controls: {
        state: () => {
          controlReads += 1;
          return Promise.resolve({ scheduler: controlReads < 3, prBroker: false });
        }
      },
      execute
    });

    await expect(service.tick(pins(fixture))).resolves.toMatchObject({
      status: "blocked",
      failed: 1,
      reasonCodes: ["scheduler-disabled-before-external-repair"]
    });
    expect(execute).not.toHaveBeenCalled();
    expect(repository.snapshot?.state).toBe("failed");
  });

  it("quarantines an uncertain started repair and never runs a second attempt", async () => {
    const fixture = testExternalPullRequestRepairExecutionFixture();
    const repository = new MemoryRepairExecutionRepository(fixture);
    const execute = vi.fn(() => Promise.reject(new Error("provider outcome lost")));
    const service = serviceFor(fixture, repository, {
      controls: { state: () => Promise.resolve({ scheduler: true, prBroker: false }) },
      execute
    });

    await expect(service.tick(pins(fixture))).resolves.toMatchObject({
      status: "blocked",
      failed: 0,
      quarantined: 1,
      reasonCodes: ["external-repair-execution-failed"]
    });
    await expect(service.tick(pins(fixture))).resolves.toMatchObject({ status: "idle" });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(repository.snapshot?.state).toBe("quarantined");
  });

  it("reconciles a started run even while fresh execution is blocked", async () => {
    const fixture = testExternalPullRequestRepairExecutionFixture();
    const repository = new MemoryRepairExecutionRepository(fixture);
    const run = externalPullRequestRepairExecutionRun(fixture);
    const registered = registeredExternalPullRequestRepairExecutionEvent(fixture, run);
    await repository.register(
      fixture.admission.policyDocument,
      fixture.executionPolicyDocument,
      run,
      registered,
      fixture.candidate
    );
    const started = executionEvent(fixture, run, 2, registered.digest, {
      kind: "workspace-started",
      from: "ready",
      to: "workspace-active",
      reasonCode: "exact-external-pr-head-workspace-started"
    });
    await repository.append(started);
    const prepared = executionEvent(fixture, run, 3, started.digest, {
      kind: "workspace-prepared",
      from: "workspace-active",
      to: "prepared",
      sourcePatchDigest: run.value.originalPatchDigest,
      sourcePatchArtifact: {
        digest: run.value.originalPatchDigest,
        mediaType: "application/vnd.git.patch",
        sizeBytes: 42
      },
      reasonCode: "exact-reviewed-patch-and-head-materialized"
    });
    await repository.append(prepared);
    const repairerStarted = executionEvent(fixture, run, 4, prepared.digest, {
      kind: "repairer-started",
      from: "prepared",
      to: "repairer-active",
      repairerId: fixture.executionPolicy.repairerProfile.id,
      executionId: "95000000-0000-4000-8000-000000000030",
      requestDigest: testDigest("b"),
      reasonCode: "credentialless-external-repairer-started"
    });
    await repository.append(repairerStarted);
    const reconcile = vi.fn(() => Promise.resolve({ status: "inactive" as const }));
    const execute = vi.fn();
    const service = serviceFor(fixture, repository, {
      controls: { state: () => Promise.resolve({ scheduler: false, prBroker: false }) },
      execute,
      reconcile
    });

    await expect(service.tick(pins(fixture))).resolves.toMatchObject({
      status: "blocked",
      quarantined: 1,
      reasonCodes: ["repairer-outcome-unrecoverable"]
    });
    expect(reconcile).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
  });

  it("leaves a cleanup-uncertain workspace active for recovery", async () => {
    const fixture = testExternalPullRequestRepairExecutionFixture();
    const repository = new MemoryRepairExecutionRepository(fixture);
    const cleanupFailure = new FactoryExternalPullRequestRepairWorkspaceCleanupUnconfirmedError(
      "External repair workspace preparation cleanup was not confirmed.",
      new Error("worktree cleanup outcome lost")
    );
    const execute = vi.fn();
    const service = serviceFor(fixture, repository, {
      controls: { state: () => Promise.resolve({ scheduler: true, prBroker: false }) },
      execute,
      prepareError: cleanupFailure
    });

    await expect(service.tick(pins(fixture))).rejects.toBe(cleanupFailure);
    expect(repository.snapshot?.state).toBe("workspace-active");
    expect(execute).not.toHaveBeenCalled();
  });
});

function serviceFor(
  fixture: ExternalPullRequestRepairExecutionFixture,
  repository: MemoryRepairExecutionRepository,
  options: {
    readonly controls: { state(): Promise<{ scheduler: boolean; prBroker: boolean }> };
    readonly execute: FactoryAgentExecutor["execute"];
    readonly closeWorkspace?: () => void;
    readonly reconcile?: () => Promise<{ readonly status: "inactive" }>;
    readonly prepareError?: Error;
  }
) {
  const root = mkdtempSync(join(tmpdir(), "agentlab-external-pr-repair-execution-"));
  roots.push(root);
  const artifacts = new FileFactoryArtifactStore(join(root, "artifacts"));
  const headRevision = fixture.authorization.value.expectedHeadRevision;
  return new FactoryExternalPullRequestRepairExecutionService({
    repositoryRoot: "/srv/agentlab",
    admissionPolicy: fixture.admission.policyDocument,
    executionPolicy: fixture.executionPolicyDocument,
    repository,
    controls: options.controls,
    artifacts,
    documents: fixture.documents,
    skills: new ConfiguredFactorySkillSource([fixture.skillPackage], artifacts, fixture.documents),
    workspaces: {
      prepare: (input) => {
        if (options.prepareError !== undefined) return Promise.reject(options.prepareError);
        return Promise.resolve({
          workspace: {
            id: input.workspaceId,
            taskId: input.repairRunId,
            attempt: 1,
            repositoryRoot: input.repositoryRoot,
            root: "/srv/agentlab-external-repair-worktree",
            baseRevision: headRevision,
            closeAndWait: () => Promise.resolve()
          },
          sourcePatch: "diff --git a/tracked.txt b/tracked.txt\n",
          sourcePatchDigest: input.expectedPatchDigest,
          sourcePatchArtifact: {
            digest: input.expectedPatchDigest,
            mediaType: "application/vnd.git.patch",
            sizeBytes: 42
          },
          close: () => {
            options.closeWorkspace?.();
            return Promise.resolve();
          }
        });
      },
      collect: () =>
        Promise.resolve({
          patch: "diff --git a/tracked.txt b/tracked.txt\n-old\n+new\n",
          changeSet: {
            baseRevision: headRevision,
            headRevision: null,
            changedPaths: ["tracked.txt"],
            binaryPaths: [],
            changedFiles: 1,
            changedLines: 2
          }
        })
    },
    recovery: { reconcile: options.reconcile ?? (() => Promise.resolve({ status: "inactive" })) },
    agents: {
      capabilities: () => [agentCapability()],
      preflight: () => undefined,
      execute: options.execute
    },
    providers: {
      resolve: () => Promise.resolve({ executable: "/opt/codex", version: "codex 1" })
    },
    now: () => "2026-09-01T12:25:00.000Z",
    createId: idFactory()
  });
}

class MemoryRepairExecutionRepository implements FactoryExternalPullRequestRepairExecutionRepository {
  public snapshot: FactoryExternalPullRequestRepairExecutionJournalSnapshot | null = null;
  #candidateAvailable = true;

  public constructor(private readonly fixture: ExternalPullRequestRepairExecutionFixture) {}

  public listAdmitted() {
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

  public findCandidateByAuthorization() {
    return Promise.resolve(this.fixture.candidate);
  }

  public register(
    admissionPolicy: CanonicalFactoryDocument<FactoryExternalPullRequestRepairAdmissionPolicy>,
    executionPolicy: CanonicalFactoryDocument<FactoryExternalPullRequestRepairExecutionPolicy>,
    run: CanonicalFactoryDocument<FactoryExternalPullRequestRepairExecutionRun>,
    event: CanonicalFactoryDocument<FactoryExternalPullRequestRepairExecutionEvent>,
    candidate: FactoryExternalPullRequestRepairExecutionCandidate
  ) {
    this.#candidateAvailable = false;
    assertExternalPullRequestRepairExecutionRun(
      admissionPolicy,
      executionPolicy,
      candidate,
      run,
      this.fixture.documents,
      "2026-09-01T12:25:00.000Z"
    );
    assertExternalPullRequestRepairExecutionRegistration(run, event);
    this.snapshot = snapshot(run, [event], null);
    return Promise.resolve(this.snapshot);
  }

  public findByAuthorization() {
    return Promise.resolve(this.snapshot);
  }

  public append(event: CanonicalFactoryDocument<FactoryExternalPullRequestRepairExecutionEvent>) {
    if (this.snapshot === null) return Promise.resolve(null);
    const run = this.fixture.documents.externalPullRequestRepairExecutionRun(this.snapshot.run);
    const history = this.snapshot.history.map((value) =>
      this.fixture.documents.externalPullRequestRepairExecutionEvent(value)
    );
    assertExternalPullRequestRepairExecutionEvent(run, event, history);
    this.snapshot = snapshot(run, [...history, event], this.snapshot.bundle);
    return Promise.resolve(this.snapshot);
  }

  public recordBundle(
    event: CanonicalFactoryDocument<FactoryExternalPullRequestRepairExecutionEvent>,
    bundle: CanonicalFactoryDocument<FactoryExternalPullRequestRepairBundle>
  ) {
    if (this.snapshot === null) return Promise.resolve(null);
    const run = this.fixture.documents.externalPullRequestRepairExecutionRun(this.snapshot.run);
    const history = this.snapshot.history.map((value) =>
      this.fixture.documents.externalPullRequestRepairExecutionEvent(value)
    );
    assertExternalPullRequestRepairExecutionEvent(run, event, history);
    assertExternalPullRequestRepairBundle(run, bundle, event);
    this.snapshot = snapshot(run, [...history, event], bundle.value);
    return Promise.resolve(this.snapshot);
  }

  public close(): void {
    // The in-memory journal owns no external resources.
  }
}

function snapshot(
  run: CanonicalFactoryDocument<FactoryExternalPullRequestRepairExecutionRun>,
  history: readonly CanonicalFactoryDocument<FactoryExternalPullRequestRepairExecutionEvent>[],
  bundle: FactoryExternalPullRequestRepairBundle | null
): FactoryExternalPullRequestRepairExecutionJournalSnapshot {
  const last = history.at(-1);
  if (last === undefined) throw new Error("Test external repair journal is empty.");
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

type EventPayload<
  Event extends FactoryExternalPullRequestRepairExecutionEvent =
    FactoryExternalPullRequestRepairExecutionEvent
> = Event extends FactoryExternalPullRequestRepairExecutionEvent
  ? Omit<
      Event,
      | "schemaVersion"
      | "eventId"
      | "repairRunId"
      | "runDigest"
      | "sequence"
      | "previousEventDigest"
      | "actor"
      | "occurredAt"
      | "correlationId"
    >
  : never;

function executionEvent(
  fixture: ExternalPullRequestRepairExecutionFixture,
  run: CanonicalFactoryDocument<FactoryExternalPullRequestRepairExecutionRun>,
  sequence: number,
  previousEventDigest: Sha256Digest,
  payload: EventPayload
) {
  return fixture.documents.externalPullRequestRepairExecutionEvent({
    schemaVersion: "agentlab.external-pull-request-repair-execution-event.v1",
    eventId: `95000000-0000-4000-8000-${String(sequence + 30).padStart(12, "0")}`,
    repairRunId: run.value.runId,
    runDigest: run.digest,
    sequence,
    previousEventDigest,
    actor: {
      kind: "control-plane",
      role: "policy-engine",
      id: "agentlab/external-pull-request-repair-execution",
      sessionId: run.value.runId
    },
    ...payload,
    occurredAt: "2026-09-01T12:25:00.000Z",
    correlationId: run.value.correlationId
  });
}

function pins(fixture: ExternalPullRequestRepairExecutionFixture) {
  return {
    expectedRepairExecutionPolicyDigest: fixture.executionPolicyDocument.digest,
    expectedAdmissionPolicyDigest: fixture.admission.policyDocument.digest,
    expectedReviewPolicyDigest: fixture.admission.policy.reviewPolicyDigest,
    expectedFeedbackPolicyDigest: fixture.admission.policy.feedbackPolicyDigest,
    expectedCostPolicyDigest: fixture.executionPolicy.costPolicyDigest,
    expectedRoleIdentityPolicyDigest: fixture.executionPolicy.roleIdentityPolicyDigest,
    expectedGateProfileDigest: fixture.executionPolicy.gateProfileDigest
  };
}

function agentCapability() {
  return {
    provider: "codex" as const,
    roles: ["repairer"] as const,
    preparationPhases: [],
    maintenanceDiscovery: false,
    maximumToolFilesystemAccess: "workspace-write" as const,
    toolNetwork: "off" as const,
    acceptsCommandAllowlist: false,
    acceptsSecrets: false as const
  };
}

function successfulOutput(
  executionId: string,
  limits: FactoryResourceLimits
): FactoryAgentExecutionOutput {
  return {
    status: "succeeded" as const,
    exitCode: 0,
    stdout: "{}\n",
    stderr: "",
    finalOutput: "Repaired the selected finding.",
    providerSessionId: "provider-session-1",
    providerVersion: "codex 1",
    harnessVersion: "agentlab-test-harness/1",
    startedAt: "2026-09-01T12:25:00.000Z",
    finishedAt: "2026-09-01T12:25:10.000Z",
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
    isolation: {
      isolationId: executionId,
      mechanism: { id: "linux/systemd-user-scope" as const, version: "systemd 261" },
      scopeName: `agentlab-factory-${executionId.replaceAll("-", "")}.scope`,
      limits
    }
  };
}

function idFactory(): () => string {
  let next = 10;
  return () => `95000000-0000-4000-8000-${String(next++).padStart(12, "0")}`;
}
