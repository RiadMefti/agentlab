import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { latestSchemaVersion } from "../../packages/runtime/src/infrastructure/persistence/migrations.js";
import { SqliteFactoryExternalPullRequestDiscoveryRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-external-pull-request-discovery-repository.js";
import {
  registeredExternalPullRequestEvent,
  testExternalPullRequestDiscoveryFixture,
  testExternalPullRequestSnapshot
} from "../helpers/factory-external-pull-request-discovery.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("SqliteFactoryExternalPullRequestDiscoveryRepository", () => {
  it("records a complete immutable slot, snapshot, candidate projection, and event chain", async () => {
    const fixture = testExternalPullRequestDiscoveryFixture();
    const databasePath = temporaryDatabase();
    const repository = new SqliteFactoryExternalPullRequestDiscoveryRepository(databasePath, {
      documents: fixture.documents
    });
    const registered = registeredExternalPullRequestEvent(fixture);
    try {
      const initial = await repository.register(fixture.run, registered);
      expect(initial).toMatchObject({ state: "ready", sequence: 1 });
      const started = fixture.documents.externalPullRequestDiscoveryEvent({
        ...eventBase(fixture, 2, registered.digest, "91000000-0000-4000-8000-000000000004"),
        kind: "inventory-started",
        from: "ready",
        to: "fetching",
        reasonCode: "bounded-read-started"
      });
      await expect(repository.append(started)).resolves.toMatchObject({
        state: "fetching",
        sequence: 2
      });

      const snapshot = testExternalPullRequestSnapshot(fixture);
      const snapshotEvent = fixture.documents.externalPullRequestDiscoveryEvent({
        ...eventBase(fixture, 3, started.digest, "91000000-0000-4000-8000-000000000005"),
        kind: "snapshot-recorded",
        from: "fetching",
        to: "recorded",
        occurredAt: snapshot.value.observedAt,
        reasonCode: "immutable-inventory-recorded",
        snapshotDigest: snapshot.digest,
        snapshotArtifact: {
          digest: snapshot.digest,
          sizeBytes: new TextEncoder().encode(snapshot.json).byteLength,
          mediaType:
            "application/vnd.agentlab.external-pull-request-discovery-snapshot+json;version=1"
        }
      });
      const recorded = await repository.recordSnapshot(snapshotEvent, snapshot);
      expect(recorded).toMatchObject({
        state: "recorded",
        sequence: 3,
        discoverySnapshot: snapshot.value
      });
      const completed = fixture.documents.externalPullRequestDiscoveryEvent({
        ...eventBase(fixture, 4, snapshotEvent.digest, "91000000-0000-4000-8000-000000000006"),
        kind: "completed",
        from: "recorded",
        to: "completed",
        occurredAt: "2026-09-01T12:07:00.000Z",
        reasonCode: "bounded-read-completed",
        ...snapshot.value.counts,
        hasMore: snapshot.value.hasMore
      });
      await expect(repository.append(completed)).resolves.toMatchObject({
        state: "completed",
        sequence: 4
      });
      await expect(
        repository.findBySlot({
          repositoryId: fixture.run.value.repositoryId,
          schedulePolicyDigest: fixture.run.value.schedulePolicyDigest,
          scheduledFor: fixture.run.value.scheduledFor
        })
      ).resolves.toMatchObject({ state: "completed", discoverySnapshot: snapshot.value });
      expect(() => repository.register(fixture.run, registered)).toThrow();
    } finally {
      repository.close();
    }

    const database = new DatabaseSync(databasePath);
    try {
      expect(() =>
        database.prepare("UPDATE factory_external_pr_discovery_runs SET run_id = run_id").run()
      ).toThrow(/immutable/u);
      expect(() =>
        database.prepare("DELETE FROM factory_external_pr_discovery_candidates").run()
      ).toThrow(/immutable/u);
      expect(
        (
          database
            .prepare("SELECT disposition FROM factory_external_pr_discovery_candidates")
            .get() as { disposition: string }
        ).disposition
      ).toBe("agent-review-candidate");
      expect(
        (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version
      ).toBe(latestSchemaVersion);
    } finally {
      database.close();
    }
  });

  it("rejects a snapshot that does not match the exact journal head", async () => {
    const fixture = testExternalPullRequestDiscoveryFixture();
    const repository = new SqliteFactoryExternalPullRequestDiscoveryRepository(
      temporaryDatabase(),
      { documents: fixture.documents }
    );
    try {
      const registered = registeredExternalPullRequestEvent(fixture);
      await repository.register(fixture.run, registered);
      const snapshot = testExternalPullRequestSnapshot(fixture);
      const event = fixture.documents.externalPullRequestDiscoveryEvent({
        ...eventBase(fixture, 2, registered.digest, "91000000-0000-4000-8000-000000000007"),
        kind: "snapshot-recorded",
        from: "fetching",
        to: "recorded",
        occurredAt: snapshot.value.observedAt,
        reasonCode: "immutable-inventory-recorded",
        snapshotDigest: snapshot.digest,
        snapshotArtifact: {
          digest: snapshot.digest,
          sizeBytes: new TextEncoder().encode(snapshot.json).byteLength,
          mediaType:
            "application/vnd.agentlab.external-pull-request-discovery-snapshot+json;version=1"
        }
      });
      expect(() => repository.recordSnapshot(event, snapshot)).toThrow(/lineage/u);
    } finally {
      repository.close();
    }
  });
});

function eventBase(
  fixture: ReturnType<typeof testExternalPullRequestDiscoveryFixture>,
  sequence: number,
  previousEventDigest: string | null,
  eventId: string
) {
  return {
    schemaVersion: "agentlab.external-pull-request-discovery-event.v1" as const,
    eventId,
    runId: fixture.run.value.runId,
    runDigest: fixture.run.digest,
    sequence,
    previousEventDigest,
    actor: {
      kind: "control-plane" as const,
      id: fixture.run.value.observerId,
      role: "maintenance-scout" as const,
      sessionId: fixture.run.value.runId
    },
    occurredAt: `2026-09-01T12:${String(sequence + 4).padStart(2, "0")}:00.000Z`,
    correlationId: fixture.run.value.correlationId
  };
}

function temporaryDatabase(): string {
  const root = mkdtempSync(join(tmpdir(), "agentlab-external-pr-discovery-journal-"));
  temporaryRoots.push(root);
  return join(root, "agentlab.sqlite");
}
