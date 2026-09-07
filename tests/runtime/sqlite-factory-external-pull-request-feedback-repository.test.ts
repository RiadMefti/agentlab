import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { SqliteFactoryExternalPullRequestDiscoveryRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-external-pull-request-discovery-repository.js";
import { SqliteFactoryExternalPullRequestFeedbackRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-external-pull-request-feedback-repository.js";
import { latestSchemaVersion } from "../../packages/runtime/src/infrastructure/persistence/migrations.js";
import { SqliteFactoryExternalPullRequestReviewRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-external-pull-request-review-repository.js";
import {
  feedbackEventBase,
  registeredExternalPullRequestFeedbackEvent,
  testExternalPullRequestFeedbackFixture
} from "../helpers/factory-external-pull-request-feedback.js";
import {
  registeredExternalPullRequestEvent,
  testExternalPullRequestSnapshot
} from "../helpers/factory-external-pull-request-discovery.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("SqliteFactoryExternalPullRequestFeedbackRepository", () => {
  it("admits only a completed review bundle and journals one immutable remote publication", async () => {
    const fixture = testExternalPullRequestFeedbackFixture();
    const databasePath = temporaryDatabase();
    await seedCompletedReview(databasePath, fixture);
    const repository = new SqliteFactoryExternalPullRequestFeedbackRepository(databasePath, {
      documents: fixture.review.documents
    });
    try {
      await expect(
        repository.listCompletedReviews({
          repositoryId: fixture.policy.repositoryId,
          reviewPolicyDigest: fixture.policy.reviewPolicyDigest,
          limit: 5
        })
      ).resolves.toEqual([
        expect.objectContaining({
          reviewRunDigest: fixture.review.run.digest,
          bundleDigest: fixture.completedReview.bundle.digest
        })
      ]);
      const registered = registeredExternalPullRequestFeedbackEvent(fixture);
      await expect(repository.register(fixture.run, registered)).resolves.toMatchObject({
        state: "ready",
        sequence: 1
      });
      const verified = fixture.review.documents.externalPullRequestFeedbackEvent({
        ...feedbackEventBase(fixture.run, 2, registered.digest, id(3)),
        kind: "remote-verified",
        from: "ready",
        to: "remote-verified",
        reasonCode: "exact-open-head-verified"
      });
      await repository.append(verified);
      const started = fixture.review.documents.externalPullRequestFeedbackEvent({
        ...feedbackEventBase(fixture.run, 3, verified.digest, id(4)),
        kind: "publication-started",
        from: "remote-verified",
        to: "publication-active",
        reasonCode: "comment-publication-intent-recorded"
      });
      await repository.append(started);
      const record = fixture.review.documents.externalPullRequestFeedbackRecord({
        schemaVersion: "agentlab.external-pull-request-feedback-record.v1",
        publicationRunId: fixture.run.value.publicationRunId,
        runDigest: fixture.run.digest,
        bundleDigest: fixture.run.value.bundleDigest,
        repositoryId: fixture.run.value.repositoryId,
        pullRequestNumber: fixture.run.value.pullRequestNumber,
        headRevision: fixture.run.value.expectedHeadRevision,
        publisherId: fixture.policy.publisherId,
        publisherUserId: fixture.policy.publisherUserId,
        remoteReviewId: "98765",
        remoteState: "commented",
        remoteUrl: "https://github.com/owner/agentlab/pull/42#pullrequestreview-98765",
        bodyDigest: fixture.run.value.bodyArtifact.digest,
        remoteSubmittedAt: "2026-09-01T12:21:30.000Z",
        observedAt: "2026-09-01T12:22:00.000Z",
        source: "posted"
      });
      const recorded = fixture.review.documents.externalPullRequestFeedbackEvent({
        ...feedbackEventBase(fixture.run, 4, started.digest, id(5)),
        kind: "publication-recorded",
        from: "publication-active",
        to: "recorded",
        recordDigest: record.digest,
        recordArtifact: {
          digest: record.digest,
          sizeBytes: new TextEncoder().encode(record.json).byteLength,
          mediaType: "application/vnd.agentlab.external-pull-request-feedback-record+json;version=1"
        },
        reasonCode: "comment-publication-recorded"
      });
      await expect(repository.record(recorded, record)).resolves.toMatchObject({
        state: "recorded",
        record: { remoteReviewId: "98765" }
      });
      const completed = fixture.review.documents.externalPullRequestFeedbackEvent({
        ...feedbackEventBase(fixture.run, 5, recorded.digest, id(6)),
        kind: "completed",
        from: "recorded",
        to: "completed",
        remoteReviewId: "98765",
        reasonCode: "advisory-comment-published"
      });
      await expect(repository.append(completed)).resolves.toMatchObject({ state: "completed" });
      await expect(
        repository.listCompletedReviews({
          repositoryId: fixture.policy.repositoryId,
          reviewPolicyDigest: fixture.policy.reviewPolicyDigest,
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
          .prepare(
            "UPDATE factory_external_pr_feedback_runs SET publication_run_id = publication_run_id"
          )
          .run()
      ).toThrow(/immutable/u);
      expect(() =>
        database.prepare("DELETE FROM factory_external_pr_feedback_events").run()
      ).toThrow(/append-only/u);
    } finally {
      database.close();
    }
  });

  it("rejects feedback that has no completed source review", () => {
    const fixture = testExternalPullRequestFeedbackFixture();
    const repository = new SqliteFactoryExternalPullRequestFeedbackRepository(temporaryDatabase(), {
      documents: fixture.review.documents
    });
    try {
      expect(() =>
        repository.register(fixture.run, registeredExternalPullRequestFeedbackEvent(fixture))
      ).toThrow(/completed review bundle/u);
    } finally {
      repository.close();
    }
  });
});

async function seedCompletedReview(
  databasePath: string,
  fixture: ReturnType<typeof testExternalPullRequestFeedbackFixture>
): Promise<void> {
  await seedDiscovery(databasePath, fixture);
  const repository = new SqliteFactoryExternalPullRequestReviewRepository(databasePath, {
    documents: fixture.review.documents
  });
  try {
    const [registered, ...events] = fixture.completedReview.events;
    if (registered === undefined) throw new Error("Missing review registration.");
    await repository.register(fixture.review.run, registered);
    for (const event of events) {
      if (event.value.kind === "bundle-recorded") {
        await repository.recordBundle(event, fixture.completedReview.bundle);
      } else {
        await repository.append(event);
      }
    }
  } finally {
    repository.close();
  }
}

async function seedDiscovery(
  databasePath: string,
  fixture: ReturnType<typeof testExternalPullRequestFeedbackFixture>
): Promise<void> {
  const repository = new SqliteFactoryExternalPullRequestDiscoveryRepository(databasePath, {
    documents: fixture.review.documents
  });
  try {
    const registered = registeredExternalPullRequestEvent(fixture.review.discovery);
    await repository.register(fixture.review.discovery.run, registered);
    const started = fixture.review.documents.externalPullRequestDiscoveryEvent({
      schemaVersion: "agentlab.external-pull-request-discovery-event.v1",
      eventId: "91000000-0000-4000-8000-000000000004",
      runId: fixture.review.discovery.run.value.runId,
      runDigest: fixture.review.discovery.run.digest,
      sequence: 2,
      previousEventDigest: registered.digest,
      actor: registered.value.actor,
      kind: "inventory-started",
      from: "ready",
      to: "fetching",
      occurredAt: "2026-09-01T12:06:00.000Z",
      reasonCode: "bounded-read-started",
      correlationId: fixture.review.discovery.run.value.correlationId
    });
    await repository.append(started);
    const snapshot = testExternalPullRequestSnapshot(fixture.review.discovery);
    const recorded = fixture.review.documents.externalPullRequestDiscoveryEvent({
      schemaVersion: "agentlab.external-pull-request-discovery-event.v1",
      eventId: "91000000-0000-4000-8000-000000000005",
      runId: fixture.review.discovery.run.value.runId,
      runDigest: fixture.review.discovery.run.digest,
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
      correlationId: fixture.review.discovery.run.value.correlationId
    });
    await repository.recordSnapshot(recorded, snapshot);
    const completed = fixture.review.documents.externalPullRequestDiscoveryEvent({
      schemaVersion: "agentlab.external-pull-request-discovery-event.v1",
      eventId: "91000000-0000-4000-8000-000000000006",
      runId: fixture.review.discovery.run.value.runId,
      runDigest: fixture.review.discovery.run.digest,
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
      correlationId: fixture.review.discovery.run.value.correlationId
    });
    await repository.append(completed);
  } finally {
    repository.close();
  }
}

function temporaryDatabase(): string {
  const root = mkdtempSync(join(tmpdir(), "agentlab-external-pr-feedback-journal-"));
  roots.push(root);
  return join(root, "agentlab.sqlite");
}

function id(suffix: number): string {
  return `93000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
}
