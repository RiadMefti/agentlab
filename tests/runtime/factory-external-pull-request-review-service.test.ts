import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  FactoryExternalPullRequestReviewBundle,
  FactoryExternalPullRequestReviewEvent,
  FactoryExternalPullRequestReviewRun
} from "@agentlab/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { ConfiguredFactorySkillSource } from "../../packages/runtime/src/application/configured-factory-skill-source.js";
import { FactoryExternalPullRequestReviewService } from "../../packages/runtime/src/application/factory-external-pull-request-review-service.js";
import {
  assertExternalPullRequestReviewBundle,
  assertExternalPullRequestReviewEvent,
  assertExternalPullRequestReviewRegistration,
  assertExternalPullRequestReviewRun
} from "../../packages/runtime/src/domain/factory-external-pull-request-review-integrity.js";
import type {
  FactoryExternalPullRequestReviewJournalSnapshot,
  FactoryExternalPullRequestReviewRepository
} from "../../packages/runtime/src/domain/factory-external-pull-request-review-repository.js";
import type { CanonicalFactoryDocument } from "../../packages/runtime/src/domain/factory-documents.js";
import { FileFactoryArtifactStore } from "../../packages/runtime/src/infrastructure/filesystem/file-factory-artifact-store.js";
import { testExternalPullRequestReviewFixture } from "../helpers/factory-external-pull-request-review.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("FactoryExternalPullRequestReviewService", () => {
  it("produces independent immutable evidence and routes a split verdict to a human", async () => {
    const fixture = testExternalPullRequestReviewFixture();
    const root = temporaryRoot();
    const artifacts = new FileFactoryArtifactStore(join(root, "artifacts"));
    const patch = "diff --git a/tracked.txt b/tracked.txt\n";
    const storedPatch = await artifacts.putText(patch);
    const repository = new MemoryReviewRepository(fixture);
    const prompts: string[] = [];
    let executions = 0;
    let unchangedAssertions = 0;
    let workspaceClosures = 0;
    const createId = idFactory();
    const service = new FactoryExternalPullRequestReviewService({
      repositoryRoot: "/srv/agentlab",
      reviewPolicy: fixture.policyDocument,
      costPolicyDigest: fixture.run.value.costPolicyDigest,
      repository,
      artifacts,
      documents: fixture.documents,
      skills: new ConfiguredFactorySkillSource(fixture.skillPackages, artifacts, fixture.documents),
      workspaces: {
        prepare: (input) =>
          Promise.resolve({
            workspace: {
              id: input.workspaceId,
              taskId: input.reviewRunId,
              attempt: 1,
              repositoryRoot: input.repositoryRoot,
              root: "/srv/agentlab-review-worktree",
              baseRevision: input.candidate.head.revision,
              closeAndWait: () => Promise.resolve()
            },
            patch,
            patchDigest: storedPatch.digest,
            patchArtifact: {
              ...storedPatch,
              mediaType: "application/vnd.git.patch"
            },
            assertUnchanged: () => {
              unchangedAssertions += 1;
              return Promise.resolve();
            },
            close: () => {
              workspaceClosures += 1;
              return Promise.resolve();
            }
          })
      },
      recovery: { reconcile: () => Promise.resolve({ status: "inactive" }) },
      providers: {
        resolve: (provider) =>
          Promise.resolve({ executable: `/opt/${provider}`, version: `${provider} 1` })
      },
      agents: {
        capabilities: () => ["codex", "claude"].map(agentCapability),
        preflight: () => undefined,
        execute: (input) => {
          prompts.push(input.prompt);
          executions += 1;
          return Promise.resolve({
            status: "succeeded",
            exitCode: 0,
            stdout: "{}\n",
            stderr: "",
            finalOutput: JSON.stringify({
              verdict: executions === 1 ? "approved" : "changes-requested",
              summary: executions === 1 ? "No blocking findings." : "One blocking defect.",
              findings:
                executions === 1
                  ? []
                  : [
                      {
                        id: "review/blocking-defect",
                        severity: "high",
                        path: "tracked.txt",
                        line: 1,
                        title: "Incorrect behavior",
                        detail: "The changed behavior needs a focused correction."
                      }
                    ]
            }),
            providerSessionId: `provider-session-${String(executions)}`,
            providerVersion: input.providerVersion,
            harnessVersion: "agentlab-test-harness/1",
            startedAt: "2026-09-01T12:10:00.000Z",
            finishedAt: "2026-09-01T12:10:10.000Z",
            usage: usage(),
            usageComplete: true,
            errorCode: null,
            isolation: {
              isolationId: input.request.executionId,
              mechanism: { id: "linux/systemd-user-scope", version: "systemd 261" },
              scopeName: `agentlab-factory-${input.request.executionId.replaceAll("-", "")}.scope`,
              limits: input.resourceLimits
            }
          });
        }
      },
      now: () => "2026-09-01T12:10:00.000Z",
      createId
    });

    await expect(service.preflight()).resolves.toMatchObject({ status: "ready", reviewers: 2 });
    const report = await service.tick({
      expectedReviewPolicyDigest: fixture.policyDocument.digest,
      expectedDiscoveryPolicyDigest: fixture.policy.discoveryPolicyDigest,
      expectedCostPolicyDigest: fixture.run.value.costPolicyDigest
    });

    expect(report).toMatchObject({
      status: "completed",
      inspected: 1,
      completed: 1,
      humanReviewRequired: 1,
      approved: 0,
      changesRequested: 0,
      failed: 0,
      quarantined: 0
    });
    expect(executions).toBe(2);
    expect(new Set(prompts).size).toBe(2);
    expect(prompts.every((prompt) => !prompt.includes(fixture.candidate.untrustedTitle))).toBe(
      true
    );
    expect(prompts.every((prompt) => !prompt.includes(fixture.candidate.untrustedBody))).toBe(true);
    expect(unchangedAssertions).toBe(1);
    expect(workspaceClosures).toBe(1);
    expect(repository.snapshot?.bundle).toMatchObject({
      decision: "human-review-required",
      workspaceUnchanged: true,
      usageComplete: true,
      aggregateUsage: { costMicrousd: 200, workers: 1 }
    });
    await expect(
      service.tick({
        expectedReviewPolicyDigest: fixture.policyDocument.digest,
        expectedDiscoveryPolicyDigest: fixture.policy.discoveryPolicyDigest,
        expectedCostPolicyDigest: fixture.run.value.costPolicyDigest
      })
    ).resolves.toMatchObject({ status: "idle", inspected: 0 });
  });
});

class MemoryReviewRepository implements FactoryExternalPullRequestReviewRepository {
  public snapshot: FactoryExternalPullRequestReviewJournalSnapshot | null = null;
  #candidateAvailable = true;

  public constructor(
    private readonly fixture: ReturnType<typeof testExternalPullRequestReviewFixture>
  ) {}

  public listAdmitted() {
    if (!this.#candidateAvailable) return Promise.resolve([]);
    return Promise.resolve([
      {
        candidate: this.fixture.candidate,
        candidateDigest: this.fixture.candidateDocument.digest,
        discoveryRunId: this.fixture.discovery.run.value.runId,
        discoveryRunDigest: this.fixture.discovery.run.digest,
        discoverySnapshotDigest: this.fixture.snapshot.digest,
        discoveryPolicyDigest: this.fixture.discovery.policyDocument.digest
      }
    ]);
  }

  public listActive() {
    return Promise.resolve(
      this.snapshot !== null &&
        !["completed", "failed", "quarantined"].includes(this.snapshot.state)
        ? [this.snapshot]
        : []
    );
  }

  public register(
    run: CanonicalFactoryDocument<FactoryExternalPullRequestReviewRun>,
    event: CanonicalFactoryDocument<FactoryExternalPullRequestReviewEvent>
  ) {
    this.#candidateAvailable = false;
    assertExternalPullRequestReviewRun(run, this.fixture.documents);
    assertExternalPullRequestReviewRegistration(run, event);
    this.snapshot = snapshot(run, [event], null);
    return Promise.resolve(this.snapshot);
  }

  public findByCandidate() {
    return Promise.resolve(this.snapshot);
  }

  public append(event: CanonicalFactoryDocument<FactoryExternalPullRequestReviewEvent>) {
    if (this.snapshot === null) return Promise.resolve(null);
    const run = this.fixture.documents.externalPullRequestReviewRun(this.snapshot.run);
    const history = [
      ...this.snapshot.history.map((value) =>
        this.fixture.documents.externalPullRequestReviewEvent(value)
      )
    ];
    assertExternalPullRequestReviewEvent(run, event, history);
    this.snapshot = snapshot(run, [...history, event], this.snapshot.bundle);
    return Promise.resolve(this.snapshot);
  }

  public recordBundle(
    event: CanonicalFactoryDocument<FactoryExternalPullRequestReviewEvent>,
    bundle: CanonicalFactoryDocument<FactoryExternalPullRequestReviewBundle>
  ) {
    if (this.snapshot === null) return Promise.resolve(null);
    const run = this.fixture.documents.externalPullRequestReviewRun(this.snapshot.run);
    const history = [
      ...this.snapshot.history.map((value) =>
        this.fixture.documents.externalPullRequestReviewEvent(value)
      )
    ];
    assertExternalPullRequestReviewEvent(run, event, history);
    assertExternalPullRequestReviewBundle(run, bundle, event, this.fixture.documents);
    this.snapshot = snapshot(run, [...history, event], bundle.value);
    return Promise.resolve(this.snapshot);
  }

  public close(): void {
    return;
  }
}

function snapshot(
  run: CanonicalFactoryDocument<FactoryExternalPullRequestReviewRun>,
  history: readonly CanonicalFactoryDocument<FactoryExternalPullRequestReviewEvent>[],
  bundle: FactoryExternalPullRequestReviewBundle | null
): FactoryExternalPullRequestReviewJournalSnapshot {
  const last = history.at(-1);
  if (last === undefined) throw new Error("Test review journal is empty.");
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

function agentCapability(provider: string) {
  return {
    provider: provider as "codex" | "claude",
    roles: ["reviewer"] as const,
    preparationPhases: [],
    maintenanceDiscovery: false,
    maximumToolFilesystemAccess: "read-only" as const,
    toolNetwork: "off" as const,
    acceptsCommandAllowlist: false,
    acceptsSecrets: false as const
  };
}

function usage() {
  return {
    wallClockSeconds: 10,
    agentTurns: 1,
    toolCalls: 0,
    inputTokens: 1_000,
    outputTokens: 200,
    costMicrousd: 100,
    processes: 1,
    outputBytes: 1_000,
    workers: 1,
    repairAttempts: 0,
    changedFiles: 0,
    changedLines: 0
  };
}

function idFactory(): () => string {
  let next = 10;
  return () => `93000000-0000-4000-8000-${String(next++).padStart(12, "0")}`;
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agentlab-external-pr-review-service-"));
  roots.push(root);
  return root;
}
