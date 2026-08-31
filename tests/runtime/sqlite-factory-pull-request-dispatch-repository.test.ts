import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { FactoryTaskState } from "@agentlab/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { NodeFactoryDocumentCodec } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { latestSchemaVersion } from "../../packages/runtime/src/infrastructure/persistence/migrations.js";
import { SqliteFactoryPullRequestDispatchRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-pull-request-dispatch-repository.js";
import { SqliteFactoryRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-repository.js";
import {
  TEST_FACTORY_CORRELATION_ID,
  TEST_FACTORY_TASK_ID,
  testDigest,
  testEvidenceBundle,
  testFactoryContract,
  testTaskEvent
} from "../helpers/factory.js";

const codec = new NodeFactoryDocumentCodec();
const temporaryRoots: string[] = [];
const dispatchId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const brokerActor = {
  kind: "broker",
  role: "pr-broker",
  id: "github-app/test",
  sessionId: null
} as const;

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("SqliteFactoryPullRequestDispatchRepository", () => {
  it("persists the exact five-checkpoint chain and removes completed work from recovery", async () => {
    const fixture = await repositoryFixture();
    try {
      await expect(
        fixture.dispatches.register(fixture.run, fixture.registered)
      ).resolves.toMatchObject({ state: "ready", record: null });
      const started = event(fixture.run, fixture.registered, {
        kind: "dispatch-started",
        from: "ready",
        to: "dispatch-active"
      });
      await fixture.dispatches.append(started);
      const observed = event(fixture.run, started, {
        kind: "remote-observed",
        from: "dispatch-active",
        to: "remote-open",
        record: pullRequestRecord(fixture),
        created: true
      });
      await expect(fixture.dispatches.append(observed)).resolves.toMatchObject({
        state: "remote-open",
        record: { number: 42 }
      });
      await expect(fixture.dispatches.listRecoverable(10)).resolves.toHaveLength(1);
      const evidenced = event(fixture.run, observed, {
        kind: "evidence-recorded",
        from: "remote-open",
        to: "evidence-recorded",
        evidenceBundleDigest: fixture.evidence.digest
      });
      await fixture.dispatches.append(evidenced);
      const taskEvent = await advanceTaskToPullRequestOpen(fixture);
      const completed = event(fixture.run, evidenced, {
        kind: "task-recorded",
        from: "evidence-recorded",
        to: "completed",
        taskEventDigest: taskEvent.digest
      });
      await expect(fixture.dispatches.append(completed)).resolves.toMatchObject({
        state: "completed",
        evidenceBundleDigest: fixture.evidence.digest,
        taskEventDigest: taskEvent.digest
      });
      await expect(fixture.dispatches.listRecoverable(10)).resolves.toEqual([]);
      await expect(fixture.dispatches.listEvents(TEST_FACTORY_TASK_ID)).resolves.toHaveLength(5);
      await expect(fixture.dispatches.append(completed)).resolves.toBeNull();
    } finally {
      fixture.dispatches.close();
      fixture.tasks.close();
    }
  });

  it("rejects forged claims and a remote record from another broker", async () => {
    const fixture = await repositoryFixture();
    try {
      expect(() =>
        fixture.dispatches.register({ ...fixture.run, json: "{}" }, fixture.registered)
      ).toThrow(/not canonical/u);
      await fixture.dispatches.register(fixture.run, fixture.registered);
      const started = event(fixture.run, fixture.registered, {
        kind: "dispatch-started",
        from: "ready",
        to: "dispatch-active"
      });
      await fixture.dispatches.append(started);
      const observed = event(fixture.run, started, {
        kind: "remote-observed",
        from: "dispatch-active",
        to: "remote-open",
        record: { ...pullRequestRecord(fixture), brokerId: "github-app/other" },
        created: true
      });
      expect(() => fixture.dispatches.append(observed)).toThrow(/exact authorized dispatch/u);
    } finally {
      fixture.dispatches.close();
      fixture.tasks.close();
    }
  });

  it("enforces immutable run rows and append-only event rows in SQLite", async () => {
    const fixture = await repositoryFixture();
    try {
      await fixture.dispatches.register(fixture.run, fixture.registered);
    } finally {
      fixture.dispatches.close();
      fixture.tasks.close();
    }
    const database = new DatabaseSync(fixture.databasePath);
    try {
      expect(() =>
        database.prepare("UPDATE factory_pull_request_dispatches SET broker_id = 'forged'").run()
      ).toThrow(/immutable/u);
      expect(() =>
        database.prepare("DELETE FROM factory_pull_request_dispatch_events").run()
      ).toThrow(/append-only/u);
    } finally {
      database.close();
    }
  });

  it("migrates a version-7 database without changing existing task data", async () => {
    const fixture = await repositoryFixture();
    fixture.dispatches.close();
    fixture.tasks.close();
    const legacy = new DatabaseSync(fixture.databasePath);
    try {
      legacy.exec(`
        DROP TABLE factory_canary_cohorts;
        DROP TABLE factory_canary_approvals;
        DROP TABLE factory_eval_assessments;
        DROP TABLE factory_eval_runs;
        DROP TABLE factory_schedule_events;
        DROP TABLE factory_schedule_runs;
        DROP TABLE factory_pull_request_update_events;
        DROP TABLE factory_pull_request_updates;
        DROP TABLE factory_pull_request_repair_events;
        DROP TABLE factory_pull_request_repair_runs;
        DROP TABLE factory_pull_request_dispatch_events;
        DROP TABLE factory_pull_request_dispatches;
        PRAGMA user_version = 7;
      `);
    } finally {
      legacy.close();
    }
    const migrated = new SqliteFactoryPullRequestDispatchRepository(fixture.databasePath);
    try {
      await expect(migrated.findByTaskId(TEST_FACTORY_TASK_ID)).resolves.toBeNull();
      const database = new DatabaseSync(fixture.databasePath);
      try {
        expect(
          (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version
        ).toBe(latestSchemaVersion);
        expect(database.prepare("SELECT task_id FROM factory_task_contracts").get()).toMatchObject({
          task_id: TEST_FACTORY_TASK_ID
        });
      } finally {
        database.close();
      }
    } finally {
      migrated.close();
    }
  });
});

async function repositoryFixture() {
  const root = mkdtempSync(join(tmpdir(), "agentlab-pr-dispatch-repository-"));
  temporaryRoots.push(root);
  const databasePath = join(root, "agentlab.sqlite");
  const tasks = new SqliteFactoryRepository(databasePath);
  const contract = codec.taskContract(testFactoryContract());
  const initial = codec.taskEvent(
    testTaskEvent({
      contractDigest: contract.digest,
      eventId: "33333333-3333-4333-8333-333333333333",
      sequence: 1,
      previousEventDigest: null,
      from: null,
      to: "intake"
    })
  );
  const evidence = codec.evidenceBundle(
    testEvidenceBundle({
      contractDigest: contract.digest,
      bundleId: "66666666-6666-4666-8666-666666666666",
      sequence: 1,
      previousBundleDigest: null
    })
  );
  await tasks.create(contract, initial, evidence);
  const proposal = codec.pullRequestProposal({
    schemaVersion: "agentlab.pull-request-proposal.v1",
    taskId: contract.value.taskId,
    contractDigest: contract.digest,
    patchProposalDigest: testDigest("2"),
    patchArtifactDigest: testDigest("3"),
    changeSet: {
      baseRevision: contract.value.repository.baseRevision,
      headRevision: null,
      changedPaths: ["docs/example.md"],
      binaryPaths: [],
      changedFiles: 1,
      changedLines: 2
    },
    policyEvaluationDigest: testDigest("4"),
    deduplicationKey: contract.value.deduplicationKey,
    repositoryId: contract.value.repository.id,
    baseRevision: contract.value.repository.baseRevision,
    baseBranch: "main",
    branchName: `agentlab/${contract.value.deduplicationKey.slice("sha256:".length)}`,
    title: "docs: durable broker dispatch",
    body: "Exact reviewed proposal.",
    draft: true,
    createdAt: "2026-08-30T13:00:00.000Z"
  });
  const run = codec.pullRequestDispatchRun({
    schemaVersion: "agentlab.pull-request-dispatch.v1",
    dispatchId,
    taskId: contract.value.taskId,
    contractDigest: contract.digest,
    proposalDigest: proposal.digest,
    proposal: proposal.value,
    brokerId: brokerActor.id,
    createdAt: proposal.value.createdAt,
    correlationId: TEST_FACTORY_CORRELATION_ID
  });
  const registered = codec.pullRequestDispatchEvent({
    ...eventBase(run, null),
    kind: "registered",
    from: null,
    to: "ready"
  });
  return {
    databasePath,
    tasks,
    dispatches: new SqliteFactoryPullRequestDispatchRepository(databasePath),
    contract,
    initial,
    evidence,
    run,
    registered
  };
}

function event(
  run: ReturnType<NodeFactoryDocumentCodec["pullRequestDispatchRun"]>,
  previous: ReturnType<NodeFactoryDocumentCodec["pullRequestDispatchEvent"]>,
  fields: Readonly<Record<string, unknown>>
) {
  return codec.pullRequestDispatchEvent({ ...eventBase(run, previous), ...fields });
}

function eventBase(
  run: ReturnType<NodeFactoryDocumentCodec["pullRequestDispatchRun"]>,
  previous: ReturnType<NodeFactoryDocumentCodec["pullRequestDispatchEvent"]> | null
) {
  const sequence = (previous?.value.sequence ?? 0) + 1;
  return {
    schemaVersion: "agentlab.pull-request-dispatch-event.v1" as const,
    eventId: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    dispatchId: run.value.dispatchId,
    dispatchDigest: run.digest,
    taskId: run.value.taskId,
    contractDigest: run.value.contractDigest,
    sequence,
    previousEventDigest: previous?.digest ?? null,
    actor: brokerActor,
    occurredAt: `2026-08-30T13:0${String(sequence - 1)}:00.000Z`,
    reasonCode: "test-dispatch-event",
    summary: null,
    correlationId: TEST_FACTORY_CORRELATION_ID
  };
}

function pullRequestRecord(fixture: Awaited<ReturnType<typeof repositoryFixture>>) {
  const proposal = fixture.run.value.proposal;
  return {
    schemaVersion: "agentlab.pull-request-record.v1" as const,
    taskId: fixture.run.value.taskId,
    contractDigest: fixture.run.value.contractDigest,
    proposalDigest: fixture.run.value.proposalDigest,
    repositoryId: proposal.repositoryId,
    number: 42,
    url: "https://github.com/example/agentlab/pull/42",
    baseRevision: proposal.baseRevision,
    headRevision: "b".repeat(40),
    branchName: proposal.branchName,
    draft: true as const,
    brokerId: brokerActor.id,
    createdAt: "2026-08-30T13:01:00.000Z"
  };
}

async function advanceTaskToPullRequestOpen(
  fixture: Awaited<ReturnType<typeof repositoryFixture>>
) {
  let previous = fixture.initial;
  const states: readonly FactoryTaskState[] = [
    "qualified",
    "specified",
    "planned",
    "queued",
    "executing",
    "verifying",
    "reviewing",
    "pr-proposed",
    "pr-open"
  ];
  for (const [index, state] of states.entries()) {
    const sequence = index + 2;
    const eventDocument = codec.taskEvent({
      schemaVersion: "agentlab.task-event.v1",
      eventId: `99999999-9999-4999-8999-${String(sequence).padStart(12, "0")}`,
      taskId: fixture.contract.value.taskId,
      sequence,
      contractDigest: fixture.contract.digest,
      previousEventDigest: previous.digest,
      from: previous.value.to,
      to: state,
      actor: state === "pr-open" ? brokerActor : previous.value.actor,
      occurredAt: `2026-08-30T12:${String(sequence).padStart(2, "0")}:00.000Z`,
      reasonCode: state === "pr-open" ? "draft-pr-opened" : "stage-complete",
      summary: null,
      evidenceBundleDigest: state === "pr-open" ? fixture.evidence.digest : null,
      correlationId: TEST_FACTORY_CORRELATION_ID
    });
    await fixture.tasks.append(eventDocument);
    previous = eventDocument;
  }
  return previous;
}
