import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { describe, expect, it } from "vitest";

import type { FactoryIncidentDisableCommand } from "../../packages/runtime/src/domain/factory-incident-containment-repository.js";
import type { FactoryAuthorityState } from "../../packages/runtime/src/domain/factory-task-repository.js";
import { NodeFactoryDocumentCodec } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { SqliteFactoryIncidentContainmentRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-incident-containment-repository.js";
import { SqliteFactoryRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-factory-repository.js";
import { testFactoryOperationsHealthReport } from "../helpers/factory-operations-health.js";
import { testControlEvent, testDigest } from "../helpers/factory.js";

const documents = new NodeFactoryDocumentCodec();
const containedAt = "2026-08-31T12:00:01.000Z";

describe("SqliteFactoryIncidentContainmentRepository", () => {
  it("atomically records broker-first and scheduler-second disable evidence", async () => {
    const path = enabledDatabase();
    const repository = new SqliteFactoryIncidentContainmentRepository(path, { documents });
    const command = disableCommand({ scheduler: true, prBroker: true });

    const stored = await repository.disableAtomically(command);

    expect(stored).toEqual({
      containment: command.containment.value,
      containmentDigest: command.containment.digest
    });
    await expect(
      repository.findByHealthReportDigest(command.containment.value.healthReportDigest)
    ).resolves.toEqual(stored);
    repository.close();

    const database = new DatabaseSync(path);
    expect(
      database
        .prepare(
          `SELECT control_name FROM factory_control_events
           ORDER BY sequence DESC LIMIT 2`
        )
        .all()
        .map((row) => row.control_name)
        .reverse()
    ).toEqual(["pr-broker", "scheduler"]);
    expect(() =>
      database.prepare("UPDATE factory_incident_containments SET contained_at = contained_at").run()
    ).toThrow(/append-only/u);
    database.close();
  });

  it("rolls back the first disable if the second insert cannot commit", () => {
    const path = enabledDatabase();
    const repository = new SqliteFactoryIncidentContainmentRepository(path, { documents });
    const command = disableCommand(
      { scheduler: true, prBroker: true },
      {
        brokerEventId: "50000000-0000-4000-8000-000000000005",
        schedulerEventId: "50000000-0000-4000-8000-000000000005"
      }
    );

    expect(() => repository.disableAtomically(command)).toThrow(/UNIQUE/u);
    repository.close();

    const database = new DatabaseSync(path);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM factory_control_events").get()
    ).toMatchObject({ count: 2 });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM factory_incident_containments").get()
    ).toMatchObject({ count: 0 });
    database.close();
  });

  it("returns a conflict without writes when observed authority is stale", async () => {
    const path = enabledDatabase();
    const repository = new SqliteFactoryIncidentContainmentRepository(path, { documents });
    const command = disableCommand({ scheduler: false, prBroker: true });

    await expect(repository.disableAtomically(command)).resolves.toBeNull();
    repository.close();

    const database = new DatabaseSync(path);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM factory_control_events").get()
    ).toMatchObject({ count: 2 });
    database.close();
  });

  it("rejects any command that substitutes an enable event", () => {
    const path = enabledDatabase();
    const repository = new SqliteFactoryIncidentContainmentRepository(path, { documents });
    const command = disableCommand({ scheduler: false, prBroker: true });
    const enableEvent = documents.controlEvent({
      ...command.brokerDisableEvent?.value,
      enabled: true,
      actor: { kind: "human", role: "incident-commander", id: "operator", sessionId: null }
    });

    expect(() =>
      repository.disableAtomically({ ...command, brokerDisableEvent: enableEvent })
    ).toThrow(/bound disable event/u);
    repository.close();
  });

  it("rejects journal substitution and direct control-column disagreement", async () => {
    const path = enabledDatabase();
    const repository = new SqliteFactoryIncidentContainmentRepository(path, { documents });
    const command = disableCommand({ scheduler: true, prBroker: true });
    await repository.disableAtomically(command);
    repository.close();

    const database = new DatabaseSync(path);
    database.exec("DROP TRIGGER factory_incident_containments_no_update");
    database
      .prepare("UPDATE factory_incident_containments SET containment_digest = ?")
      .run(testDigest("f"));
    const event = documents.controlEvent({
      schemaVersion: "agentlab.control-event.v1",
      eventId: "70000000-0000-4000-8000-000000000007",
      control: "pr-broker",
      enabled: false,
      actor: {
        kind: "control-plane",
        role: "incident-commander",
        id: "incident-controller",
        sessionId: null
      },
      occurredAt: containedAt,
      reason: "Direct substitution test."
    });
    expect(() =>
      database
        .prepare(
          `INSERT INTO factory_control_events (
            event_id, event_digest, control_name, enabled, event_json, occurred_at, reason
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          event.value.eventId,
          event.digest,
          "scheduler",
          0,
          event.json,
          event.value.occurredAt,
          event.value.reason
        )
    ).toThrow(/identity mismatch/u);
    database.close();

    const inspected = new SqliteFactoryIncidentContainmentRepository(path, { documents });
    expect(() =>
      inspected.findByHealthReportDigest(command.containment.value.healthReportDigest)
    ).toThrow(/immutable validation/u);
    inspected.close();
  });
});

function enabledDatabase(): string {
  const root = mkdtempSync(join(tmpdir(), "agentlab-incident-repository-"));
  const path = join(root, "factory.sqlite");
  const repository = new SqliteFactoryRepository(path, { documents });
  void repository.record(
    documents.controlEvent(
      testControlEvent({
        eventId: "10000000-0000-4000-8000-000000000001",
        control: "scheduler",
        enabled: true
      })
    )
  );
  void repository.record(
    documents.controlEvent(
      testControlEvent({
        eventId: "20000000-0000-4000-8000-000000000002",
        control: "pr-broker",
        enabled: true
      })
    )
  );
  repository.close();
  return path;
}

function disableCommand(
  authority: FactoryAuthorityState,
  ids: {
    readonly brokerEventId?: string;
    readonly schedulerEventId?: string;
  } = {}
): FactoryIncidentDisableCommand {
  const report = documents.operationsHealthReport(
    testFactoryOperationsHealthReport({
      authority: {
        schedulerEnabled: authority.scheduler,
        prBrokerEnabled: authority.prBroker,
        autonomousDraftsEnabled: authority.scheduler && authority.prBroker
      },
      status: "critical",
      incidentRecommended: true,
      reasonCodes: ["overdue-schedule-run"]
    })
  );
  const actor = {
    kind: "control-plane" as const,
    role: "incident-commander" as const,
    id: "incident-controller",
    sessionId: null
  };
  const reason = `Automatic containment for critical health report ${report.digest}: overdue-schedule-run.`;
  const brokerDisableEvent = authority.prBroker
    ? documents.controlEvent({
        schemaVersion: "agentlab.control-event.v1",
        eventId: ids.brokerEventId ?? "30000000-0000-4000-8000-000000000003",
        control: "pr-broker",
        enabled: false,
        actor,
        occurredAt: containedAt,
        reason
      })
    : null;
  const schedulerDisableEvent = authority.scheduler
    ? documents.controlEvent({
        schemaVersion: "agentlab.control-event.v1",
        eventId: ids.schedulerEventId ?? "40000000-0000-4000-8000-000000000004",
        control: "scheduler",
        enabled: false,
        actor,
        occurredAt: containedAt,
        reason
      })
    : null;
  const containment = documents.incidentContainment({
    schemaVersion: "agentlab.incident-containment.v1",
    containmentId: "60000000-0000-4000-8000-000000000006",
    healthReportDigest: report.digest,
    healthReport: report.value,
    authorityBefore: {
      schedulerEnabled: authority.scheduler,
      prBrokerEnabled: authority.prBroker
    },
    brokerDisableEventDigest: brokerDisableEvent?.digest ?? null,
    schedulerDisableEventDigest: schedulerDisableEvent?.digest ?? null,
    actor,
    containedAt
  });
  return {
    expectedAuthority: authority,
    brokerDisableEvent,
    schedulerDisableEvent,
    containment
  };
}
