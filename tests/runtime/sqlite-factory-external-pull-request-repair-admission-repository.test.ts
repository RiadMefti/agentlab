import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { FactoryExternalPullRequestRepairAdmissionService } from "../../packages/runtime/src/application/factory-external-pull-request-repair-admission-service.js";
import { SqliteFactoryExternalPullRequestDiscoveryRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-external-pull-request-discovery-repository.js";
import { SqliteFactoryExternalPullRequestFeedbackRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-external-pull-request-feedback-repository.js";
import { SqliteFactoryExternalPullRequestRepairAdmissionRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-external-pull-request-repair-admission-repository.js";
import { SqliteFactoryExternalPullRequestReviewRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-external-pull-request-review-repository.js";
import { latestSchemaVersion } from "../../packages/runtime/src/infrastructure/persistence/migrations.js";
import {
  registeredExternalPullRequestEvent,
  testExternalPullRequestSnapshot
} from "../helpers/factory-external-pull-request-discovery.js";
import { testExternalPullRequestRepairAdmissionFixture } from "../helpers/factory-external-pull-request-repair-admission.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("SqliteFactoryExternalPullRequestRepairAdmissionRepository", () => {
  it("roots one immutable authorization in completed review and feedback journals", async () => {
    const fixture = testExternalPullRequestRepairAdmissionFixture();
    const databasePath = temporaryDatabase();
    await seedCompletedExternalPullRequestFeedback(databasePath, fixture);
    const repository = new SqliteFactoryExternalPullRequestRepairAdmissionRepository(databasePath, {
      documents: fixture.feedback.review.documents,
      now: () => "2026-09-01T12:24:00.000Z"
    });
    try {
      await expect(
        repository.listCandidates({
          repositoryId: fixture.policy.repositoryId,
          reviewPolicyDigest: fixture.policy.reviewPolicyDigest,
          feedbackPolicyDigest: fixture.policy.feedbackPolicyDigest,
          admissionPolicyDigest: fixture.policyDocument.digest,
          limit: 5
        })
      ).resolves.toEqual([
        expect.objectContaining({
          feedbackRun: expect.objectContaining({ digest: fixture.feedback.run.digest }),
          feedbackRecord: expect.objectContaining({
            digest: fixture.completedFeedback.record.digest
          })
        })
      ]);
      const service = new FactoryExternalPullRequestRepairAdmissionService({
        admissionPolicy: fixture.policyDocument,
        repository,
        controls: { state: () => Promise.resolve({ scheduler: true, prBroker: false }) },
        documents: fixture.feedback.review.documents,
        now: () => "2026-09-01T12:24:00.000Z",
        createId: idFactory()
      });
      const report = await service.tick({
        expectedAdmissionPolicyDigest: fixture.policyDocument.digest,
        expectedReviewPolicyDigest: fixture.policy.reviewPolicyDigest,
        expectedFeedbackPolicyDigest: fixture.policy.feedbackPolicyDigest,
        expectedRepairExecutionPolicyDigest: fixture.policy.repairExecutionPolicyDigest,
        expectedCostPolicyDigest: fixture.policy.costPolicyDigest,
        expectedRoleIdentityPolicyDigest: fixture.policy.roleIdentityPolicyDigest,
        expectedGateProfileDigest: fixture.policy.gateProfileDigest
      });
      expect(report).toMatchObject({ status: "completed", authorized: 1, denied: 0 });
      const digest = report.decisions[0]?.authorizationDigest;
      expect(digest).toBeTruthy();
      await expect(
        repository.findByBundle(
          fixture.feedback.run.value.bundleDigest,
          fixture.policyDocument.digest
        )
      ).resolves.toMatchObject({
        decision: { status: "authorized" },
        authorization: {
          expectedHeadRevision: fixture.feedback.run.value.expectedHeadRevision,
          remoteWrite: false,
          autoMerge: false,
          release: false
        },
        authorizationDigest: digest
      });
      await expect(
        repository.listCandidates({
          repositoryId: fixture.policy.repositoryId,
          reviewPolicyDigest: fixture.policy.reviewPolicyDigest,
          feedbackPolicyDigest: fixture.policy.feedbackPolicyDigest,
          admissionPolicyDigest: fixture.policyDocument.digest,
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
          .prepare("UPDATE factory_external_pr_repair_decisions SET decision_id = decision_id")
          .run()
      ).toThrow(/immutable/u);
      expect(() =>
        database.prepare("DELETE FROM factory_external_pr_repair_authorizations").run()
      ).toThrow(/immutable/u);
    } finally {
      database.close();
    }
  });

  it("does not project feedback until its durable journal is completed", async () => {
    const fixture = testExternalPullRequestRepairAdmissionFixture();
    const databasePath = temporaryDatabase();
    await seedCompletedReview(databasePath, fixture);
    const feedback = new SqliteFactoryExternalPullRequestFeedbackRepository(databasePath, {
      documents: fixture.feedback.review.documents
    });
    const [registered] = fixture.completedFeedback.events;
    if (registered === undefined) throw new Error("Missing feedback registration.");
    await feedback.register(fixture.feedback.run, registered);
    feedback.close();

    const repository = new SqliteFactoryExternalPullRequestRepairAdmissionRepository(databasePath, {
      documents: fixture.feedback.review.documents
    });
    try {
      await expect(
        repository.listCandidates({
          repositoryId: fixture.policy.repositoryId,
          reviewPolicyDigest: fixture.policy.reviewPolicyDigest,
          feedbackPolicyDigest: fixture.policy.feedbackPolicyDigest,
          admissionPolicyDigest: fixture.policyDocument.digest,
          limit: 5
        })
      ).resolves.toEqual([]);
    } finally {
      repository.close();
    }
  });
});

export async function seedCompletedExternalPullRequestFeedback(
  databasePath: string,
  fixture: ReturnType<typeof testExternalPullRequestRepairAdmissionFixture>
): Promise<void> {
  await seedCompletedReview(databasePath, fixture);
  const repository = new SqliteFactoryExternalPullRequestFeedbackRepository(databasePath, {
    documents: fixture.feedback.review.documents
  });
  try {
    const [registered, ...events] = fixture.completedFeedback.events;
    if (registered === undefined) throw new Error("Missing feedback registration.");
    await repository.register(fixture.feedback.run, registered);
    for (const event of events) {
      if (event.value.kind === "publication-recorded") {
        await repository.record(event, fixture.completedFeedback.record);
      } else {
        await repository.append(event);
      }
    }
  } finally {
    repository.close();
  }
}

async function seedCompletedReview(
  databasePath: string,
  fixture: ReturnType<typeof testExternalPullRequestRepairAdmissionFixture>
): Promise<void> {
  await seedDiscovery(databasePath, fixture);
  const repository = new SqliteFactoryExternalPullRequestReviewRepository(databasePath, {
    documents: fixture.feedback.review.documents
  });
  try {
    const [registered, ...events] = fixture.feedback.completedReview.events;
    if (registered === undefined) throw new Error("Missing review registration.");
    await repository.register(fixture.feedback.review.run, registered);
    for (const event of events) {
      if (event.value.kind === "bundle-recorded") {
        await repository.recordBundle(event, fixture.feedback.completedReview.bundle);
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
  fixture: ReturnType<typeof testExternalPullRequestRepairAdmissionFixture>
): Promise<void> {
  const discovery = fixture.feedback.review.discovery;
  const documents = fixture.feedback.review.documents;
  const repository = new SqliteFactoryExternalPullRequestDiscoveryRepository(databasePath, {
    documents
  });
  try {
    const registered = registeredExternalPullRequestEvent(discovery);
    await repository.register(discovery.run, registered);
    const started = documents.externalPullRequestDiscoveryEvent({
      schemaVersion: "agentlab.external-pull-request-discovery-event.v1",
      eventId: "91000000-0000-4000-8000-000000000004",
      runId: discovery.run.value.runId,
      runDigest: discovery.run.digest,
      sequence: 2,
      previousEventDigest: registered.digest,
      actor: registered.value.actor,
      kind: "inventory-started",
      from: "ready",
      to: "fetching",
      occurredAt: "2026-09-01T12:06:00.000Z",
      reasonCode: "bounded-read-started",
      correlationId: discovery.run.value.correlationId
    });
    await repository.append(started);
    const snapshot = testExternalPullRequestSnapshot(discovery);
    const recorded = documents.externalPullRequestDiscoveryEvent({
      schemaVersion: "agentlab.external-pull-request-discovery-event.v1",
      eventId: "91000000-0000-4000-8000-000000000005",
      runId: discovery.run.value.runId,
      runDigest: discovery.run.digest,
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
      correlationId: discovery.run.value.correlationId
    });
    await repository.recordSnapshot(recorded, snapshot);
    await repository.append(
      documents.externalPullRequestDiscoveryEvent({
        schemaVersion: "agentlab.external-pull-request-discovery-event.v1",
        eventId: "91000000-0000-4000-8000-000000000006",
        runId: discovery.run.value.runId,
        runDigest: discovery.run.digest,
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
        correlationId: discovery.run.value.correlationId
      })
    );
  } finally {
    repository.close();
  }
}

function temporaryDatabase(): string {
  const root = mkdtempSync(join(tmpdir(), "agentlab-external-pr-repair-admission-"));
  roots.push(root);
  return join(root, "agentlab.sqlite");
}

function idFactory() {
  let next = 1;
  return () => `94000000-0000-4000-8000-${String(next++).padStart(12, "0")}`;
}
