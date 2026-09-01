import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FactoryMaintenanceDiscoveryRunRecorder } from "../../packages/runtime/src/application/factory-maintenance-discovery-run-recorder.js";
import { FileFactoryArtifactStore } from "../../packages/runtime/src/infrastructure/filesystem/file-factory-artifact-store.js";
import {
  TEST_MAINTENANCE_DISCOVERY_EXECUTION_ID,
  testFactoryMaintenanceDiscoveryFixture,
  testFactoryMaintenanceDiscoveryOutput
} from "../helpers/factory-maintenance-discovery.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { force: true, recursive: true }))
  );
});

describe("FactoryMaintenanceDiscoveryRunRecorder", () => {
  it("captures canonical scout output and complete usage before admission", async () => {
    const fixture = testFactoryMaintenanceDiscoveryFixture();
    const recorder = new FactoryMaintenanceDiscoveryRunRecorder(
      await artifacts(),
      fixture.documents
    );
    const request = runRequest(fixture);

    const captured = await recorder.capture({
      request,
      policy: fixture.policy,
      output: successfulOutput(request.value.executionId)
    });

    expect(captured.output?.value).toEqual(testFactoryMaintenanceDiscoveryOutput());
    expect(captured.record.value).toMatchObject({
      status: "succeeded",
      errorCode: null,
      usageComplete: true,
      providerSessionId: "maintenance-session-1"
    });
    expect(captured.record.value.outputDocumentArtifact?.digest).toBe(captured.output?.digest);
    expect(captured.recordArtifact.digest).toBe(captured.record.digest);
  });

  it("fails closed on malformed output, incomplete usage, or isolation drift", async () => {
    const fixture = testFactoryMaintenanceDiscoveryFixture();
    const recorder = new FactoryMaintenanceDiscoveryRunRecorder(
      await artifacts(),
      fixture.documents
    );
    const request = runRequest(fixture);
    const valid = successfulOutput(request.value.executionId);

    await expect(
      recorder.capture({
        request,
        policy: fixture.policy,
        output: { ...valid, finalOutput: "not-json" }
      })
    ).resolves.toMatchObject({
      output: null,
      record: { value: { status: "failed", errorCode: "provider-output-invalid" } }
    });
    await expect(
      recorder.capture({
        request,
        policy: fixture.policy,
        output: { ...valid, usageComplete: false }
      })
    ).resolves.toMatchObject({
      output: null,
      record: { value: { status: "failed", errorCode: "usage-incomplete" } }
    });
    await expect(
      recorder.capture({
        request,
        policy: fixture.policy,
        output: {
          ...valid,
          isolation: { ...valid.isolation, isolationId: fixture.run.value.runId }
        }
      })
    ).rejects.toThrow(/isolation identity changed/u);
  });
});

async function artifacts(): Promise<FileFactoryArtifactStore> {
  const root = await mkdtemp(join(tmpdir(), "agentlab-maintenance-recorder-"));
  temporaryRoots.push(root);
  return new FileFactoryArtifactStore(root);
}

function runRequest(fixture: ReturnType<typeof testFactoryMaintenanceDiscoveryFixture>) {
  return fixture.documents.maintenanceDiscoveryRunRequest({
    schemaVersion: "agentlab.maintenance-discovery-run-request.v1",
    executionId: TEST_MAINTENANCE_DISCOVERY_EXECUTION_ID,
    runId: fixture.run.value.runId,
    taskId: fixture.run.value.runId,
    runDigest: fixture.run.digest,
    attempt: 1,
    provider: fixture.policy.profile.provider,
    model: fixture.policy.profile.model,
    reasoning: fixture.policy.profile.reasoning,
    repository: fixture.run.value.repository,
    skillId: fixture.skill.id,
    skillPackageDigest: fixture.skill.packageDigest,
    promptArtifact: {
      digest: fixture.skill.packageDigest,
      mediaType: "text/plain; charset=utf-8",
      sizeBytes: 100
    },
    outputSchemaDigest: fixture.skill.outputSchemaDigest,
    capabilities: fixture.skill.requestedCapabilities,
    budget: fixture.skill.budgetCeiling
  });
}

function successfulOutput(executionId: string) {
  return {
    status: "succeeded" as const,
    exitCode: 0,
    stdout: "provider-jsonl",
    stderr: "",
    finalOutput: JSON.stringify(testFactoryMaintenanceDiscoveryOutput()),
    providerSessionId: "maintenance-session-1",
    providerVersion: "1.2.3",
    harnessVersion: "test-read-only-v1",
    startedAt: "2026-08-31T12:06:00.000Z",
    finishedAt: "2026-08-31T12:07:00.000Z",
    usage: {
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
    },
    usageComplete: true,
    errorCode: null,
    isolation: {
      isolationId: executionId,
      mechanism: { id: "linux/systemd-user-scope", version: "test-systemd-1" },
      scopeName: `agentlab-factory-${executionId.replaceAll("-", "")}.scope`,
      limits: {
        maxProcesses: 16,
        maxMemoryBytes: 2 * 1_024 * 1_024 * 1_024,
        cpuQuotaPercent: 200
      }
    }
  };
}
