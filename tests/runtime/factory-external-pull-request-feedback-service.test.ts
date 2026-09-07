import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  FactoryExternalPullRequestFeedbackEvent,
  FactoryExternalPullRequestFeedbackRecord,
  FactoryExternalPullRequestFeedbackRun,
  Sha256Digest
} from "@agentlab/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { FactoryExternalPullRequestFeedbackService } from "../../packages/runtime/src/application/factory-external-pull-request-feedback-service.js";
import type { FactoryExternalPullRequestFeedbackPublisher } from "../../packages/runtime/src/domain/factory-external-pull-request-feedback-publisher.js";
import type {
  FactoryExternalPullRequestFeedbackJournalSnapshot,
  FactoryExternalPullRequestFeedbackRepository
} from "../../packages/runtime/src/domain/factory-external-pull-request-feedback-repository.js";
import type { CanonicalFactoryDocument } from "../../packages/runtime/src/domain/factory-documents.js";
import { FileFactoryArtifactStore } from "../../packages/runtime/src/infrastructure/filesystem/file-factory-artifact-store.js";
import { testExternalPullRequestFeedbackFixture } from "../helpers/factory-external-pull-request-feedback.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("FactoryExternalPullRequestFeedbackService", () => {
  it("publishes a deterministic advisory comment from completed review evidence exactly once", async () => {
    const fixture = testExternalPullRequestFeedbackFixture();
    const repository = new MemoryFeedbackRepository(fixture);
    const publisher = new MemoryFeedbackPublisher(fixture);
    const service = createService(fixture, repository, publisher);

    await expect(service.preflight()).resolves.toMatchObject({
      status: "ready",
      authorityEnabled: true,
      publisherId: fixture.policy.publisherId
    });
    const report = await service.tick({
      expectedFeedbackPolicyDigest: fixture.policyDocument.digest,
      expectedReviewPolicyDigest: fixture.policy.reviewPolicyDigest
    });

    expect(report).toMatchObject({
      status: "completed",
      inspected: 1,
      published: 1,
      reconciled: 0,
      attentionRequired: 0,
      failed: 0
    });
    expect(publisher.publish).toHaveBeenCalledOnce();
    const published = publisher.publish.mock.calls[0]?.[0];
    expect(published?.body).toContain(
      `<!-- agentlab-external-review:${fixture.completedReview.bundle.digest} -->`
    );
    expect(published?.body).toContain("not an approval, merge decision, or repair authorization");
    expect(published?.body).not.toContain(fixture.review.candidate.untrustedTitle);
    expect(repository.snapshot).toMatchObject({ state: "completed", record: { source: "posted" } });
    await expect(
      service.tick({
        expectedFeedbackPolicyDigest: fixture.policyDocument.digest,
        expectedReviewPolicyDigest: fixture.policy.reviewPolicyDigest
      })
    ).resolves.toMatchObject({ status: "idle", inspected: 0 });
  });

  it("reconciles an uncertain POST by marker without issuing a duplicate publication", async () => {
    const fixture = testExternalPullRequestFeedbackFixture();
    const repository = new MemoryFeedbackRepository(fixture);
    const publisher = new MemoryFeedbackPublisher(fixture);
    publisher.failAfterRemoteWrite = true;
    const service = createService(fixture, repository, publisher);

    await expect(
      service.tick({
        expectedFeedbackPolicyDigest: fixture.policyDocument.digest,
        expectedReviewPolicyDigest: fixture.policy.reviewPolicyDigest
      })
    ).resolves.toMatchObject({
      status: "blocked",
      runs: [{ status: "blocked", reasonCode: "feedback-publication-outcome-uncertain" }]
    });
    expect(repository.snapshot?.state).toBe("publication-active");
    expect(publisher.publish).toHaveBeenCalledOnce();

    await expect(
      service.tick({
        expectedFeedbackPolicyDigest: fixture.policyDocument.digest,
        expectedReviewPolicyDigest: fixture.policy.reviewPolicyDigest
      })
    ).resolves.toMatchObject({ status: "completed", reconciled: 1, published: 0 });
    expect(publisher.publish).toHaveBeenCalledOnce();
    expect(repository.snapshot).toMatchObject({
      state: "completed",
      record: { source: "reconciled", remoteReviewId: "98765" }
    });
  });
});

function createService(
  fixture: ReturnType<typeof testExternalPullRequestFeedbackFixture>,
  repository: MemoryFeedbackRepository,
  publisher: MemoryFeedbackPublisher
) {
  const root = mkdtempSync(join(tmpdir(), "agentlab-external-pr-feedback-service-"));
  roots.push(root);
  return new FactoryExternalPullRequestFeedbackService({
    feedbackPolicy: fixture.policyDocument,
    repository,
    artifacts: new FileFactoryArtifactStore(join(root, "artifacts")),
    documents: fixture.review.documents,
    publisher,
    controls: { state: () => Promise.resolve({ scheduler: false, prBroker: true }) },
    now: () => "2026-09-01T12:18:40.000Z",
    createId: idFactory()
  });
}

class MemoryFeedbackPublisher implements FactoryExternalPullRequestFeedbackPublisher {
  public failAfterRemoteWrite = false;
  #publication: ReturnType<MemoryFeedbackPublisher["remotePublication"]> | null = null;
  public readonly publish = vi.fn(
    (input: Parameters<FactoryExternalPullRequestFeedbackPublisher["publish"]>[0]) => {
      const publication = this.remotePublication(input.bodyDigest, input.headRevision);
      this.#publication = publication;
      if (this.failAfterRemoteWrite) {
        this.failAfterRemoteWrite = false;
        return Promise.reject(new Error("connection ended after remote acceptance"));
      }
      return Promise.resolve(publication);
    }
  );

  public constructor(
    private readonly fixture: ReturnType<typeof testExternalPullRequestFeedbackFixture>
  ) {}

  public identity() {
    return {
      repositoryId: this.fixture.policy.repositoryId,
      repositoryNumericId: 123,
      publisherId: this.fixture.policy.publisherId,
      publisherUserId: this.fixture.policy.publisherUserId
    };
  }

  public inspectRepository() {
    return Promise.resolve({
      repositoryId: this.fixture.policy.repositoryId,
      repositoryNumericId: 123
    });
  }

  public inspect() {
    return Promise.resolve({
      repositoryId: this.fixture.policy.repositoryId,
      pullRequestNumber: this.fixture.review.candidate.pullRequestNumber,
      url: this.fixture.review.candidate.url,
      state: "open" as const,
      draft: false,
      merged: false,
      baseRevision: this.fixture.review.candidate.base.revision,
      headRevision: this.fixture.review.candidate.head.revision,
      existingPublication: this.#publication
    });
  }

  private remotePublication(bodyDigest: Sha256Digest, headRevision: string) {
    return {
      reviewId: "98765",
      state: "commented" as const,
      url: "https://github.com/owner/agentlab/pull/42#pullrequestreview-98765",
      headRevision,
      bodyDigest,
      submittedAt: "2026-09-01T12:18:35.000Z"
    };
  }
}

class MemoryFeedbackRepository implements FactoryExternalPullRequestFeedbackRepository {
  public snapshot: FactoryExternalPullRequestFeedbackJournalSnapshot | null = null;
  #candidateAvailable = true;

  public constructor(
    private readonly fixture: ReturnType<typeof testExternalPullRequestFeedbackFixture>
  ) {}

  public listCompletedReviews() {
    return Promise.resolve(
      this.#candidateAvailable
        ? [
            {
              reviewRun: this.fixture.review.run.value,
              reviewRunDigest: this.fixture.review.run.digest,
              bundle: this.fixture.completedReview.bundle.value,
              bundleDigest: this.fixture.completedReview.bundle.digest
            }
          ]
        : []
    );
  }

  public listActive() {
    return Promise.resolve(
      this.snapshot !== null &&
        ["ready", "remote-verified", "publication-active", "recorded"].includes(this.snapshot.state)
        ? [this.snapshot]
        : []
    );
  }

  public findByBundle() {
    return Promise.resolve(this.snapshot);
  }

  public register(
    run: CanonicalFactoryDocument<FactoryExternalPullRequestFeedbackRun>,
    event: CanonicalFactoryDocument<FactoryExternalPullRequestFeedbackEvent>
  ) {
    this.#candidateAvailable = false;
    this.snapshot = snapshot(run, [event], null);
    return Promise.resolve(this.snapshot);
  }

  public append(event: CanonicalFactoryDocument<FactoryExternalPullRequestFeedbackEvent>) {
    if (event.value.runDigest !== this.snapshot?.runDigest) {
      return Promise.resolve(null);
    }
    const run = this.fixture.review.documents.externalPullRequestFeedbackRun(this.snapshot.run);
    const history = this.snapshot.history.map((value) =>
      this.fixture.review.documents.externalPullRequestFeedbackEvent(value)
    );
    this.snapshot = snapshot(run, [...history, event], this.snapshot.record);
    return Promise.resolve(this.snapshot);
  }

  public record(
    event: CanonicalFactoryDocument<FactoryExternalPullRequestFeedbackEvent>,
    record: CanonicalFactoryDocument<FactoryExternalPullRequestFeedbackRecord>
  ) {
    if (this.snapshot === null) return Promise.resolve(null);
    const run = this.fixture.review.documents.externalPullRequestFeedbackRun(this.snapshot.run);
    const history = this.snapshot.history.map((value) =>
      this.fixture.review.documents.externalPullRequestFeedbackEvent(value)
    );
    this.snapshot = snapshot(run, [...history, event], record.value);
    return Promise.resolve(this.snapshot);
  }

  public close(): void {
    // The in-memory repository owns no external resources.
  }
}

function snapshot(
  run: CanonicalFactoryDocument<FactoryExternalPullRequestFeedbackRun>,
  events: readonly CanonicalFactoryDocument<FactoryExternalPullRequestFeedbackEvent>[],
  record: FactoryExternalPullRequestFeedbackRecord | null
): FactoryExternalPullRequestFeedbackJournalSnapshot {
  const last = events.at(-1);
  if (last === undefined) throw new Error("Missing feedback event.");
  return {
    run: run.value,
    runDigest: run.digest,
    state: last.value.to,
    sequence: last.value.sequence,
    lastEvent: last.value,
    lastEventDigest: last.digest,
    history: events.map(({ value }) => value),
    record
  };
}

function idFactory(): () => string {
  let next = 100;
  return () => `94000000-0000-4000-8000-${String(next++).padStart(12, "0")}`;
}
