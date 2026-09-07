import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type {
  EvidenceBundle,
  FactoryAutonomousMergeEvent,
  FactoryAutonomousMergePolicy,
  FactoryAutonomousMergeRun,
  FactoryTaskState,
  ImmutableTaskContract,
  Sha256Digest,
  TaskEvent
} from "@agentlab/contracts";
import { afterEach, describe, expect, it } from "vitest";

import type { CanonicalFactoryDocument } from "../../packages/runtime/src/domain/factory-documents.js";
import { NodeFactoryDocumentCodec } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { SqliteFactoryAutonomousMergeRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-autonomous-merge-repository.js";
import { SqliteFactoryRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-repository.js";
import {
  TEST_MERGE_BASE_REVISION,
  TEST_MERGE_REPOSITORY_ID,
  testFactoryAutonomousMergeAuthorization,
  testFactoryAutonomousMergePolicy,
  testFactoryAutonomousMergeRecord,
  testFactoryAutonomousMergeRun
} from "../helpers/factory-autonomous-merge.js";
import {
  TEST_FACTORY_CORRELATION_ID,
  TEST_FACTORY_TASK_ID,
  testDigest,
  testFactoryActor,
  testFactoryContract
} from "../helpers/factory.js";

const documents = new NodeFactoryDocumentCodec();
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("SqliteFactoryAutonomousMergeRepository", () => {
  it.each(["2026-09-01", "2026-09-02"])(
    "accounts once for a run merged on %s, then releases it the following day",
    async (mergeDay) => {
      const fixture = await repositoryFixture();
      try {
        const registered = await fixture.merges.register(
          fixture.policy,
          fixture.run,
          fixture.registered,
          {
            authorization: fixture.authorization,
            evidenceBundleDigest: fixture.authorizationEvidence.digest
          }
        );
        expect(registered).toMatchObject({ state: "ready", sequence: 1, record: null });
        expect(await fixture.merges.listActive(query(fixture))).toHaveLength(1);
        expect(await capacity(fixture, "2026-09-01")).toBe(1);
        expect(await capacity(fixture, "2026-09-02")).toBe(1);

        let previous = fixture.registered;
        for (const transition of [
          {
            kind: "ready-intent-recorded",
            from: "ready",
            to: "ready-intent-recorded"
          },
          {
            kind: "ready-for-review",
            from: "ready-intent-recorded",
            to: "ready-for-review"
          },
          {
            kind: "enqueue-intent-recorded",
            from: "ready-for-review",
            to: "enqueue-intent-recorded"
          }
        ] as const) {
          previous = mergeEvent(fixture.run, previous, transition);
          await fixture.merges.append(previous);
        }
        previous = mergeEvent(fixture.run, previous, {
          kind: "enqueued",
          from: "enqueue-intent-recorded",
          to: "enqueued",
          mergeQueueEntryId: "MQE_123"
        });
        await fixture.merges.append(previous);
        const mergedAt = `${mergeDay}T12:10:00.000Z`;
        previous = mergeEvent(fixture.run, previous, {
          kind: "merged",
          from: "enqueued",
          to: "merged",
          mergeQueueEntryId: "MQE_123",
          mergedRevision: "e".repeat(40),
          mergedAt,
          occurredAt: mergedAt
        });
        await fixture.merges.append(previous);

        const record = documents.autonomousMergeRecord({
          ...testFactoryAutonomousMergeRecord({
            run: fixture.run.value,
            runDigest: fixture.run.digest,
            authorizationDigest: fixture.authorization.digest
          }),
          mergedAt,
          recordedAt: `${mergeDay}T12:11:00.000Z`
        });
        const recordEvidence = evidenceBundle({
          taskId: fixture.contract.value.taskId,
          contractDigest: fixture.contract.digest,
          policyBundleDigest: fixture.authorization.value.policyBundleDigest,
          sequence: 3,
          previousBundleDigest: fixture.authorizationEvidence.digest,
          bundleId: "58000000-0000-4000-8000-000000000008",
          subjectDigest: record.digest,
          mediaType: "application/vnd.agentlab.autonomous-merge-record.v1+json",
          createdAt: record.value.recordedAt
        });
        await fixture.tasks.appendEvidence(recordEvidence);
        const recorded = mergeEvent(fixture.run, previous, {
          kind: "evidence-recorded",
          from: "merged",
          to: "merge-evidence-recorded",
          recordDigest: record.digest,
          evidenceBundleDigest: recordEvidence.digest
        });
        await expect(fixture.merges.record(recorded, record)).resolves.toMatchObject({
          state: "merge-evidence-recorded",
          record: record.value
        });

        const mergedTask = await advanceTask(
          fixture,
          ["merge-queued", "merged"],
          recordEvidence.digest
        );
        const completed = mergeEvent(fixture.run, recorded, {
          kind: "completed",
          from: "merge-evidence-recorded",
          to: "completed",
          taskEventDigest: mergedTask.digest
        });
        await fixture.merges.append(completed);

        expect(await fixture.merges.listActive(query(fixture))).toEqual([]);
        await expect(
          fixture.merges.countCompletedForUtcDay({
            repositoryId: TEST_MERGE_REPOSITORY_ID,
            mergePolicyDigest: fixture.policy.digest,
            windowStart: "2026-09-01T00:00:00.000Z",
            windowEnd: "2026-09-02T00:00:00.000Z"
          })
        ).resolves.toBe(mergeDay === "2026-09-01" ? 1 : 0);
        // Registration and merge on the same day never double-charge. A next-day merge remains
        // charged after journal completion, while yesterday's completed merge releases today.
        expect(await capacity(fixture, mergeDay)).toBe(1);
        expect(await capacity(fixture, "2026-09-03")).toBe(0);
        expect(await capacity(fixture, "2026-09-02")).toBe(mergeDay === "2026-09-02" ? 1 : 0);
      } finally {
        fixture.merges.close();
        fixture.tasks.close();
      }
    }
  );

  it("rejects a run without the exact merge-ready authorization evidence", async () => {
    const fixture = await repositoryFixture();
    try {
      expect(() =>
        fixture.merges.register(fixture.policy, fixture.run, fixture.registered, {
          authorization: fixture.authorization,
          evidenceBundleDigest: testDigest("f")
        })
      ).toThrow(/exact merge-ready evidence/u);
      const database = new DatabaseSync(fixture.path);
      expect(
        database.prepare("SELECT COUNT(*) AS count FROM factory_autonomous_merge_runs").get()
      ).toMatchObject({ count: 0 });
      database.close();
    } finally {
      fixture.merges.close();
      fixture.tasks.close();
    }
  });

  it("reserves atomically across policy changes and separate database connections", async () => {
    const first = await repositoryFixture({ policy: { maximumMergesPerUtcDay: 1 } });
    const second = await repositoryFixture({
      path: first.path,
      taskId: randomUUID(),
      policy: { version: "1.0.1", maximumMergesPerUtcDay: 1 }
    });
    try {
      // Both callers projected free capacity before either attempted registration.
      expect(await capacity(first, "2026-09-01")).toBe(0);
      expect(await capacity(second, "2026-09-01")).toBe(0);
      await register(first);
      expect(() => register(second)).toThrow(/daily capacity is exhausted/u);
      expect(await capacity(second, "2026-09-01")).toBe(1);
      expect(await second.merges.listActive(query(second))).toEqual([]);
      expect(await first.merges.listActive(query(first))).toHaveLength(1);
      // A retry cannot create another reservation or reset the allowance.
      expect(() => register(second)).toThrow(/daily capacity is exhausted/u);
      expect(await capacity(first, "2026-09-02")).toBe(1);
      expect(
        await first.merges.countCapacityForUtcDay({
          repositoryId: "another/repository",
          at: first.run.value.createdAt
        })
      ).toBe(0);
    } finally {
      first.merges.close();
      first.tasks.close();
      second.merges.close();
      second.tasks.close();
    }
  });

  it.each(["stale", "quarantined"] as const)(
    "releases a %s pre-enqueue reservation only on the next UTC day",
    async (state) => {
      const fixture = await repositoryFixture();
      try {
        await register(fixture);
        await fixture.merges.append(
          mergeEvent(fixture.run, fixture.registered, {
            kind: state,
            from: "ready",
            to: state
          })
        );
        expect(await capacity(fixture, "2026-09-01")).toBe(1);
        expect(await capacity(fixture, "2026-09-02")).toBe(0);
      } finally {
        fixture.merges.close();
        fixture.tasks.close();
      }
    }
  );

  it.each(["enqueue-intent-recorded", "enqueued", "quarantined"] as const)(
    "retains %s capacity across UTC days even without a completion record",
    async (state) => {
      const fixture = await repositoryFixture();
      try {
        await register(fixture);
        let previous = fixture.registered;
        for (const transition of [
          { kind: "ready-intent-recorded", from: "ready", to: "ready-intent-recorded" },
          { kind: "ready-for-review", from: "ready-intent-recorded", to: "ready-for-review" },
          {
            kind: "enqueue-intent-recorded",
            from: "ready-for-review",
            to: "enqueue-intent-recorded"
          }
        ] as const) {
          previous = mergeEvent(fixture.run, previous, transition);
          await fixture.merges.append(previous);
        }
        if (state !== "enqueue-intent-recorded") {
          previous = mergeEvent(fixture.run, previous, {
            kind: "enqueued",
            from: "enqueue-intent-recorded",
            to: "enqueued",
            mergeQueueEntryId: "MQE_123"
          });
          await fixture.merges.append(previous);
        }
        if (state === "quarantined") {
          await fixture.merges.append(
            mergeEvent(fixture.run, previous, {
              kind: "quarantined",
              from: "enqueued",
              to: "quarantined"
            })
          );
        }
        expect(await capacity(fixture, "2026-09-01")).toBe(1);
        expect(await capacity(fixture, "2026-09-02")).toBe(1);
      } finally {
        fixture.merges.close();
        fixture.tasks.close();
      }
    }
  );
});

function register(fixture: Awaited<ReturnType<typeof repositoryFixture>>) {
  return fixture.merges.register(fixture.policy, fixture.run, fixture.registered, {
    authorization: fixture.authorization,
    evidenceBundleDigest: fixture.authorizationEvidence.digest
  });
}

function capacity(fixture: Awaited<ReturnType<typeof repositoryFixture>>, day: string) {
  return fixture.merges.countCapacityForUtcDay({
    repositoryId: TEST_MERGE_REPOSITORY_ID,
    at: `${day}T00:00:00.000Z`
  });
}

async function repositoryFixture(
  options: {
    readonly path?: string;
    readonly taskId?: string;
    readonly policy?: Partial<FactoryAutonomousMergePolicy>;
  } = {}
) {
  const root = mkdtempSync(join(tmpdir(), "agentlab-autonomous-merge-repository-"));
  roots.push(root);
  const path = options.path ?? join(root, "factory.sqlite");
  const tasks = new SqliteFactoryRepository(path, { documents });
  const policy = documents.autonomousMergePolicy(testFactoryAutonomousMergePolicy(options.policy));
  const policyBundleDigest = testDigest("5");
  const contract: CanonicalFactoryDocument<ImmutableTaskContract> = documents.taskContract({
    ...testFactoryContract(),
    taskId: options.taskId ?? TEST_FACTORY_TASK_ID,
    createdAt: "2026-09-01T11:00:00.000Z",
    expiresAt: "2026-09-01T13:00:00.000Z",
    repository: { id: TEST_MERGE_REPOSITORY_ID, baseRevision: TEST_MERGE_BASE_REVISION },
    trigger: "scheduled",
    gateProfile: {
      ...testFactoryContract().gateProfile,
      policyDigest: policyBundleDigest
    },
    approvals: {
      ...testFactoryContract().approvals,
      merge: { mode: "automatic" }
    }
  });
  const initial = taskEvent(contract, null, 1, null, "intake", null);
  const initialEvidence = evidenceBundle({
    taskId: contract.value.taskId,
    contractDigest: contract.digest,
    policyBundleDigest,
    sequence: 1,
    previousBundleDigest: null,
    bundleId: randomUUID(),
    subjectDigest: contract.digest,
    mediaType: "application/vnd.agentlab.task-contract.v1+json",
    createdAt: contract.value.createdAt
  });
  await tasks.create(contract, initial, initialEvidence);

  const authorization = documents.autonomousMergeAuthorization(
    testFactoryAutonomousMergeAuthorization({
      authorizationId: randomUUID(),
      taskId: contract.value.taskId,
      contractDigest: contract.digest,
      policyBundleDigest,
      mergePolicyDigest: policy.digest
    })
  );
  const authorizationEvidence = evidenceBundle({
    taskId: contract.value.taskId,
    contractDigest: contract.digest,
    policyBundleDigest,
    sequence: 2,
    previousBundleDigest: initialEvidence.digest,
    bundleId: randomUUID(),
    subjectDigest: authorization.digest,
    mediaType: "application/vnd.agentlab.autonomous-merge-authorization.v1+json",
    createdAt: authorization.value.issuedAt
  });
  await tasks.appendEvidence(authorizationEvidence);
  const taskHistory = await advanceTask(
    { tasks, contract },
    [
      "qualified",
      "specified",
      "planned",
      "queued",
      "executing",
      "verifying",
      "reviewing",
      "pr-proposed",
      "pr-open",
      "merge-ready"
    ],
    authorizationEvidence.digest
  );
  void taskHistory;
  const run = documents.autonomousMergeRun({
    ...testFactoryAutonomousMergeRun({
      policy: policy.value,
      policyDigest: policy.digest,
      authorization: authorization.value,
      authorizationDigest: authorization.digest,
      contractDigest: contract.digest
    }),
    mergeRunId: randomUUID()
  });
  const registered = documents.autonomousMergeEvent({
    schemaVersion: "agentlab.autonomous-merge-event.v1",
    eventId: randomUUID(),
    mergeRunId: run.value.mergeRunId,
    runDigest: run.digest,
    sequence: 1,
    previousEventDigest: null,
    kind: "registered",
    from: null,
    to: "ready",
    actor: mergerActor(),
    occurredAt: run.value.createdAt,
    reasonCode: "merge-run-registered",
    correlationId: run.value.correlationId
  });
  return {
    path,
    tasks,
    merges: new SqliteFactoryAutonomousMergeRepository(path, { documents }),
    policy,
    contract,
    authorization,
    authorizationEvidence,
    run,
    registered
  };
}

async function advanceTask(
  fixture: {
    readonly tasks: SqliteFactoryRepository;
    readonly contract: CanonicalFactoryDocument<ImmutableTaskContract>;
  },
  states: readonly FactoryTaskState[],
  finalEvidenceDigest: Sha256Digest
): Promise<CanonicalFactoryDocument<TaskEvent>> {
  const existing = await fixture.tasks.findById(fixture.contract.value.taskId);
  if (existing === null) throw new Error("Test task is missing.");
  let previous = documents.taskEvent(existing.lastEvent);
  for (const [index, state] of states.entries()) {
    const event = taskEvent(
      fixture.contract,
      previous,
      previous.value.sequence + 1,
      previous.value.to,
      state,
      index === states.length - 1 ? finalEvidenceDigest : null
    );
    await fixture.tasks.append(event);
    previous = event;
  }
  return previous;
}

function taskEvent(
  contract: CanonicalFactoryDocument<ImmutableTaskContract>,
  previous: CanonicalFactoryDocument<TaskEvent> | null,
  sequence: number,
  from: FactoryTaskState | null,
  to: FactoryTaskState,
  evidenceBundleDigest: Sha256Digest | null
): CanonicalFactoryDocument<TaskEvent> {
  return documents.taskEvent({
    schemaVersion: "agentlab.task-event.v1",
    eventId: randomUUID(),
    taskId: contract.value.taskId,
    sequence,
    contractDigest: contract.digest,
    previousEventDigest: previous?.digest ?? null,
    from,
    to,
    actor: testFactoryActor,
    occurredAt: `2026-09-01T11:${String(sequence).padStart(2, "0")}:00.000Z`,
    reasonCode: "test-state-transition",
    summary: null,
    evidenceBundleDigest,
    correlationId: TEST_FACTORY_CORRELATION_ID
  });
}

function evidenceBundle(input: {
  readonly taskId: string;
  readonly contractDigest: Sha256Digest;
  readonly policyBundleDigest: Sha256Digest;
  readonly sequence: number;
  readonly previousBundleDigest: Sha256Digest | null;
  readonly bundleId: string;
  readonly subjectDigest: Sha256Digest;
  readonly mediaType: string;
  readonly createdAt: string;
}): CanonicalFactoryDocument<EvidenceBundle> {
  return documents.evidenceBundle({
    schemaVersion: "agentlab.evidence-bundle.v1",
    bundleId: input.bundleId,
    taskId: input.taskId,
    sequence: input.sequence,
    contractDigest: input.contractDigest,
    previousBundleDigest: input.previousBundleDigest,
    policyBundleDigest: input.policyBundleDigest,
    createdAt: input.createdAt,
    items: [
      {
        id: `59000000-0000-4000-8000-${String(input.sequence).padStart(12, "0")}`,
        kind: input.sequence === 1 ? "contract" : "merge",
        result: "pass",
        subjectDigest: input.subjectDigest,
        artifact: { digest: input.subjectDigest, mediaType: input.mediaType, sizeBytes: 1 },
        producer:
          input.sequence === 3
            ? mergerActor()
            : {
                kind: "control-plane",
                role: "policy-engine",
                id: "agentlab-policy",
                sessionId: null
              },
        createdAt: input.createdAt,
        claims: []
      }
    ],
    attestations: []
  });
}

function mergeEvent(
  run: CanonicalFactoryDocument<FactoryAutonomousMergeRun>,
  previous: CanonicalFactoryDocument<FactoryAutonomousMergeEvent>,
  transition: Readonly<Record<string, unknown>> &
    Pick<FactoryAutonomousMergeEvent, "kind" | "from" | "to">
) {
  const sequence = previous.value.sequence + 1;
  return documents.autonomousMergeEvent({
    schemaVersion: "agentlab.autonomous-merge-event.v1",
    eventId: randomUUID(),
    mergeRunId: run.value.mergeRunId,
    runDigest: run.digest,
    sequence,
    previousEventDigest: previous.digest,
    actor: mergerActor(),
    occurredAt: new Date(Date.parse(previous.value.occurredAt) + 60_000).toISOString(),
    ...transition,
    reasonCode: `test-${transition.kind}`,
    correlationId: run.value.correlationId
  });
}

function mergerActor() {
  return {
    kind: "broker" as const,
    role: "merger" as const,
    id: "github-app/agentlab-merger",
    sessionId: null
  };
}

function query(fixture: Awaited<ReturnType<typeof repositoryFixture>>) {
  return {
    repositoryId: TEST_MERGE_REPOSITORY_ID,
    mergePolicyDigest: fixture.policy.digest,
    limit: 10
  };
}
