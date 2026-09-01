import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FactoryExternalPullRequestDiscoveryService } from "../../packages/runtime/src/application/factory-external-pull-request-discovery-service.js";
import type {
  FactoryExternalPullRequestPage,
  FactoryExternalPullRequestSource
} from "../../packages/runtime/src/domain/factory-external-pull-request-source.js";
import { FileFactoryArtifactStore } from "../../packages/runtime/src/infrastructure/filesystem/file-factory-artifact-store.js";
import { SqliteFactoryExternalPullRequestDiscoveryRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-external-pull-request-discovery-repository.js";
import {
  testExternalPullRequestCandidate,
  testExternalPullRequestDiscoveryFixture
} from "../helpers/factory-external-pull-request-discovery.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("FactoryExternalPullRequestDiscoveryService", () => {
  it("records one idempotent daily snapshot and excludes factory-owned PRs", async () => {
    const fixture = testExternalPullRequestDiscoveryFixture();
    const root = temporaryRoot();
    const repository = new SqliteFactoryExternalPullRequestDiscoveryRepository(
      join(root, "agentlab.sqlite"),
      { documents: fixture.documents }
    );
    const source = new FakeSource({
      items: [withoutDisposition(testExternalPullRequestCandidate())],
      truncated: true
    });
    const service = new FactoryExternalPullRequestDiscoveryService({
      repositoryId: "owner/agentlab",
      observerId: "github/pr-reader",
      discoveryPolicy: fixture.policyDocument,
      schedulePolicy: fixture.scheduleDocument,
      source,
      ownedPullRequests: {
        contains: (_repositoryId, number) => Promise.resolve(number === 42)
      },
      repository,
      artifacts: new FileFactoryArtifactStore(join(root, "artifacts")),
      documents: fixture.documents,
      now: sequencedNow([
        "2026-09-01T12:05:00.000Z",
        "2026-09-01T12:06:00.000Z",
        "2026-09-01T12:07:00.000Z"
      ]),
      createId: sequencedId()
    });
    try {
      const input = {
        expectedDiscoveryPolicyDigest: fixture.policyDocument.digest,
        expectedSchedulePolicyDigest: fixture.scheduleDocument.digest
      };
      await expect(service.tick(input)).resolves.toMatchObject({
        status: "completed",
        pullRequestsInspected: 1,
        factoryOwned: 1,
        agentReviewCandidates: 0,
        hasMore: true
      });
      await expect(service.tick(input)).resolves.toMatchObject({
        status: "already-completed",
        factoryOwned: 1
      });
      expect(source.listCalls).toBe(1);
    } finally {
      repository.close();
    }
  });

  it("records a terminal failure without exposing or retrying a remote error in the same slot", async () => {
    const fixture = testExternalPullRequestDiscoveryFixture();
    const root = temporaryRoot();
    const repository = new SqliteFactoryExternalPullRequestDiscoveryRepository(
      join(root, "agentlab.sqlite"),
      { documents: fixture.documents }
    );
    const source = new FakeSource({ items: [], truncated: false });
    source.failure = new Error("secret remote diagnostic");
    const service = testService(fixture, repository, source, root);
    const input = {
      expectedDiscoveryPolicyDigest: fixture.policyDocument.digest,
      expectedSchedulePolicyDigest: fixture.scheduleDocument.digest
    };
    try {
      await expect(service.tick(input)).resolves.toMatchObject({
        status: "failed",
        reasonCodes: ["external-pull-request-read-failed"]
      });
      await expect(service.tick(input)).resolves.toMatchObject({ status: "failed" });
      expect(source.listCalls).toBe(1);
      expect(JSON.stringify(await service.tick(input))).not.toContain("secret remote diagnostic");
    } finally {
      repository.close();
    }
  });

  it("preflights exact repository identity and blocks a missed daily deadline before reading PRs", async () => {
    const fixture = testExternalPullRequestDiscoveryFixture();
    const root = temporaryRoot();
    const repository = new SqliteFactoryExternalPullRequestDiscoveryRepository(
      join(root, "agentlab.sqlite"),
      { documents: fixture.documents }
    );
    const source = new FakeSource({ items: [], truncated: false });
    const service = new FactoryExternalPullRequestDiscoveryService({
      repositoryId: "owner/agentlab",
      observerId: "github/pr-reader",
      discoveryPolicy: fixture.policyDocument,
      schedulePolicy: fixture.scheduleDocument,
      source,
      ownedPullRequests: { contains: () => Promise.resolve(false) },
      repository,
      artifacts: new FileFactoryArtifactStore(join(root, "artifacts")),
      documents: fixture.documents,
      now: () => "2026-09-01T14:00:00.000Z",
      createId: sequencedId()
    });
    try {
      await expect(service.preflight()).resolves.toMatchObject({
        status: "ready",
        repositoryNumericId: 99,
        defaultBranch: "main"
      });
      await expect(
        service.tick({
          expectedDiscoveryPolicyDigest: fixture.policyDocument.digest,
          expectedSchedulePolicyDigest: fixture.scheduleDocument.digest
        })
      ).resolves.toMatchObject({
        status: "blocked",
        runId: null,
        reasonCodes: ["discovery-slot-deadline-missed"]
      });
      expect(source.listCalls).toBe(0);
    } finally {
      repository.close();
    }
  });
});

class FakeSource implements FactoryExternalPullRequestSource {
  public listCalls = 0;
  public failure: Error | null = null;

  public constructor(private readonly page: FactoryExternalPullRequestPage) {}

  public identity() {
    return { repositoryId: "owner/agentlab", observerId: "github/pr-reader" };
  }

  public inspectRepository() {
    return Promise.resolve({
      repositoryId: "owner/agentlab",
      repositoryNumericId: 99,
      defaultBranch: "main"
    });
  }

  public listOpen(): Promise<FactoryExternalPullRequestPage> {
    this.listCalls += 1;
    return this.failure === null ? Promise.resolve(this.page) : Promise.reject(this.failure);
  }
}

function testService(
  fixture: ReturnType<typeof testExternalPullRequestDiscoveryFixture>,
  repository: SqliteFactoryExternalPullRequestDiscoveryRepository,
  source: FactoryExternalPullRequestSource,
  root: string
) {
  return new FactoryExternalPullRequestDiscoveryService({
    repositoryId: "owner/agentlab",
    observerId: "github/pr-reader",
    discoveryPolicy: fixture.policyDocument,
    schedulePolicy: fixture.scheduleDocument,
    source,
    ownedPullRequests: { contains: () => Promise.resolve(false) },
    repository,
    artifacts: new FileFactoryArtifactStore(join(root, "artifacts")),
    documents: fixture.documents,
    now: sequencedNow([
      "2026-09-01T12:05:00.000Z",
      "2026-09-01T12:06:00.000Z",
      "2026-09-01T12:07:00.000Z"
    ]),
    createId: sequencedId()
  });
}

function withoutDisposition(candidate: ReturnType<typeof testExternalPullRequestCandidate>) {
  const { disposition, reasonCodes, ...remote } = candidate;
  void disposition;
  void reasonCodes;
  return remote;
}

function sequencedNow(values: readonly string[]) {
  let index = 0;
  return () => {
    const value = values[Math.min(index++, values.length - 1)];
    if (value === undefined) throw new Error("The test time sequence is empty.");
    return value;
  };
}

function sequencedId() {
  let value = 10;
  return () => `92000000-0000-4000-8000-${String(value++).padStart(12, "0")}`;
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agentlab-external-pr-discovery-service-"));
  temporaryRoots.push(root);
  return root;
}
