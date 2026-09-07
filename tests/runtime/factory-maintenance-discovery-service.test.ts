import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { FactoryMaintenanceDiscoveryIntake } from "../../packages/runtime/src/application/factory-maintenance-discovery-intake.js";
import { FactoryMaintenanceDiscoveryService } from "../../packages/runtime/src/application/factory-maintenance-discovery-service.js";
import { FactoryMaintenanceDiscoverySkill } from "../../packages/runtime/src/application/factory-maintenance-discovery-skill.js";
import type { FactoryPreparationSnapshot } from "../../packages/runtime/src/domain/factory-preparation-repository.js";
import { FileFactoryArtifactStore } from "../../packages/runtime/src/infrastructure/filesystem/file-factory-artifact-store.js";
import { SqliteFactoryMaintenanceDiscoveryRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-maintenance-discovery-repository.js";
import {
  TEST_MAINTENANCE_DISCOVERY_EXECUTION_ID,
  testFactoryMaintenanceDiscoveryFixture,
  testFactoryMaintenanceDiscoveryOutput
} from "../helpers/factory-maintenance-discovery.js";
import { testDigest } from "../helpers/factory.js";

const repositoryRoot = "/work/agentlab";
const conversationId = "84000000-0000-4000-8000-000000000001";
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("FactoryMaintenanceDiscoveryService", () => {
  it("discovers once, admits only evidenced in-scope work, and resumes idempotently", async () => {
    const fixture = testFactoryMaintenanceDiscoveryFixture();
    const root = await mkdtemp(join(tmpdir(), "agentlab-maintenance-service-"));
    temporaryRoots.push(root);
    const artifacts = new FileFactoryArtifactStore(join(root, "artifacts"));
    const discoveries = new SqliteFactoryMaintenanceDiscoveryRepository(
      join(root, "agentlab.sqlite"),
      { documents: fixture.documents }
    );
    const createId = sequentialIds();
    let currentTime = "2026-08-31T12:05:00.000Z";
    const register = vi.fn((input: { readonly request: unknown }) => {
      const request = fixture.documents.intakeRequest(input.request);
      return Promise.resolve({
        request: request.value,
        requestDigest: request.digest,
        authority: {
          maximumRiskTier: "R1",
          policyBundleDigest: fixture.run.value.factoryPolicyBundleDigest
        },
        authorityDigest: testDigest("8"),
        state: "registered"
      } as unknown as FactoryPreparationSnapshot);
    });
    const intake = new FactoryMaintenanceDiscoveryIntake({
      repositoryId: fixture.run.value.repository.id,
      conversationId,
      authorityLifetimeSeconds: 3_600,
      preparations: { findByDeduplicationKey: () => Promise.resolve(null) },
      deduplicator: { key: () => testDigest("9") },
      preparationSkills: { publish: () => Promise.resolve() },
      authorityIssuer: {
        issue: () => {
          throw new Error("not used for new intake");
        }
      },
      intake: { register },
      createId
    });
    const skill = new FactoryMaintenanceDiscoverySkill(
      fixture.documents,
      artifacts,
      fixture.policy,
      fixture.skillPackage
    );
    const output = testFactoryMaintenanceDiscoveryOutput();
    const protectedFinding = {
      ...output.findings[0],
      findingKey: "workflow/unreviewed-change",
      priority: 100,
      affectedPaths: [".github/workflows/ci.yml"],
      evidence: [
        {
          path: ".github/workflows/ci.yml",
          lineStart: 1,
          lineEnd: 5,
          observation: "A workflow change would cross the protected boundary."
        }
      ]
    };
    const execute = vi.fn((input: { readonly request: { readonly executionId: string } }) => {
      currentTime = "2026-08-31T12:07:00.000Z";
      return Promise.resolve({
        status: "succeeded" as const,
        exitCode: 0,
        stdout: "provider-jsonl",
        stderr: "",
        finalOutput: JSON.stringify({
          ...output,
          findings: [output.findings[0], protectedFinding]
        }),
        providerSessionId: "maintenance-session-1",
        providerVersion: "1.2.3",
        harnessVersion: "test-read-only-v1",
        startedAt: "2026-08-31T12:06:00.000Z",
        finishedAt: currentTime,
        usage: successfulUsage(),
        usageComplete: true,
        errorCode: null,
        isolation: {
          isolationId: input.request.executionId,
          mechanism: { id: "linux/systemd-user-scope", version: "test-systemd-1" },
          scopeName: `agentlab-factory-${input.request.executionId.replaceAll("-", "")}.scope`,
          limits: fixture.policy.profile.resourceLimits
        }
      });
    });
    const closeWorkspace = vi.fn(() => Promise.resolve());
    const service = new FactoryMaintenanceDiscoveryService({
      repositoryId: fixture.run.value.repository.id,
      repositoryRoot,
      conversationId,
      discoveryPolicy: fixture.policyDocument,
      schedulePolicy: fixture.scheduleDocument,
      factoryPolicyBundleDigest: fixture.run.value.factoryPolicyBundleDigest,
      preparationGrantDigest: fixture.run.value.preparationGrantDigest,
      roleIdentityPolicyDigest: fixture.run.value.roleIdentityPolicyDigest,
      controls: { state: () => Promise.resolve({ scheduler: true, prBroker: false }) },
      conversations: {
        findById: () =>
          Promise.resolve({
            id: conversationId,
            title: "Maintenance service test",
            workspacePath: repositoryRoot,
            provider: "codex",
            model: null,
            reasoning: null,
            captainSessionName: "agentlab-captain-test",
            createdAt: "2026-08-31T11:00:00.000Z",
            updatedAt: "2026-08-31T11:00:00.000Z",
            lifecycleState: "active",
            ownershipMode: "legacy-name",
            ownershipNonce: null
          })
      },
      revisions: { currentRevision: () => Promise.resolve("a".repeat(40)) },
      discoveries,
      artifacts,
      documents: fixture.documents,
      skill,
      intake,
      host: { inspect: () => Promise.resolve({ status: "ready", reasonCodes: [] }) },
      providers: {
        resolve: () => Promise.resolve({ executable: "/opt/codex", version: "1.2.3" })
      },
      agents: {
        capabilities: () => [
          {
            provider: "codex",
            roles: ["implementer", "repairer", "reviewer"],
            preparationPhases: ["qualify", "specify", "plan"],
            maintenanceDiscovery: true,
            maximumToolFilesystemAccess: "workspace-write",
            toolNetwork: "off",
            acceptsCommandAllowlist: false,
            acceptsSecrets: false
          }
        ],
        preflight: () => undefined,
        execute
      },
      workspaces: {
        create: ({ taskId, workspaceId, attempt, repositoryRoot: rootPath, baseRevision }) =>
          Promise.resolve({
            id: workspaceId ?? TEST_MAINTENANCE_DISCOVERY_EXECUTION_ID,
            taskId,
            attempt,
            repositoryRoot: rootPath,
            root: "/work/discovery",
            baseRevision,
            closeAndWait: closeWorkspace
          }),
        apply: () => Promise.reject(new Error("discovery cannot apply patches")),
        collect: () => Promise.reject(new Error("discovery cannot collect patches"))
      },
      recovery: { reconcile: () => Promise.resolve({ status: "inactive" }) },
      evidenceInventory: {
        trackedPaths: () =>
          Promise.resolve(new Set(["docs/factory-operations.md", ".github/workflows/ci.yml"]))
      },
      now: () => currentTime,
      createId
    });
    const pins = {
      expectedDiscoveryPolicyDigest: fixture.policyDocument.digest,
      expectedSchedulePolicyDigest: fixture.scheduleDocument.digest,
      expectedFactoryPolicyBundleDigest: fixture.run.value.factoryPolicyBundleDigest,
      expectedPreparationGrantDigest: fixture.run.value.preparationGrantDigest,
      expectedRoleIdentityPolicyDigest: fixture.run.value.roleIdentityPolicyDigest
    };

    try {
      await expect(service.tick(pins)).resolves.toMatchObject({
        status: "completed",
        findings: 2,
        admitted: 1,
        skipped: 1,
        reasonCodes: []
      });
      await expect(service.tick(pins)).resolves.toMatchObject({
        status: "already-completed",
        findings: 2,
        admitted: 1,
        skipped: 1
      });
      expect(execute).toHaveBeenCalledOnce();
      expect(register).toHaveBeenCalledOnce();
      expect(closeWorkspace).toHaveBeenCalledOnce();
      const snapshot = await discoveries.findBySlot(
        fixture.policy.id,
        fixture.run.value.scheduledFor
      );
      expect(snapshot?.events.map(({ kind }) => kind)).toEqual([
        "registered",
        "agent-started",
        "agent-finished",
        "finding-skipped",
        "finding-admitted",
        "completed"
      ]);
      expect(snapshot?.events.find(({ kind }) => kind === "finding-skipped")).toMatchObject({
        skipReason: "protected-path-denied"
      });
    } finally {
      discoveries.close();
    }
  });

  it("blocks before model execution when the scheduler switch is disabled", async () => {
    const fixture = testFactoryMaintenanceDiscoveryFixture();
    const root = await mkdtemp(join(tmpdir(), "agentlab-maintenance-service-"));
    temporaryRoots.push(root);
    const artifacts = new FileFactoryArtifactStore(join(root, "artifacts"));
    const discoveries = new SqliteFactoryMaintenanceDiscoveryRepository(
      join(root, "agentlab.sqlite"),
      { documents: fixture.documents }
    );
    const execute = vi.fn();
    const service = new FactoryMaintenanceDiscoveryService({
      repositoryId: fixture.run.value.repository.id,
      repositoryRoot,
      conversationId,
      discoveryPolicy: fixture.policyDocument,
      schedulePolicy: fixture.scheduleDocument,
      factoryPolicyBundleDigest: fixture.run.value.factoryPolicyBundleDigest,
      preparationGrantDigest: fixture.run.value.preparationGrantDigest,
      roleIdentityPolicyDigest: fixture.run.value.roleIdentityPolicyDigest,
      controls: { state: () => Promise.resolve({ scheduler: false, prBroker: false }) },
      conversations: { findById: () => Promise.resolve(null) },
      revisions: { currentRevision: () => Promise.resolve("a".repeat(40)) },
      discoveries,
      artifacts,
      documents: fixture.documents,
      skill: new FactoryMaintenanceDiscoverySkill(
        fixture.documents,
        artifacts,
        fixture.policy,
        fixture.skillPackage
      ),
      intake: {} as FactoryMaintenanceDiscoveryIntake,
      host: { inspect: () => Promise.resolve({ status: "ready", reasonCodes: [] }) },
      providers: { resolve: () => Promise.resolve(null) },
      agents: {
        capabilities: () => [],
        preflight: () => undefined,
        execute
      },
      workspaces: {} as never,
      recovery: {} as never,
      evidenceInventory: {} as never,
      now: () => "2026-08-31T12:05:00.000Z",
      createId: sequentialIds()
    });
    try {
      await expect(
        service.tick({
          expectedDiscoveryPolicyDigest: fixture.policyDocument.digest,
          expectedSchedulePolicyDigest: fixture.scheduleDocument.digest,
          expectedFactoryPolicyBundleDigest: fixture.run.value.factoryPolicyBundleDigest,
          expectedPreparationGrantDigest: fixture.run.value.preparationGrantDigest,
          expectedRoleIdentityPolicyDigest: fixture.run.value.roleIdentityPolicyDigest
        })
      ).resolves.toMatchObject({
        status: "blocked",
        runId: null,
        reasonCodes: expect.arrayContaining(["scheduler-disabled"])
      });
      expect(execute).not.toHaveBeenCalled();
    } finally {
      discoveries.close();
    }
  });
});

function sequentialIds(): () => string {
  let next = 1;
  return () => `85000000-0000-4000-8000-${String(next++).padStart(12, "0")}`;
}

function successfulUsage() {
  return {
    wallClockSeconds: 60,
    agentTurns: 2,
    toolCalls: 4,
    inputTokens: 1_000,
    outputTokens: 200,
    costMicrousd: 10_000,
    processes: 1,
    outputBytes: 1_000,
    workers: 1,
    repairAttempts: 0,
    changedFiles: 0,
    changedLines: 0
  };
}
