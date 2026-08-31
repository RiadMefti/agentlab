import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import { NodeFactoryDocumentCodec } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { SqliteFactoryExecutionRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-execution-repository.js";
import { SqliteFactoryRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-repository.js";
import { latestSchemaVersion } from "../../packages/runtime/src/infrastructure/persistence/migrations.js";
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
const WORKSPACE_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OPERATION_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const actor = {
  kind: "control-plane",
  role: "policy-engine",
  id: "agentlab-execution",
  sessionId: null
} as const;

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("SqliteFactoryExecutionRepository", () => {
  it("persists a canonical hash chain and exposes only recoverable runs", async () => {
    const fixture = await repositoryFixture();
    try {
      const { run, registered } = fixture;
      await expect(fixture.executions.register(run, registered)).resolves.toMatchObject({
        state: "ready",
        sequence: 1
      });
      const attempt = event(run, registered, {
        kind: "attempt-started",
        from: "ready",
        to: "workspace-active",
        attempt: 1,
        workspaceId: WORKSPACE_ID
      });
      await expect(fixture.executions.append(attempt)).resolves.toMatchObject({
        state: "workspace-active",
        sequence: 2
      });
      const operation = event(run, attempt, {
        kind: "operation-started",
        from: "workspace-active",
        to: "operation-active",
        attempt: 1,
        workspaceId: WORKSPACE_ID,
        operationKind: "agent",
        operationId: OPERATION_ID,
        role: "implementer",
        gateId: null,
        requestDigest: testDigest("f")
      });
      await fixture.executions.append(operation);

      await expect(fixture.executions.listRecoverable(10)).resolves.toMatchObject([
        { state: "operation-active", lastEvent: { operationId: OPERATION_ID } }
      ]);
      await expect(fixture.executions.listEvents(TEST_FACTORY_TASK_ID)).resolves.toHaveLength(3);
      await expect(fixture.executions.append(operation)).resolves.toBeNull();
    } finally {
      fixture.executions.close();
    }
  });

  it("rejects forged canonical claims and mismatched operation completion", async () => {
    const fixture = await repositoryFixture();
    try {
      expect(() =>
        fixture.executions.register({ ...fixture.run, json: "{}" }, fixture.registered)
      ).toThrow(/does not match/u);
      await fixture.executions.register(fixture.run, fixture.registered);
      const attempt = event(fixture.run, fixture.registered, {
        kind: "attempt-started",
        from: "ready",
        to: "workspace-active",
        attempt: 1,
        workspaceId: WORKSPACE_ID
      });
      await fixture.executions.append(attempt);
      const operation = event(fixture.run, attempt, {
        kind: "operation-started",
        from: "workspace-active",
        to: "operation-active",
        attempt: 1,
        workspaceId: WORKSPACE_ID,
        operationKind: "gate",
        operationId: OPERATION_ID,
        role: null,
        gateId: "test",
        requestDigest: null
      });
      await fixture.executions.append(operation);
      const mismatch = event(fixture.run, operation, {
        kind: "operation-finished",
        from: "operation-active",
        to: "workspace-active",
        attempt: 1,
        workspaceId: WORKSPACE_ID,
        operationKind: "gate",
        operationId: OPERATION_ID,
        role: null,
        gateId: "build",
        requestDigest: null,
        result: "failed",
        recordDigest: testDigest("9")
      });
      expect(() => fixture.executions.append(mismatch)).toThrow(/exact active process/u);
    } finally {
      fixture.executions.close();
    }
  });

  it("enforces append-only rows and contract-bound attempt limits in SQLite", async () => {
    const fixture = await repositoryFixture();
    try {
      await fixture.executions.register(fixture.run, fixture.registered);
    } finally {
      fixture.executions.close();
    }
    const database = new DatabaseSync(fixture.databasePath);
    try {
      expect(() =>
        database.prepare("UPDATE factory_execution_runs SET maximum_attempts = 20").run()
      ).toThrow(/immutable/u);
      expect(() => database.prepare("DELETE FROM factory_execution_events").run()).toThrow(
        /append-only/u
      );
      expect(() =>
        database
          .prepare(
            `INSERT INTO factory_execution_runs (
              run_id, run_digest, task_id, contract_digest, repository_id, base_revision,
              maximum_attempts, created_at, correlation_id, run_json
            ) SELECT ?, ?, task_id, contract_digest, repository_id, base_revision,
                20, created_at, ?, '{}' FROM factory_task_contracts`
          )
          .run(
            "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            testDigest("8"),
            "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"
          )
      ).toThrow();
    } finally {
      database.close();
    }
  });

  it("migrates a version-6 factory database forward without changing task data", async () => {
    const fixture = await repositoryFixture();
    fixture.executions.close();
    const legacy = new DatabaseSync(fixture.databasePath);
    try {
      legacy.exec(`
        DROP TABLE factory_pull_request_dispatch_events;
        DROP TABLE factory_pull_request_dispatches;
        DROP TABLE factory_execution_events;
        DROP TABLE factory_execution_runs;
        PRAGMA user_version = 6;
      `);
    } finally {
      legacy.close();
    }

    const migrated = new SqliteFactoryExecutionRepository(fixture.databasePath);
    try {
      await expect(migrated.findByTaskId(TEST_FACTORY_TASK_ID)).resolves.toBeNull();
      const database = new DatabaseSync(fixture.databasePath);
      try {
        expect(
          (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version
        ).toBe(latestSchemaVersion);
        expect(
          database
            .prepare(
              "SELECT value AS objective FROM json_each((SELECT contract_json FROM factory_task_contracts), '$') WHERE key = 'objective'"
            )
            .get()
        ).toBeDefined();
      } finally {
        database.close();
      }
    } finally {
      migrated.close();
    }
  });
});

async function repositoryFixture() {
  const root = mkdtempSync(join(tmpdir(), "agentlab-execution-repository-"));
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
  const executions = new SqliteFactoryExecutionRepository(databasePath);
  const run = codec.executionRun({
    schemaVersion: "agentlab.execution-run.v1",
    runId: RUN_ID,
    taskId: contract.value.taskId,
    contractDigest: contract.digest,
    repository: contract.value.repository,
    maximumAttempts: contract.value.budget.maxRepairAttempts + 1,
    createdAt: "2026-08-30T13:00:00.000Z",
    correlationId: TEST_FACTORY_CORRELATION_ID
  });
  const registered = codec.executionEvent({
    ...eventBase(run, null),
    kind: "registered",
    from: null,
    to: "ready"
  });
  return { databasePath, executions, run, registered };
}

function event(
  run: ReturnType<NodeFactoryDocumentCodec["executionRun"]>,
  previous: ReturnType<NodeFactoryDocumentCodec["executionEvent"]>,
  fields: Readonly<Record<string, unknown>>
) {
  return codec.executionEvent({ ...eventBase(run, previous), ...fields });
}

function eventBase(
  run: ReturnType<NodeFactoryDocumentCodec["executionRun"]>,
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
