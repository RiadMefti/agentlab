import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  FactoryExternalPullRequestRepairExecutionEvent,
  FactoryExternalPullRequestRepairExecutionRun,
  Sha256Digest
} from "@agentlab/contracts";
import { afterEach, describe, expect, it } from "vitest";

import type { CanonicalFactoryDocument } from "../../packages/runtime/src/domain/factory-documents.js";
import { SqliteFactoryExternalPullRequestRepairAdmissionRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-external-pull-request-repair-admission-repository.js";
import { SqliteFactoryExternalPullRequestRepairExecutionRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-external-pull-request-repair-execution-repository.js";
import { latestSchemaVersion } from "../../packages/runtime/src/infrastructure/persistence/migrations.js";
import { testDigest } from "../helpers/factory.js";
import {
  externalPullRequestRepairExecutionRun,
  registeredExternalPullRequestRepairExecutionEvent,
  testExternalPullRequestRepairExecutionFixture
} from "../helpers/factory-external-pull-request-repair-execution.js";
import { seedCompletedExternalPullRequestFeedback } from "./sqlite-factory-external-pull-request-repair-admission-repository.test.js";

const roots: string[] = [];

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

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("SqliteFactoryExternalPullRequestRepairExecutionRepository", () => {
  it("consumes one admitted capability into an immutable execution journal and patch bundle", async () => {
    const fixture = testExternalPullRequestRepairExecutionFixture();
    const databasePath = temporaryDatabase();
    await seedCompletedExternalPullRequestFeedback(databasePath, fixture.admission);
    const admission = new SqliteFactoryExternalPullRequestRepairAdmissionRepository(databasePath, {
      documents: fixture.documents,
      now: () => "2026-09-01T12:25:00.000Z"
    });
    try {
      await admission.decide(
        fixture.admission.policyDocument,
        fixture.decision,
        fixture.authorization,
        fixture.admission.candidate
      );
    } finally {
      admission.close();
    }

    const repository = new SqliteFactoryExternalPullRequestRepairExecutionRepository(databasePath, {
      documents: fixture.documents,
      now: () => "2026-09-01T12:25:00.000Z"
    });
    const run = externalPullRequestRepairExecutionRun(fixture);
    const registered = registeredExternalPullRequestRepairExecutionEvent(fixture, run);
    try {
      await expect(
        repository.listAdmitted({
          repositoryId: fixture.executionPolicy.repositoryId,
          admissionPolicyDigest: fixture.admission.policyDocument.digest,
          repairExecutionPolicyDigest: fixture.executionPolicyDocument.digest,
          limit: 5
        })
      ).resolves.toHaveLength(1);
      await expect(
        repository.register(
          fixture.admission.policyDocument,
          fixture.executionPolicyDocument,
          run,
          registered,
          fixture.candidate
        )
      ).resolves.toMatchObject({ state: "ready", sequence: 1 });

      const started = event(fixture, run, 2, registered.digest, {
        kind: "workspace-started",
        from: "ready",
        to: "workspace-active",
        reasonCode: "exact-external-pr-head-workspace-started"
      });
      await repository.append(started);
      const prepared = event(fixture, run, 3, started.digest, {
        kind: "workspace-prepared",
        from: "workspace-active",
        to: "prepared",
        sourcePatchDigest: fixture.authorization.value.patchDigest,
        sourcePatchArtifact: artifact(
          fixture.authorization.value.patchDigest,
          "application/vnd.git.patch"
        ),
        reasonCode: "exact-reviewed-patch-and-head-materialized"
      });
      await repository.append(prepared);
      const executionId = "95000000-0000-4000-8000-000000000020";
      const requestDigest = testDigest("b");
      const repairerRecordDigest = testDigest("c");
      const repairerStarted = event(fixture, run, 4, prepared.digest, {
        kind: "repairer-started",
        from: "prepared",
        to: "repairer-active",
        repairerId: fixture.executionPolicy.repairerProfile.id,
        executionId,
        requestDigest,
        reasonCode: "credentialless-external-repairer-started"
      });
      await repository.append(repairerStarted);
      const bundle = fixture.documents.externalPullRequestRepairBundle({
        schemaVersion: "agentlab.external-pull-request-repair-bundle.v1",
        repairRunId: run.value.runId,
        runDigest: run.digest,
        repositoryId: run.value.repositoryId,
        pullRequestNumber: run.value.pullRequestNumber,
        authorizationDigest: run.value.authorizationDigest,
        repairExecutionPolicyDigest: run.value.repairExecutionPolicyDigest,
        expectedHeadRevision: run.value.expectedHeadRevision,
        originalPatchDigest: run.value.originalPatchDigest,
        repairerRequestDigest: requestDigest,
        repairerRecordDigest,
        executionId,
        patchArtifact: artifact(testDigest("d"), "application/vnd.git.patch", 72),
        changeSet: {
          baseRevision: run.value.expectedHeadRevision,
          headRevision: null,
          changedPaths: ["tracked.txt"],
          binaryPaths: [],
          changedFiles: 1,
          changedLines: 2
        },
        usage: usage(),
        usageComplete: true,
        repairAttempt: 1,
        publicationMode: "replacement-draft",
        remoteWrite: false,
        autoMerge: false,
        release: false,
        workspaceClosed: true,
        createdAt: "2026-09-01T12:29:00.000Z"
      });
      const recorded = event(fixture, run, 5, repairerStarted.digest, {
        kind: "bundle-recorded",
        from: "repairer-active",
        to: "recorded",
        repairerId: fixture.executionPolicy.repairerProfile.id,
        executionId,
        requestDigest,
        repairerRecordDigest,
        bundleDigest: bundle.digest,
        bundleArtifact: artifact(
          bundle.digest,
          "application/vnd.agentlab.external-pull-request-repair-bundle+json;version=1",
          new TextEncoder().encode(bundle.json).byteLength
        ),
        reasonCode: "credentialless-external-repair-bundle-recorded"
      });
      await expect(repository.recordBundle(recorded, bundle)).resolves.toMatchObject({
        state: "recorded",
        bundle: { patchArtifact: { digest: testDigest("d") }, workspaceClosed: true }
      });
      const completed = event(fixture, run, 6, recorded.digest, {
        kind: "completed",
        from: "recorded",
        to: "completed",
        bundleDigest: bundle.digest,
        reasonCode: "credentialless-external-repair-completed"
      });
      await expect(repository.append(completed)).resolves.toMatchObject({
        state: "completed",
        sequence: 6
      });
      await expect(
        repository.listAdmitted({
          repositoryId: fixture.executionPolicy.repositoryId,
          admissionPolicyDigest: fixture.admission.policyDocument.digest,
          repairExecutionPolicyDigest: fixture.executionPolicyDocument.digest,
          limit: 5
        })
      ).resolves.toEqual([]);
    } finally {
      repository.close();
    }

    const database = new DatabaseSync(databasePath);
    try {
      expect(
        (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version
      ).toBe(latestSchemaVersion);
      expect(() =>
        database
          .prepare("UPDATE factory_external_pr_repair_execution_runs SET run_id = run_id")
          .run()
      ).toThrow(/immutable/u);
      expect(() =>
        database.prepare("DELETE FROM factory_external_pr_repair_execution_events").run()
      ).toThrow(/append-only/u);
      expect(() =>
        database.prepare("DELETE FROM factory_external_pr_repair_execution_bundles").run()
      ).toThrow(/immutable/u);
    } finally {
      database.close();
    }
  });
});

function event(
  fixture: ReturnType<typeof testExternalPullRequestRepairExecutionFixture>,
  run: CanonicalFactoryDocument<FactoryExternalPullRequestRepairExecutionRun>,
  sequence: number,
  previousEventDigest: Sha256Digest,
  payload: EventPayload
) {
  return fixture.documents.externalPullRequestRepairExecutionEvent({
    schemaVersion: "agentlab.external-pull-request-repair-execution-event.v1",
    eventId: `95000000-0000-4000-8000-${String(sequence + 20).padStart(12, "0")}`,
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
    occurredAt: `2026-09-01T12:${String(sequence + 24).padStart(2, "0")}:00.000Z`,
    correlationId: run.value.correlationId
  });
}

function artifact(digest: Sha256Digest, mediaType: string, sizeBytes = 42) {
  return { digest, mediaType, sizeBytes };
}

function usage() {
  return {
    wallClockSeconds: 10,
    agentTurns: 1,
    toolCalls: 1,
    inputTokens: 1_000,
    outputTokens: 200,
    costMicrousd: 100,
    processes: 1,
    outputBytes: 1_000,
    workers: 1,
    repairAttempts: 1,
    changedFiles: 1,
    changedLines: 2
  };
}

function temporaryDatabase(): string {
  const root = mkdtempSync(join(tmpdir(), "agentlab-external-pr-repair-execution-sqlite-"));
  roots.push(root);
  return join(root, "agentlab.sqlite");
}
