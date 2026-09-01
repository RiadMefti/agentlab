import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { latestSchemaVersion } from "../../packages/runtime/src/infrastructure/persistence/migrations.js";
import { SqliteFactoryMaintenanceDiscoveryRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-maintenance-discovery-repository.js";
import {
  TEST_MAINTENANCE_DISCOVERY_EXECUTION_ID,
  testFactoryMaintenanceDiscoveryFixture
} from "../helpers/factory-maintenance-discovery.js";
import { testDigest } from "../helpers/factory.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("SqliteFactoryMaintenanceDiscoveryRepository", () => {
  it("persists one immutable slot and enforces append-only event lineage", async () => {
    const fixture = testFactoryMaintenanceDiscoveryFixture();
    const databasePath = temporaryDatabase();
    const repository = new SqliteFactoryMaintenanceDiscoveryRepository(databasePath, {
      documents: fixture.documents
    });
    const registered = registration(fixture);
    try {
      const initial = await repository.register(fixture.run, registered);
      expect(initial).toMatchObject({ state: "ready", sequence: 1 });
      await expect(
        repository.findBySlot(fixture.policy.id, fixture.run.value.scheduledFor)
      ).resolves.toEqual(initial);
      await expect(repository.findOpen()).resolves.toEqual(initial);

      const started = fixture.documents.maintenanceDiscoveryEvent({
        ...eventBase(fixture, 2, registered.digest, "81000000-0000-4000-8000-000000000011"),
        kind: "agent-started",
        from: "ready",
        to: "agent-active",
        executionId: TEST_MAINTENANCE_DISCOVERY_EXECUTION_ID,
        runRequestDigest: testDigest("6"),
        reasonCode: "maintenance-discovery-agent-started"
      });
      const active = await repository.append(started);
      expect(active).toMatchObject({ state: "agent-active", sequence: 2 });

      const wrongChain = fixture.documents.maintenanceDiscoveryEvent({
        ...eventBase(fixture, 3, registered.digest, "81000000-0000-4000-8000-000000000012"),
        kind: "agent-failed",
        from: "agent-active",
        to: "failed",
        executionId: TEST_MAINTENANCE_DISCOVERY_EXECUTION_ID,
        runRecordDigest: testDigest("7"),
        errorCode: "provider-output-invalid",
        usage: emptyUsage(),
        reasonCode: "maintenance-discovery-agent-failed"
      });
      expect(() => repository.append(wrongChain)).toThrow(/lineage/u);

      const failed = fixture.documents.maintenanceDiscoveryEvent({
        ...eventBase(fixture, 3, started.digest, "81000000-0000-4000-8000-000000000013"),
        kind: "agent-failed",
        from: "agent-active",
        to: "failed",
        executionId: TEST_MAINTENANCE_DISCOVERY_EXECUTION_ID,
        runRecordDigest: testDigest("7"),
        errorCode: "provider-output-invalid",
        usage: emptyUsage(),
        reasonCode: "maintenance-discovery-agent-failed"
      });
      await expect(repository.append(failed)).resolves.toMatchObject({
        state: "failed",
        sequence: 3
      });
      await expect(repository.findOpen()).resolves.toBeNull();
      expect(() => repository.register(fixture.run, registered)).toThrow();
    } finally {
      repository.close();
    }

    const database = new DatabaseSync(databasePath);
    try {
      expect(() =>
        database.prepare("UPDATE factory_maintenance_discovery_runs SET run_id = run_id").run()
      ).toThrow(/immutable/u);
      expect(() =>
        database.prepare("DELETE FROM factory_maintenance_discovery_events").run()
      ).toThrow(/append-only/u);
      expect(
        (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version
      ).toBe(latestSchemaVersion);
    } finally {
      database.close();
    }
  });
});

function registration(fixture: ReturnType<typeof testFactoryMaintenanceDiscoveryFixture>) {
  return fixture.documents.maintenanceDiscoveryEvent({
    ...eventBase(fixture, 1, null, "81000000-0000-4000-8000-000000000010"),
    kind: "registered",
    from: null,
    to: "ready",
    occurredAt: fixture.run.value.createdAt,
    reasonCode: "maintenance-discovery-registered"
  });
}

function eventBase(
  fixture: ReturnType<typeof testFactoryMaintenanceDiscoveryFixture>,
  sequence: number,
  previousEventDigest: string | null,
  eventId: string
) {
  return {
    schemaVersion: "agentlab.maintenance-discovery-event.v1" as const,
    eventId,
    runId: fixture.run.value.runId,
    runDigest: fixture.run.digest,
    sequence,
    previousEventDigest,
    actor: {
      kind: "control-plane" as const,
      role: "policy-engine" as const,
      id: "agentlab-maintenance-discovery",
      sessionId: null
    },
    occurredAt: `2026-08-31T12:${String(sequence + 4).padStart(2, "0")}:00.000Z`,
    correlationId: fixture.run.value.correlationId
  };
}

function emptyUsage() {
  return {
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
}

function temporaryDatabase(): string {
  const root = mkdtempSync(join(tmpdir(), "agentlab-maintenance-discovery-journal-"));
  temporaryRoots.push(root);
  return join(root, "agentlab.sqlite");
}
