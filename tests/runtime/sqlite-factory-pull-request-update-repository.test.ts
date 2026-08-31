import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { NodeFactoryDocumentCodec } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { latestSchemaVersion } from "../../packages/runtime/src/infrastructure/persistence/migrations.js";
import { SqliteFactoryPullRequestDispatchRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-pull-request-dispatch-repository.js";
import { SqliteFactoryPullRequestRepairExecutionRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-pull-request-repair-execution-repository.js";
import { SqliteFactoryPullRequestUpdateRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-pull-request-update-repository.js";
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
const dispatchId = "11111111-1111-4111-8111-111111111112";
const repairRunId = "11111111-1111-4111-8111-111111111113";
const authorizationId = "11111111-1111-4111-8111-111111111114";
const authorizationDigest = testDigest("6");
const updateId = "11111111-1111-4111-8111-111111111115";
const brokerActor = {
  kind: "broker",
  role: "pr-broker",
  id: "github-app/test",
  sessionId: null
} as const;
const policyActor = {
  kind: "control-plane",
  role: "policy-engine",
  id: "agentlab-policy",
  sessionId: null
} as const;

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("SqliteFactoryPullRequestUpdateRepository", () => {
  it("persists the exact five-checkpoint update chain and removes completion from recovery", async () => {
    const fixture = await repositoryFixture();
    try {
      await expect(
        fixture.updates.register(fixture.updateRun, fixture.updateRegistered)
      ).resolves.toMatchObject({ state: "ready", record: null });
      const started = updateEvent(fixture.updateRun, fixture.updateRegistered, {
        kind: "update-started",
        from: "ready",
        to: "update-active"
      });
      await fixture.updates.append(started);
      const remote = updateEvent(fixture.updateRun, started, {
        kind: "remote-updated",
        from: "update-active",
        to: "remote-updated",
        record: updateRecord(fixture),
        updated: true
      });
      await expect(fixture.updates.append(remote)).resolves.toMatchObject({
        state: "remote-updated",
        remoteUpdated: true,
        record: { headRevision: "c".repeat(40) }
      });
      await expect(fixture.updates.listRecoverable(10)).resolves.toHaveLength(1);
      const evidenced = updateEvent(fixture.updateRun, remote, {
        kind: "evidence-recorded",
        from: "remote-updated",
        to: "evidence-recorded",
        evidenceBundleDigest: fixture.evidence.digest
      });
      await fixture.updates.append(evidenced);
      const completed = updateEvent(fixture.updateRun, evidenced, {
        kind: "task-recorded",
        from: "evidence-recorded",
        to: "completed",
        taskEventDigest: fixture.initial.digest
      });
      await expect(fixture.updates.append(completed)).resolves.toMatchObject({
        state: "completed",
        evidenceBundleDigest: fixture.evidence.digest,
        taskEventDigest: fixture.initial.digest
      });
      await expect(
        fixture.updates.findByAuthorizationDigest(authorizationDigest)
      ).resolves.toMatchObject({ state: "completed", runDigest: fixture.updateRun.digest });
      await expect(
        fixture.updates.findByRepairRunDigest(fixture.repairRun.digest)
      ).resolves.toMatchObject({ state: "completed" });
      await expect(fixture.updates.listByTaskId(TEST_FACTORY_TASK_ID)).resolves.toHaveLength(1);
      await expect(fixture.updates.listEvents(updateId)).resolves.toHaveLength(5);
      await expect(fixture.updates.listRecoverable(10)).resolves.toEqual([]);
      await expect(fixture.updates.append(completed)).resolves.toBeNull();
    } finally {
      closeFixture(fixture);
    }
  });

  it("rejects noncanonical claims, missing repair authority, and mutable SQLite rows", async () => {
    const fixture = await repositoryFixture();
    try {
      expect(() =>
        fixture.updates.register({ ...fixture.updateRun, json: "{}" }, fixture.updateRegistered)
      ).toThrow(/not canonical/u);
      const missing = makeUpdateRun(fixture, {
        updateId: "11111111-1111-4111-8111-111111111116",
        repairAuthorizationDigest: testDigest("7"),
        repairRunDigest: testDigest("8"),
        repairedPatchProposalDigest: testDigest("9")
      });
      expect(() => fixture.updates.register(missing.run, missing.registered)).toThrow(
        /contract mismatch/u
      );
      await fixture.updates.register(fixture.updateRun, fixture.updateRegistered);
    } finally {
      closeFixture(fixture);
    }

    const database = new DatabaseSync(fixture.databasePath);
    try {
      expect(() =>
        database.prepare("UPDATE factory_pull_request_updates SET broker_id = 'forged'").run()
      ).toThrow(/immutable/u);
      expect(() =>
        database.prepare("DELETE FROM factory_pull_request_update_events").run()
      ).toThrow(/append-only/u);
    } finally {
      database.close();
    }
  });

  it("migrates a version-9 database without changing existing task data", async () => {
    const fixture = await repositoryFixture();
    closeFixture(fixture);
    const legacy = new DatabaseSync(fixture.databasePath);
    try {
      legacy.exec(`
        DROP TABLE factory_eval_attestations;
        DROP TABLE factory_canary_cohorts;
        DROP TABLE factory_canary_approvals;
        DROP TABLE factory_eval_assessments;
        DROP TABLE factory_eval_runs;
        DROP TABLE factory_schedule_events;
        DROP TABLE factory_schedule_runs;
        DROP TABLE factory_pull_request_update_events;
        DROP TABLE factory_pull_request_updates;
        PRAGMA user_version = 9;
      `);
    } finally {
      legacy.close();
    }
    const migrated = new SqliteFactoryPullRequestUpdateRepository(fixture.databasePath);
    try {
      await expect(migrated.listByTaskId(TEST_FACTORY_TASK_ID)).resolves.toEqual([]);
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
  const root = mkdtempSync(join(tmpdir(), "agentlab-pr-update-repository-"));
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

  const dispatches = new SqliteFactoryPullRequestDispatchRepository(databasePath);
  const pullRequestProposal = codec.pullRequestProposal({
    schemaVersion: "agentlab.pull-request-proposal.v1",
    taskId: contract.value.taskId,
    contractDigest: contract.digest,
    patchProposalDigest: testDigest("1"),
    patchArtifactDigest: testDigest("2"),
    changeSet: {
      baseRevision: contract.value.repository.baseRevision,
      headRevision: null,
      changedPaths: ["docs/example.md"],
      binaryPaths: [],
      changedFiles: 1,
      changedLines: 2
    },
    policyEvaluationDigest: testDigest("3"),
    deduplicationKey: contract.value.deduplicationKey,
    repositoryId: contract.value.repository.id,
    baseRevision: contract.value.repository.baseRevision,
    baseBranch: "main",
    branchName: `agentlab/${contract.value.deduplicationKey.slice("sha256:".length)}`,
    title: "test: durable draft update",
    body: "Exact reviewed proposal.",
    draft: true,
    createdAt: "2026-08-30T12:10:00.000Z"
  });
  const dispatchRun = codec.pullRequestDispatchRun({
    schemaVersion: "agentlab.pull-request-dispatch.v1",
    dispatchId,
    taskId: contract.value.taskId,
    contractDigest: contract.digest,
    proposalDigest: pullRequestProposal.digest,
    proposal: pullRequestProposal.value,
    brokerId: brokerActor.id,
    createdAt: pullRequestProposal.value.createdAt,
    correlationId: TEST_FACTORY_CORRELATION_ID
  });
  const dispatchRegistered = codec.pullRequestDispatchEvent({
    ...dispatchEventBase(dispatchRun, null),
    kind: "registered",
    from: null,
    to: "ready"
  });
  await dispatches.register(dispatchRun, dispatchRegistered);
  const dispatchStarted = codec.pullRequestDispatchEvent({
    ...dispatchEventBase(dispatchRun, dispatchRegistered),
    kind: "dispatch-started",
    from: "ready",
    to: "dispatch-active"
  });
  await dispatches.append(dispatchStarted);
  const initialRecord = pullRequestRecord(dispatchRun);
  const dispatchObserved = codec.pullRequestDispatchEvent({
    ...dispatchEventBase(dispatchRun, dispatchStarted),
    kind: "remote-observed",
    from: "dispatch-active",
    to: "remote-open",
    record: initialRecord,
    created: true
  });
  await dispatches.append(dispatchObserved);

  const repairs = new SqliteFactoryPullRequestRepairExecutionRepository(databasePath);
  const repairRun = codec.pullRequestRepairRun({
    schemaVersion: "agentlab.pull-request-repair-run.v1",
    runId: repairRunId,
    taskId: contract.value.taskId,
    contractDigest: contract.digest,
    policyBundleDigest: contract.value.gateProfile.policyDigest,
    authorizationId,
    authorizationDigest,
    observationDigest: testDigest("4"),
    priorPatchProposalDigest: pullRequestProposal.value.patchProposalDigest,
    repository: contract.value.repository,
    contractRepairAttempt: 1,
    maximumAttempts: 1,
    createdAt: "2026-08-30T13:00:00.000Z",
    correlationId: TEST_FACTORY_CORRELATION_ID
  });
  const repairRegistered = codec.executionEvent({
    ...repairEventBase(repairRun),
    kind: "registered",
    from: null,
    to: "ready"
  });
  await repairs.register(repairRun, repairRegistered);

  const baseFixture = {
    databasePath,
    tasks,
    dispatches,
    repairs,
    contract,
    initial,
    evidence,
    dispatchRun,
    initialRecord,
    repairRun
  };
  const update = makeUpdateRun(baseFixture, { updateId });
  return {
    ...baseFixture,
    updates: new SqliteFactoryPullRequestUpdateRepository(databasePath),
    updateRun: update.run,
    updateRegistered: update.registered
  };
}

function makeUpdateRun(
  fixture: {
    readonly contract: ReturnType<NodeFactoryDocumentCodec["taskContract"]>;
    readonly dispatchRun: ReturnType<NodeFactoryDocumentCodec["pullRequestDispatchRun"]>;
    readonly initialRecord: ReturnType<typeof pullRequestRecord>;
    readonly repairRun: ReturnType<NodeFactoryDocumentCodec["pullRequestRepairRun"]>;
  },
  overrides: {
    readonly updateId: string;
    readonly repairAuthorizationDigest?: string;
    readonly repairRunDigest?: string;
    readonly repairedPatchProposalDigest?: string;
  }
) {
  const proposal = codec.pullRequestUpdateProposal({
    schemaVersion: "agentlab.pull-request-update-proposal.v1",
    taskId: fixture.contract.value.taskId,
    contractDigest: fixture.contract.digest,
    policyBundleDigest: fixture.contract.value.gateProfile.policyDigest,
    initialProposalDigest: fixture.dispatchRun.value.proposalDigest,
    priorPullRequestRecordDigest: codec.pullRequestRecord(fixture.initialRecord).digest,
    repairAuthorizationDigest:
      overrides.repairAuthorizationDigest ?? fixture.repairRun.value.authorizationDigest,
    repairRunDigest: overrides.repairRunDigest ?? fixture.repairRun.digest,
    repairedPatchProposalDigest: overrides.repairedPatchProposalDigest ?? testDigest("a"),
    repairedPatchArtifactDigest: testDigest("b"),
    policyEvaluationDigest: testDigest("c"),
    changeSet: {
      baseRevision: fixture.contract.value.repository.baseRevision,
      headRevision: null,
      changedPaths: ["docs/example.md"],
      binaryPaths: [],
      changedFiles: 1,
      changedLines: 4
    },
    repositoryId: fixture.contract.value.repository.id,
    baseRevision: fixture.contract.value.repository.baseRevision,
    baseBranch: fixture.dispatchRun.value.proposal.baseBranch,
    branchName: fixture.initialRecord.branchName,
    pullRequestNumber: fixture.initialRecord.number,
    priorHeadRevision: fixture.initialRecord.headRevision,
    brokerId: fixture.initialRecord.brokerId,
    contractRepairAttempt: 1,
    commitTitle: "fix: address authorized review feedback",
    createdAt: "2026-08-30T14:00:00.000Z"
  });
  const run = codec.pullRequestUpdateRun({
    schemaVersion: "agentlab.pull-request-update.v1",
    updateId: overrides.updateId,
    taskId: fixture.contract.value.taskId,
    contractDigest: fixture.contract.digest,
    proposalDigest: proposal.digest,
    proposal: proposal.value,
    brokerId: proposal.value.brokerId,
    createdAt: proposal.value.createdAt,
    correlationId: TEST_FACTORY_CORRELATION_ID
  });
  const registered = codec.pullRequestUpdateEvent({
    ...updateEventBase(run, null),
    kind: "registered",
    from: null,
    to: "ready"
  });
  return { run, registered };
}

function dispatchEventBase(
  run: ReturnType<NodeFactoryDocumentCodec["pullRequestDispatchRun"]>,
  previous: ReturnType<NodeFactoryDocumentCodec["pullRequestDispatchEvent"]> | null
) {
  const sequence = (previous?.value.sequence ?? 0) + 1;
  return {
    schemaVersion: "agentlab.pull-request-dispatch-event.v1" as const,
    eventId: `20000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    dispatchId: run.value.dispatchId,
    dispatchDigest: run.digest,
    taskId: run.value.taskId,
    contractDigest: run.value.contractDigest,
    sequence,
    previousEventDigest: previous?.digest ?? null,
    actor: brokerActor,
    occurredAt: `2026-08-30T12:${String(9 + sequence).padStart(2, "0")}:00.000Z`,
    reasonCode: "test-dispatch-event",
    summary: null,
    correlationId: TEST_FACTORY_CORRELATION_ID
  };
}

function repairEventBase(run: ReturnType<NodeFactoryDocumentCodec["pullRequestRepairRun"]>) {
  return {
    schemaVersion: "agentlab.execution-event.v1" as const,
    eventId: "30000000-0000-4000-8000-000000000001",
    runId: run.value.runId,
    runDigest: run.digest,
    taskId: run.value.taskId,
    contractDigest: run.value.contractDigest,
    sequence: 1,
    previousEventDigest: null,
    actor: policyActor,
    occurredAt: run.value.createdAt,
    reasonCode: "test-repair-event",
    summary: null,
    correlationId: TEST_FACTORY_CORRELATION_ID
  };
}

function updateEvent(
  run: ReturnType<NodeFactoryDocumentCodec["pullRequestUpdateRun"]>,
  previous: ReturnType<NodeFactoryDocumentCodec["pullRequestUpdateEvent"]>,
  fields: Readonly<Record<string, unknown>>
) {
  return codec.pullRequestUpdateEvent({ ...updateEventBase(run, previous), ...fields });
}

function updateEventBase(
  run: ReturnType<NodeFactoryDocumentCodec["pullRequestUpdateRun"]>,
  previous: ReturnType<NodeFactoryDocumentCodec["pullRequestUpdateEvent"]> | null
) {
  const sequence = (previous?.value.sequence ?? 0) + 1;
  return {
    schemaVersion: "agentlab.pull-request-update-event.v1" as const,
    eventId: `40000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    updateId: run.value.updateId,
    updateDigest: run.digest,
    taskId: run.value.taskId,
    contractDigest: run.value.contractDigest,
    sequence,
    previousEventDigest: previous?.digest ?? null,
    actor: brokerActor,
    occurredAt: `2026-08-30T14:0${String(sequence - 1)}:00.000Z`,
    reasonCode: "test-update-event",
    summary: null,
    correlationId: TEST_FACTORY_CORRELATION_ID
  };
}

function pullRequestRecord(run: ReturnType<NodeFactoryDocumentCodec["pullRequestDispatchRun"]>) {
  return {
    schemaVersion: "agentlab.pull-request-record.v1" as const,
    taskId: run.value.taskId,
    contractDigest: run.value.contractDigest,
    proposalDigest: run.value.proposalDigest,
    repositoryId: run.value.proposal.repositoryId,
    number: 42,
    url: "https://github.com/example/agentlab/pull/42",
    baseRevision: run.value.proposal.baseRevision,
    headRevision: "b".repeat(40),
    branchName: run.value.proposal.branchName,
    draft: true as const,
    brokerId: run.value.brokerId,
    createdAt: "2026-08-30T12:12:00.000Z"
  };
}

function updateRecord(fixture: Awaited<ReturnType<typeof repositoryFixture>>) {
  const proposal = fixture.updateRun.value.proposal;
  return {
    schemaVersion: "agentlab.pull-request-update-record.v1" as const,
    taskId: proposal.taskId,
    contractDigest: proposal.contractDigest,
    initialProposalDigest: proposal.initialProposalDigest,
    updateProposalDigest: fixture.updateRun.value.proposalDigest,
    priorPullRequestRecordDigest: proposal.priorPullRequestRecordDigest,
    repairAuthorizationDigest: proposal.repairAuthorizationDigest,
    repairRunDigest: proposal.repairRunDigest,
    repairedPatchProposalDigest: proposal.repairedPatchProposalDigest,
    repositoryId: proposal.repositoryId,
    number: proposal.pullRequestNumber,
    url: fixture.initialRecord.url,
    baseRevision: proposal.baseRevision,
    priorHeadRevision: proposal.priorHeadRevision,
    headRevision: "c".repeat(40),
    branchName: proposal.branchName,
    draft: true as const,
    brokerId: proposal.brokerId,
    contractRepairAttempt: proposal.contractRepairAttempt,
    updatedAt: "2026-08-30T14:02:00.000Z"
  };
}

function closeFixture(fixture: Awaited<ReturnType<typeof repositoryFixture>>): void {
  fixture.updates.close();
  fixture.repairs.close();
  fixture.dispatches.close();
  fixture.tasks.close();
}
