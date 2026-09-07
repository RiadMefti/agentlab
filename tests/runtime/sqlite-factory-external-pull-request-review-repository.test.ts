import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { SqliteFactoryExternalPullRequestDiscoveryRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-external-pull-request-discovery-repository.js";
import { SqliteFactoryExternalPullRequestReviewRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-external-pull-request-review-repository.js";
import {
  registeredExternalPullRequestEvent,
  testExternalPullRequestSnapshot
} from "../helpers/factory-external-pull-request-discovery.js";
import {
  registeredExternalPullRequestReviewEvent,
  reviewEventBase,
  testExternalPullRequestReviewFixture
} from "../helpers/factory-external-pull-request-review.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("SqliteFactoryExternalPullRequestReviewRepository", () => {
  it("admits only the immutable discovery candidate and journals terminal review state", async () => {
    const fixture = testExternalPullRequestReviewFixture();
    const databasePath = temporaryDatabase();
    await recordDiscovery(databasePath, fixture);
    const repository = new SqliteFactoryExternalPullRequestReviewRepository(databasePath, {
      documents: fixture.documents
    });
    try {
      await expect(
        repository.listAdmitted({
          repositoryId: fixture.policy.repositoryId,
          discoveryPolicyDigest: fixture.policy.discoveryPolicyDigest,
          reviewPolicyDigest: fixture.policyDocument.digest,
          limit: 5
        })
      ).resolves.toEqual([
        expect.objectContaining({
          candidateDigest: fixture.candidateDocument.digest,
          candidate: fixture.candidate
        })
      ]);
      const registeredEvent = registeredExternalPullRequestReviewEvent(fixture);
      await expect(repository.register(fixture.run, registeredEvent)).resolves.toMatchObject({
        state: "ready",
        sequence: 1
      });
      const workspaceStarted = fixture.documents.externalPullRequestReviewEvent({
        ...reviewEventBase(
          fixture.run,
          2,
          registeredEvent.digest,
          "92000000-0000-4000-8000-000000000004"
        ),
        kind: "workspace-started",
        from: "ready",
        to: "workspace-active",
        reasonCode: "local-object-materialization-started"
      });
      await expect(repository.append(workspaceStarted)).resolves.toMatchObject({
        state: "workspace-active"
      });
      const patchDigest = `sha256:${"7".repeat(64)}` as const;
      const workspacePrepared = fixture.documents.externalPullRequestReviewEvent({
        ...reviewEventBase(
          fixture.run,
          3,
          workspaceStarted.digest,
          "92000000-0000-4000-8000-000000000005"
        ),
        kind: "workspace-prepared",
        from: "workspace-active",
        to: "reviewing",
        patchDigest,
        patchArtifact: {
          digest: patchDigest,
          sizeBytes: 128,
          mediaType: "application/vnd.git.patch"
        },
        reasonCode: "authenticated-paths-and-local-patch-match"
      });
      await expect(repository.append(workspacePrepared)).resolves.toMatchObject({
        state: "reviewing"
      });
      const failed = fixture.documents.externalPullRequestReviewEvent({
        ...reviewEventBase(
          fixture.run,
          4,
          workspacePrepared.digest,
          "92000000-0000-4000-8000-000000000006"
        ),
        kind: "failed",
        from: "reviewing",
        to: "failed",
        reviewerRecordDigest: null,
        reasonCode: "local-object-unavailable"
      });
      await expect(repository.append(failed)).resolves.toMatchObject({
        state: "failed",
        sequence: 4
      });
      await expect(
        repository.listAdmitted({
          repositoryId: fixture.policy.repositoryId,
          discoveryPolicyDigest: fixture.policy.discoveryPolicyDigest,
          reviewPolicyDigest: fixture.policyDocument.digest,
          limit: 5
        })
      ).resolves.toEqual([]);
    } finally {
      repository.close();
    }

    const database = new DatabaseSync(databasePath);
    try {
      expect(() =>
        database.prepare("UPDATE factory_external_pr_review_runs SET run_id = run_id").run()
      ).toThrow(/append-only|immutable/u);
      expect(() => database.prepare("DELETE FROM factory_external_pr_review_events").run()).toThrow(
        /append-only|immutable/u
      );
    } finally {
      database.close();
    }
  });

  it("rejects a review run that is not rooted in the completed discovery ledger", () => {
    const fixture = testExternalPullRequestReviewFixture();
    const repository = new SqliteFactoryExternalPullRequestReviewRepository(temporaryDatabase(), {
      documents: fixture.documents
    });
    try {
      expect(() =>
        repository.register(fixture.run, registeredExternalPullRequestReviewEvent(fixture))
      ).toThrow(/completed discovery candidate/u);
    } finally {
      repository.close();
    }
  });
});

async function recordDiscovery(
  databasePath: string,
  fixture: ReturnType<typeof testExternalPullRequestReviewFixture>
): Promise<void> {
  const repository = new SqliteFactoryExternalPullRequestDiscoveryRepository(databasePath, {
    documents: fixture.documents
  });
  try {
    const registered = registeredExternalPullRequestEvent(fixture.discovery);
    await repository.register(fixture.discovery.run, registered);
    const started = fixture.documents.externalPullRequestDiscoveryEvent({
      schemaVersion: "agentlab.external-pull-request-discovery-event.v1",
      eventId: "91000000-0000-4000-8000-000000000004",
      runId: fixture.discovery.run.value.runId,
      runDigest: fixture.discovery.run.digest,
      sequence: 2,
      previousEventDigest: registered.digest,
      actor: registered.value.actor,
      kind: "inventory-started",
      from: "ready",
      to: "fetching",
      occurredAt: "2026-09-01T12:06:00.000Z",
      reasonCode: "bounded-read-started",
      correlationId: fixture.discovery.run.value.correlationId
    });
    await repository.append(started);
    const snapshot = testExternalPullRequestSnapshot(fixture.discovery);
    const recorded = fixture.documents.externalPullRequestDiscoveryEvent({
      schemaVersion: "agentlab.external-pull-request-discovery-event.v1",
      eventId: "91000000-0000-4000-8000-000000000005",
      runId: fixture.discovery.run.value.runId,
      runDigest: fixture.discovery.run.digest,
      sequence: 3,
      previousEventDigest: started.digest,
      actor: registered.value.actor,
      kind: "snapshot-recorded",
      from: "fetching",
      to: "recorded",
      occurredAt: snapshot.value.observedAt,
      snapshotDigest: snapshot.digest,
      snapshotArtifact: {
        digest: snapshot.digest,
        sizeBytes: new TextEncoder().encode(snapshot.json).byteLength,
        mediaType:
          "application/vnd.agentlab.external-pull-request-discovery-snapshot+json;version=1"
      },
      reasonCode: "immutable-inventory-recorded",
      correlationId: fixture.discovery.run.value.correlationId
    });
    await repository.recordSnapshot(recorded, snapshot);
    const completed = fixture.documents.externalPullRequestDiscoveryEvent({
      schemaVersion: "agentlab.external-pull-request-discovery-event.v1",
      eventId: "91000000-0000-4000-8000-000000000006",
      runId: fixture.discovery.run.value.runId,
      runDigest: fixture.discovery.run.digest,
      sequence: 4,
      previousEventDigest: recorded.digest,
      actor: registered.value.actor,
      kind: "completed",
      from: "recorded",
      to: "completed",
      occurredAt: "2026-09-01T12:07:00.000Z",
      reasonCode: "bounded-read-completed",
      ...snapshot.value.counts,
      hasMore: snapshot.value.hasMore,
      correlationId: fixture.discovery.run.value.correlationId
    });
    await repository.append(completed);
  } finally {
    repository.close();
  }
}

function temporaryDatabase(): string {
  const root = mkdtempSync(join(tmpdir(), "agentlab-external-pr-review-journal-"));
  temporaryRoots.push(root);
  return join(root, "agentlab.sqlite");
}
