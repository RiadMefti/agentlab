import { chmodSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import { NodeFactoryDocumentCodec } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { migrate } from "../../packages/runtime/src/infrastructure/persistence/migrations.js";
import { SqliteFactoryOperationsHealthSource } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-operations-health-source.js";
import { SqliteFactoryRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-repository.js";
import { SqliteFactoryScheduleRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-schedule-repository.js";
import { testFactoryDailyQuotaPolicy } from "../helpers/factory-daily-quota.js";
import { testFactorySchedulePolicy } from "../helpers/factory-schedule.js";
import {
  TEST_FACTORY_CORRELATION_ID,
  testControlEvent,
  testDigest,
  testEvidenceBundle,
  testFactoryContract,
  testTaskEvent
} from "../helpers/factory.js";

const documents = new NodeFactoryDocumentCodec();

describe("SqliteFactoryOperationsHealthSource", () => {
  it("reads validated authority, schedule, and task projections without a writer composition", async () => {
    const path = databaseFixture();
    const source = new SqliteFactoryOperationsHealthSource(path, { documents });

    await expect(source.observe(query())).resolves.toMatchObject({
      authority: { scheduler: true, prBroker: false },
      schedules: [{ state: "ready", run: { schemaVersion: "agentlab.schedule-run.v1" } }],
      tasks: [{ state: "intake", contract: { trigger: "scheduled" } }],
      dailyQuotaReservations: [],
      truncatedSections: []
    });
    source.close();
  });

  it("rejects materialized-column substitution instead of trusting aggregate SQL", () => {
    const path = databaseFixture();
    const database = new DatabaseSync(path);
    database.exec("DROP TRIGGER factory_task_contracts_no_update");
    database.prepare("UPDATE factory_task_contracts SET contract_digest = ?").run(testDigest("f"));
    database.close();
    const source = new SqliteFactoryOperationsHealthSource(path, { documents });

    expect(() => source.observe(query())).toThrow(/invalid task projection/u);
    source.close();
  });

  it("fails closed on an older ledger or a missing durable database", () => {
    const root = mkdtempSync(join(tmpdir(), "agentlab-health-schema-"));
    const path = join(root, "factory.sqlite");
    const database = new DatabaseSync(path);
    migrate(database);
    database.exec("PRAGMA user_version = 26");
    database.close();
    chmodSync(path, 0o600);

    expect(() => new SqliteFactoryOperationsHealthSource(path)).toThrow(/schema 27/u);
    expect(() => new SqliteFactoryOperationsHealthSource(join(root, "missing.sqlite"))).toThrow();
  });
});

function databaseFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "agentlab-health-source-"));
  const path = join(root, "factory.sqlite");
  const repository = new SqliteFactoryRepository(path, { documents });
  const contract = documents.taskContract({ ...testFactoryContract(), trigger: "scheduled" });
  const event = documents.taskEvent(
    testTaskEvent({
      contractDigest: contract.digest,
      eventId: "10000000-0000-4000-8000-000000000001",
      sequence: 1,
      previousEventDigest: null,
      from: null,
      to: "intake"
    })
  );
  const evidence = documents.evidenceBundle(
    testEvidenceBundle({
      contractDigest: contract.digest,
      bundleId: "20000000-0000-4000-8000-000000000002",
      sequence: 1,
      previousBundleDigest: null
    })
  );
  void repository.create(contract, event, evidence);
  void repository.record(
    documents.controlEvent(
      testControlEvent({
        eventId: "30000000-0000-4000-8000-000000000003",
        control: "scheduler",
        enabled: true
      })
    )
  );
  repository.close();

  const schedules = new SqliteFactoryScheduleRepository(path, { documents });
  const schedulePolicy = documents.schedulePolicy(testFactorySchedulePolicy());
  const run = documents.scheduleRun({
    schemaVersion: "agentlab.schedule-run.v1",
    runId: "40000000-0000-4000-8000-000000000004",
    schedulePolicyDigest: schedulePolicy.digest,
    schedulePolicy: schedulePolicy.value,
    factoryPolicyBundleDigest: testDigest("4"),
    scheduledFor: "2026-08-31T12:00:00.000Z",
    deadlineAt: "2026-08-31T12:30:00.000Z",
    createdAt: "2026-08-31T12:01:00.000Z",
    correlationId: TEST_FACTORY_CORRELATION_ID
  });
  const registered = documents.scheduleEvent({
    schemaVersion: "agentlab.schedule-event.v1",
    eventId: "50000000-0000-4000-8000-000000000005",
    runId: run.value.runId,
    runDigest: run.digest,
    sequence: 1,
    previousEventDigest: null,
    kind: "registered",
    from: null,
    to: "ready",
    actor: {
      kind: "control-plane",
      role: "policy-engine",
      id: "agentlab-scheduler",
      sessionId: null
    },
    occurredAt: run.value.createdAt,
    reasonCode: "schedule-run-registered",
    correlationId: run.value.correlationId
  });
  void schedules.register(run, registered);
  schedules.close();
  chmodSync(path, 0o600);
  return path;
}

function query() {
  const dailyQuotaPolicy = testFactoryDailyQuotaPolicy();
  return {
    lookbackStartedAt: "2026-08-30T13:00:00.000Z",
    observedAt: "2026-08-31T13:00:00.000Z",
    quotaWindowStart: "2026-08-31T00:00:00.000Z",
    organizationId: dailyQuotaPolicy.organizationId,
    repositoryIds: dailyQuotaPolicy.repositories.map(({ repositoryId }) => repositoryId),
    maximumRecordsPerSection: 100
  };
}
