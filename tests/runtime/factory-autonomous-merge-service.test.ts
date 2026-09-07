import type {
  EvidenceBundle,
  FactoryAutonomousMergeEvent,
  ImmutableTaskContract,
  Sha256Digest,
  TaskEvent
} from "@agentlab/contracts";
import { describe, expect, it, vi } from "vitest";

import { FactoryAutonomousMergeService } from "../../packages/runtime/src/application/factory-autonomous-merge-service.js";
import { createFactoryEvidenceCredential } from "../../packages/runtime/src/application/factory-evidence-ingress.js";
import type { FactoryAutonomousMergeRemoteSnapshot } from "../../packages/runtime/src/domain/factory-autonomous-merge-broker.js";
import type { FactoryAutonomousMerger } from "../../packages/runtime/src/domain/factory-autonomous-merge-broker.js";
import {
  FactoryAutonomousMergeCapacityError,
  type FactoryAutonomousMergeJournalSnapshot,
  type FactoryAutonomousMergeRepository
} from "../../packages/runtime/src/domain/factory-autonomous-merge-repository.js";
import type { CanonicalFactoryDocument } from "../../packages/runtime/src/domain/factory-documents.js";
import type { FactoryTaskSnapshot } from "../../packages/runtime/src/domain/factory-task-repository.js";
import { NodeFactoryDocumentCodec } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { GitHubAutonomousMerger } from "../../packages/runtime/src/infrastructure/github/github-autonomous-merger.js";
import type { GitHubGraphqlApi } from "../../packages/runtime/src/infrastructure/github/github-graphql-client.js";
import {
  TEST_MERGE_BASE_REVISION,
  TEST_MERGE_HEAD_REVISION,
  TEST_MERGE_REPOSITORY_ID,
  testFactoryAutonomousMergeAuthorization,
  testFactoryAutonomousMergePolicy
} from "../helpers/factory-autonomous-merge.js";
import {
  TEST_FACTORY_CORRELATION_ID,
  TEST_FACTORY_TASK_ID,
  testDigest,
  testFactoryActor,
  testFactoryContract
} from "../helpers/factory.js";

const documents = new NodeFactoryDocumentCodec();

describe("FactoryAutonomousMergeService", () => {
  it("records durable intent before each remote effect and reports queued work as pending", async () => {
    const fixture = serviceFixture();

    await expect(fixture.service.tick(fixture.pins)).resolves.toMatchObject({
      status: "pending",
      inspected: 1,
      pending: 1,
      blocked: 0,
      runs: [{ status: "pending", pullRequestNumber: 42 }]
    });
    expect(fixture.log).toEqual([
      "remote-observe",
      "journal-ready-intent-recorded",
      "remote-mark-ready",
      "journal-ready-for-review",
      "task-merge-queued",
      "journal-enqueue-intent-recorded",
      "remote-enqueue",
      "journal-enqueued"
    ]);
  });

  it("carries an admitted authorization through the real GitHub adapter to the merge queue", async () => {
    let draft = true;
    let mergeQueueEntryId: string | null = null;
    const request = vi.fn<GitHubGraphqlApi["request"]>((query, variables) => {
      if (query.includes("markPullRequestReadyForReview")) {
        fixture.log.push("github-mark-ready");
        draft = false;
        return Promise.resolve({
          data: { markPullRequestReadyForReview: { pullRequest: pullRequest() } }
        });
      }
      if (query.includes("enqueuePullRequest")) {
        fixture.log.push("github-enqueue");
        expect(variables).toMatchObject({
          input: {
            expectedHeadOid: TEST_MERGE_HEAD_REVISION,
            pullRequestId: "PR_42"
          }
        });
        mergeQueueEntryId = "MQE_123";
        return Promise.resolve({
          data: { enqueuePullRequest: { mergeQueueEntry: { id: mergeQueueEntryId } } }
        });
      }
      fixture.log.push("github-observe");
      return Promise.resolve({ data: { repository: { pullRequest: pullRequest() } } });
    });
    const fixture = serviceFixture(
      {},
      () =>
        new GitHubAutonomousMerger({
          repositoryId: TEST_MERGE_REPOSITORY_ID,
          mergerId: "github-app/agentlab-merger",
          api: { request }
        })
    );
    function pullRequest() {
      return {
        id: "PR_42",
        number: 42,
        url: "https://github.com/RiadMefti/agentlab/pull/42",
        state: "OPEN",
        isDraft: draft,
        merged: false,
        mergedAt: null,
        baseRefOid: TEST_MERGE_BASE_REVISION,
        headRefOid: TEST_MERGE_HEAD_REVISION,
        mergeCommit: null,
        mergeQueueEntry: mergeQueueEntryId === null ? null : { id: mergeQueueEntryId }
      };
    }

    await expect(fixture.service.tick(fixture.pins)).resolves.toMatchObject({
      status: "pending",
      runs: [{ status: "pending", pullRequestNumber: 42 }]
    });
    expect(fixture.log.indexOf("journal-ready-intent-recorded")).toBeLessThan(
      fixture.log.indexOf("github-mark-ready")
    );
    expect(fixture.log.indexOf("journal-enqueue-intent-recorded")).toBeLessThan(
      fixture.log.indexOf("github-enqueue")
    );
    expect(request.mock.calls.some(([query]) => query.includes("mergePullRequest"))).toBe(false);
  });

  it("fails closed before candidate selection when merge authority is disabled", async () => {
    const fixture = serviceFixture({ mergeBroker: false });

    await expect(fixture.service.preflight()).resolves.toMatchObject({
      status: "blocked",
      mergeBrokerEnabled: false,
      reasonCodes: ["merge-broker-disabled"]
    });
    await expect(fixture.service.tick(fixture.pins)).resolves.toMatchObject({
      status: "blocked",
      inspected: 0,
      reasonCodes: ["merge-broker-disabled"]
    });
    expect(fixture.log).toEqual([]);
  });

  it.each(["scheduler", "prBroker", "mergeBroker"] as const)(
    "observes queued work after disabling %s without repeating remote writes",
    async (control) => {
      const fixture = serviceFixture();
      await fixture.service.tick(fixture.pins);
      fixture.authority[control] = false;
      fixture.log.length = 0;
      fixture.defaultRemote.observe.mockImplementation(() => {
        fixture.log.push("remote-observe");
        return Promise.resolve(remoteSnapshot(false, "MQE_123"));
      });

      await expect(fixture.service.preflight()).resolves.toMatchObject({ status: "blocked" });
      await expect(fixture.service.tick(fixture.pins)).resolves.toMatchObject({
        status: "pending",
        inspected: 1,
        pending: 1
      });
      expect(fixture.log).toEqual(["remote-observe"]);
      expect(fixture.defaultRemote.markReadyForReview).toHaveBeenCalledTimes(1);
      expect(fixture.defaultRemote.enqueue).toHaveBeenCalledTimes(1);
    }
  );

  it("rejects any operator tick whose reviewed policy coordinates drift", async () => {
    const fixture = serviceFixture();

    await expect(
      fixture.service.tick({ ...fixture.pins, expectedMergePolicyDigest: testDigest("f") })
    ).rejects.toThrow(/changed after operator review/u);
    expect(fixture.log).toEqual([]);
  });

  it("does not admit a PR when queued or carried-over work consumes daily capacity", async () => {
    const fixture = serviceFixture();
    const capacity = vi.spyOn(fixture.repository, "countCapacityForUtcDay").mockResolvedValue(2);
    await expect(fixture.service.tick(fixture.pins)).resolves.toMatchObject({
      status: "blocked",
      inspected: 0,
      reasonCodes: ["merge-daily-capacity-exhausted"]
    });
    expect(capacity).toHaveBeenCalledWith({
      repositoryId: TEST_MERGE_REPOSITORY_ID,
      at: "2026-09-01T12:00:10.000Z"
    });
    expect(fixture.log).toEqual([]);
  });

  it("handles capacity consumed after projection without making a remote write", async () => {
    const fixture = serviceFixture();
    vi.spyOn(fixture.repository, "register").mockRejectedValue(
      new FactoryAutonomousMergeCapacityError()
    );
    await expect(fixture.service.tick(fixture.pins)).resolves.toMatchObject({
      status: "blocked",
      inspected: 0,
      reasonCodes: ["merge-daily-capacity-exhausted"]
    });
    expect(fixture.log).toEqual([]);
  });

  it("continues queue reconciliation when the daily reservation allowance is full", async () => {
    const fixture = serviceFixture();
    await fixture.service.tick(fixture.pins);
    fixture.log.length = 0;
    vi.spyOn(fixture.repository, "countCapacityForUtcDay").mockResolvedValue(2);
    fixture.defaultRemote.observe.mockImplementation(() => {
      fixture.log.push("remote-observe");
      return Promise.resolve(remoteSnapshot(false, "MQE_123"));
    });
    await expect(fixture.service.tick(fixture.pins)).resolves.toMatchObject({
      status: "pending",
      pending: 1,
      reasonCodes: expect.arrayContaining(["merge-daily-capacity-exhausted"])
    });
    expect(fixture.log).toEqual(["remote-observe"]);
    expect(fixture.defaultRemote.enqueue).toHaveBeenCalledTimes(1);
  });
});

function serviceFixture(
  authorityOverrides: Partial<{
    readonly scheduler: boolean;
    readonly prBroker: boolean;
    readonly mergeBroker: boolean;
  }> = {},
  createRemote?: (
    authorization: ReturnType<NodeFactoryDocumentCodec["autonomousMergeAuthorization"]>
  ) => FactoryAutonomousMerger
) {
  const authority = {
    scheduler: true,
    prBroker: true,
    mergeBroker: true,
    ...authorityOverrides
  };
  const log: string[] = [];
  const policy = documents.autonomousMergePolicy(testFactoryAutonomousMergePolicy());
  const policyBundleDigest = testDigest("5");
  const contract: CanonicalFactoryDocument<ImmutableTaskContract> = documents.taskContract({
    ...testFactoryContract(),
    createdAt: "2026-09-01T11:00:00.000Z",
    expiresAt: "2026-09-01T13:00:00.000Z",
    repository: { id: TEST_MERGE_REPOSITORY_ID, baseRevision: TEST_MERGE_BASE_REVISION },
    trigger: "scheduled",
    gateProfile: { ...testFactoryContract().gateProfile, policyDigest: policyBundleDigest },
    approvals: { ...testFactoryContract().approvals, merge: { mode: "automatic" } }
  });
  const authorization = documents.autonomousMergeAuthorization(
    testFactoryAutonomousMergeAuthorization({
      contractDigest: contract.digest,
      policyBundleDigest,
      mergePolicyDigest: policy.digest
    })
  );
  const authorizationBundle: CanonicalFactoryDocument<EvidenceBundle> = documents.evidenceBundle(
    authorizationEvidence(contract, authorization)
  );
  let task = taskSnapshot(contract, authorizationBundle.digest);
  const repository = new MemoryMergeRepository(log);
  const draft = remoteSnapshot(true, null);
  const ready = remoteSnapshot(false, null);
  const defaultRemote = {
    identity: () => ({
      repositoryId: TEST_MERGE_REPOSITORY_ID,
      mergerId: policy.value.mergerId
    }),
    observe: vi.fn(() => {
      log.push("remote-observe");
      return Promise.resolve(draft);
    }),
    markReadyForReview: vi.fn(() => {
      log.push("remote-mark-ready");
      return Promise.resolve(ready);
    }),
    enqueue: vi.fn(() => {
      log.push("remote-enqueue");
      return Promise.resolve({
        snapshot: { ...ready, mergeQueueEntryId: "MQE_123" },
        mergeQueueEntryId: "MQE_123",
        created: true
      });
    }),
    verifyRecord: vi.fn(() => Promise.resolve())
  };
  const remote = createRemote?.(authorization) ?? defaultRemote;
  let id = 0;
  const service = new FactoryAutonomousMergeService({
    mergePolicy: policy,
    factoryPolicyBundleDigest: policyBundleDigest,
    repository,
    tasks: {
      findById: () => Promise.resolve(task),
      listByState: (state, limit) =>
        Promise.resolve(limit > 0 && task.state === state ? [task] : [])
    },
    evidence: {
      listEvidence: () =>
        Promise.resolve([{ bundle: authorizationBundle.value, digest: authorizationBundle.digest }])
    },
    controls: { state: () => Promise.resolve(authority) },
    controlPlane: {
      transition: (input) => {
        log.push("task-merge-queued");
        const command = input as { readonly expectedState?: unknown; readonly nextState?: unknown };
        if (command.expectedState !== "merge-ready" || command.nextState !== "merge-queued") {
          throw new Error("Unexpected test task transition.");
        }
        task = { ...task, state: "merge-queued" };
        return Promise.resolve(task);
      }
    },
    artifacts: {
      put: vi.fn(),
      putText: vi.fn(),
      read: vi.fn(),
      readText: () => Promise.resolve(authorization.json)
    },
    documents,
    evidenceIngress: {} as never,
    evidenceCredentials: { merger: createFactoryEvidenceCredential() },
    remote,
    now: () => "2026-09-01T12:00:10.000Z",
    createId: () => `61000000-0000-4000-8000-${String((id += 1)).padStart(12, "0")}`
  });
  return {
    service,
    repository,
    log,
    authority,
    defaultRemote,
    pins: {
      expectedMergePolicyDigest: policy.digest,
      expectedFactoryPolicyBundleDigest: policyBundleDigest,
      expectedSchedulePolicyDigest: policy.value.schedulePolicyDigest,
      expectedDailyQuotaPolicyDigest: policy.value.dailyQuotaPolicyDigest,
      expectedRoleIdentityPolicyDigest: policy.value.roleIdentityPolicyDigest
    }
  };
}

class MemoryMergeRepository implements FactoryAutonomousMergeRepository {
  #journal: FactoryAutonomousMergeJournalSnapshot | null = null;

  public constructor(private readonly log: string[]) {}

  public listActive(): Promise<readonly FactoryAutonomousMergeJournalSnapshot[]> {
    return Promise.resolve(
      this.#journal === null || ["completed", "stale", "quarantined"].includes(this.#journal.state)
        ? []
        : [this.#journal]
    );
  }

  public countCompletedForUtcDay(): Promise<number> {
    return Promise.resolve(0);
  }

  public countCapacityForUtcDay(): Promise<number> {
    return Promise.resolve(this.#journal === null ? 0 : 1);
  }

  public register(
    _policy: unknown,
    run: CanonicalFactoryDocument<FactoryAutonomousMergeJournalSnapshot["run"]>,
    event: CanonicalFactoryDocument<FactoryAutonomousMergeEvent>
  ): Promise<FactoryAutonomousMergeJournalSnapshot> {
    this.#journal = snapshot(run, [event]);
    return Promise.resolve(this.#journal);
  }

  public append(
    event: CanonicalFactoryDocument<FactoryAutonomousMergeEvent>
  ): Promise<FactoryAutonomousMergeJournalSnapshot | null> {
    if (this.#journal === null) return Promise.resolve(null);
    this.log.push(`journal-${event.value.kind}`);
    const run = { value: this.#journal.run, digest: this.#journal.runDigest, json: "" };
    const history = this.#journal.history.map((value) => documents.autonomousMergeEvent(value));
    this.#journal = snapshot(run, [...history, event]);
    return Promise.resolve(this.#journal);
  }

  public record(): Promise<FactoryAutonomousMergeJournalSnapshot | null> {
    throw new Error("Pending-path test must not publish a merge record.");
  }

  public close(): void {
    return undefined;
  }
}

function snapshot(
  run: CanonicalFactoryDocument<FactoryAutonomousMergeJournalSnapshot["run"]>,
  events: readonly CanonicalFactoryDocument<FactoryAutonomousMergeEvent>[]
): FactoryAutonomousMergeJournalSnapshot {
  const last = events.at(-1);
  if (last === undefined) throw new Error("Test merge journal has no event.");
  return {
    run: run.value,
    runDigest: run.digest,
    state: last.value.to,
    sequence: last.value.sequence,
    lastEvent: last.value,
    lastEventDigest: last.digest,
    history: events.map(({ value }) => value),
    record: null
  };
}

function authorizationEvidence(
  contract: CanonicalFactoryDocument<ImmutableTaskContract>,
  authorization: ReturnType<NodeFactoryDocumentCodec["autonomousMergeAuthorization"]>
): EvidenceBundle {
  return {
    schemaVersion: "agentlab.evidence-bundle.v1",
    bundleId: "62000000-0000-4000-8000-000000000002",
    taskId: TEST_FACTORY_TASK_ID,
    sequence: 2,
    contractDigest: contract.digest,
    previousBundleDigest: testDigest("0"),
    policyBundleDigest: authorization.value.policyBundleDigest,
    createdAt: authorization.value.issuedAt,
    items: [
      {
        id: "63000000-0000-4000-8000-000000000003",
        kind: "merge",
        result: "pass",
        subjectDigest: authorization.digest,
        artifact: {
          digest: authorization.digest,
          mediaType: "application/vnd.agentlab.autonomous-merge-authorization.v1+json",
          sizeBytes: Buffer.byteLength(authorization.json)
        },
        producer: {
          kind: "control-plane",
          role: "policy-engine",
          id: "agentlab-policy",
          sessionId: null
        },
        createdAt: authorization.value.issuedAt,
        claims: [
          { name: "merge-policy-digest", value: authorization.value.mergePolicyDigest },
          { name: "head-revision", value: authorization.value.expectedHeadRevision }
        ]
      }
    ],
    attestations: []
  };
}

function taskSnapshot(
  contract: CanonicalFactoryDocument<ImmutableTaskContract>,
  evidenceBundleDigest: Sha256Digest
): FactoryTaskSnapshot {
  const event: CanonicalFactoryDocument<TaskEvent> = documents.taskEvent({
    schemaVersion: "agentlab.task-event.v1",
    eventId: "64000000-0000-4000-8000-000000000004",
    taskId: contract.value.taskId,
    sequence: 11,
    contractDigest: contract.digest,
    previousEventDigest: testDigest("1"),
    from: "pr-open",
    to: "merge-ready",
    actor: testFactoryActor,
    occurredAt: "2026-09-01T12:00:05.000Z",
    reasonCode: "merge-authorized",
    summary: null,
    evidenceBundleDigest,
    correlationId: TEST_FACTORY_CORRELATION_ID
  });
  return {
    contract: contract.value,
    contractDigest: contract.digest,
    state: "merge-ready",
    sequence: event.value.sequence,
    lastEvent: event.value,
    lastEventDigest: event.digest
  };
}

function remoteSnapshot(
  draft: boolean,
  mergeQueueEntryId: string | null
): FactoryAutonomousMergeRemoteSnapshot {
  return {
    repositoryId: TEST_MERGE_REPOSITORY_ID,
    pullRequestNodeId: "PR_42",
    pullRequestNumber: 42,
    pullRequestUrl: "https://github.com/RiadMefti/agentlab/pull/42",
    state: "open",
    draft,
    merged: false,
    baseRevision: TEST_MERGE_BASE_REVISION,
    headRevision: TEST_MERGE_HEAD_REVISION,
    mergeQueueEntryId,
    mergedRevision: null,
    mergedAt: null
  };
}
