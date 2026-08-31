import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { NodeFactoryDocumentCodec } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { latestSchemaVersion } from "../../packages/runtime/src/infrastructure/persistence/migrations.js";
import { SqliteFactoryPullRequestRepairExecutionRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-pull-request-repair-execution-repository.js";
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
const RUN_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AUTHORIZATION_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AUTHORIZATION_DIGEST = testDigest("7");
const WORKSPACE_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const actor = {
  kind: "control-plane",
  role: "policy-engine",
  id: "agentlab-policy",
  sessionId: null
} as const;

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("SqliteFactoryPullRequestRepairExecutionRepository", () => {
  it("persists one immutable authorization-bound repair chain", async () => {
    const fixture = await repositoryFixture();
    try {
      await expect(
        fixture.repairs.register(fixture.run, fixture.registered)
      ).resolves.toMatchObject({ state: "ready", sequence: 1 });
      const attempt = event(fixture.run, fixture.registered, {
        kind: "attempt-started",
        from: "ready",
        to: "workspace-active",
        attempt: 1,
        workspaceId: WORKSPACE_ID
      });
      await expect(fixture.repairs.append(attempt)).resolves.toMatchObject({
        state: "workspace-active",
        run: { authorizationDigest: AUTHORIZATION_DIGEST }
      });
      await expect(
        fixture.repairs.findByAuthorizationDigest(AUTHORIZATION_DIGEST)
      ).resolves.toMatchObject({ state: "workspace-active", sequence: 2 });
      await expect(fixture.repairs.listByTaskId(TEST_FACTORY_TASK_ID)).resolves.toHaveLength(1);
      await expect(fixture.repairs.listRecoverable(10)).resolves.toHaveLength(1);
      await expect(fixture.repairs.listEvents(RUN_ID)).resolves.toHaveLength(2);
      await expect(fixture.repairs.append(attempt)).resolves.toBeNull();
    } finally {
      fixture.repairs.close();
    }
  });

  it("rejects a forged claim and a second run for the same contract repair attempt", async () => {
    const fixture = await repositoryFixture();
    try {
      expect(() =>
        fixture.repairs.register({ ...fixture.run, json: "{}" }, fixture.registered)
      ).toThrow(/does not match/u);
      await fixture.repairs.register(fixture.run, fixture.registered);
      const second = codec.pullRequestRepairRun({
        ...fixture.run.value,
        runId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        authorizationId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        authorizationDigest: testDigest("8")
      });
      const secondRegistered = codec.executionEvent({
        ...eventBase(second, null),
        kind: "registered",
        from: null,
        to: "ready"
      });
      expect(() => fixture.repairs.register(second, secondRegistered)).toThrow();
    } finally {
      fixture.repairs.close();
    }
  });

  it("enforces append-only repair rows and migrates a version-8 database", async () => {
    const fixture = await repositoryFixture();
    await fixture.repairs.register(fixture.run, fixture.registered);
    fixture.repairs.close();
    const database = new DatabaseSync(fixture.databasePath);
    try {
      expect(() =>
        database.prepare("UPDATE factory_pull_request_repair_runs SET maximum_attempts = 2").run()
      ).toThrow(/immutable/u);
      expect(() =>
        database.prepare("DELETE FROM factory_pull_request_repair_events").run()
      ).toThrow(/append-only/u);
      database.exec(`
        DROP TABLE factory_pull_request_update_events;
        DROP TABLE factory_pull_request_updates;
        DROP TABLE factory_pull_request_repair_events;
        DROP TABLE factory_pull_request_repair_runs;
        PRAGMA user_version = 8;
      `);
    } finally {
      database.close();
    }

    const migrated = new SqliteFactoryPullRequestRepairExecutionRepository(fixture.databasePath);
    try {
      await expect(migrated.listByTaskId(TEST_FACTORY_TASK_ID)).resolves.toEqual([]);
      const inspected = new DatabaseSync(fixture.databasePath);
      try {
        expect(
          (inspected.prepare("PRAGMA user_version").get() as { user_version: number }).user_version
        ).toBe(latestSchemaVersion);
      } finally {
        inspected.close();
      }
    } finally {
      migrated.close();
    }
  });
});

async function repositoryFixture() {
  const root = mkdtempSync(join(tmpdir(), "agentlab-pr-repair-repository-"));
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
  tasks.close();
  const repairs = new SqliteFactoryPullRequestRepairExecutionRepository(databasePath);
  const run = codec.pullRequestRepairRun({
    schemaVersion: "agentlab.pull-request-repair-run.v1",
    runId: RUN_ID,
    taskId: contract.value.taskId,
    contractDigest: contract.digest,
    policyBundleDigest: contract.value.gateProfile.policyDigest,
    authorizationId: AUTHORIZATION_ID,
    authorizationDigest: AUTHORIZATION_DIGEST,
    observationDigest: testDigest("6"),
    priorPatchProposalDigest: testDigest("5"),
    repository: contract.value.repository,
    contractRepairAttempt: 1,
    maximumAttempts: 1,
    createdAt: "2026-08-30T13:00:00.000Z",
    correlationId: TEST_FACTORY_CORRELATION_ID
  });
  const registered = codec.executionEvent({
    ...eventBase(run, null),
    kind: "registered",
    from: null,
    to: "ready"
  });
  return { databasePath, repairs, run, registered };
}

function event(
  run: ReturnType<NodeFactoryDocumentCodec["pullRequestRepairRun"]>,
  previous: ReturnType<NodeFactoryDocumentCodec["executionEvent"]>,
  fields: Readonly<Record<string, unknown>>
) {
  return codec.executionEvent({ ...eventBase(run, previous), ...fields });
}

function eventBase(
  run: ReturnType<NodeFactoryDocumentCodec["pullRequestRepairRun"]>,
  previous: ReturnType<NodeFactoryDocumentCodec["executionEvent"]> | null
) {
  const sequence = (previous?.value.sequence ?? 0) + 1;
  return {
    schemaVersion: "agentlab.execution-event.v1" as const,
    eventId: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    runId: run.value.runId,
    runDigest: run.digest,
    taskId: run.value.taskId,
    contractDigest: run.value.contractDigest,
    sequence,
    previousEventDigest: previous?.digest ?? null,
    actor,
    occurredAt: `2026-08-30T13:0${String(sequence - 1)}:00.000Z`,
    reasonCode: "test-event",
    summary: null,
    correlationId: TEST_FACTORY_CORRELATION_ID
  };
}
