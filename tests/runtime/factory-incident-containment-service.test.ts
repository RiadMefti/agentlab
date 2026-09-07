import { describe, expect, it, vi } from "vitest";

import { FactoryIncidentContainmentService } from "../../packages/runtime/src/application/factory-incident-containment-service.js";
import type {
  FactoryIncidentContainmentSnapshot,
  FactoryIncidentDisableCommand
} from "../../packages/runtime/src/domain/factory-incident-containment-repository.js";
import { NodeFactoryDocumentCodec } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { testFactoryOperationsHealthReport } from "../helpers/factory-operations-health.js";

const documents = new NodeFactoryDocumentCodec();

describe("FactoryIncidentContainmentService", () => {
  it.each(["healthy", "degraded"] as const)(
    "does not mutate authority for %s health",
    async (status) => {
      const report = documents.operationsHealthReport(
        testFactoryOperationsHealthReport({
          status,
          incidentRecommended: false,
          reasonCodes: status === "degraded" ? ["recent-failed-task"] : []
        })
      );
      const disableAtomically = vi.fn();

      await expect(service(report, disableAtomically).containIfCritical()).resolves.toMatchObject({
        status,
        reportDigest: report.digest,
        authorityBefore: { scheduler: false, prBroker: false },
        authorityAfter: { scheduler: false, prBroker: false },
        containment: null
      });
      expect(disableAtomically).not.toHaveBeenCalled();
    }
  );

  it("creates merger-first, PR-broker-second, scheduler-last disable evidence", async () => {
    const report = criticalReport({
      schedulerEnabled: true,
      prBrokerEnabled: true,
      mergeBrokerEnabled: true
    });
    let captured: FactoryIncidentDisableCommand | null = null;
    const disableAtomically = vi.fn((command: FactoryIncidentDisableCommand) => {
      captured = command;
      return Promise.resolve({
        containment: command.containment.value,
        containmentDigest: command.containment.digest
      });
    });

    const result = await service(report, disableAtomically).containIfCritical();

    expect(result).toMatchObject({
      status: "contained",
      authorityBefore: { scheduler: true, prBroker: true, mergeBroker: true },
      authorityAfter: { scheduler: false, prBroker: false, mergeBroker: false }
    });
    expect(captured).not.toBeNull();
    const command = captured as unknown as FactoryIncidentDisableCommand;
    expect(command.mergeBrokerDisableEvent?.value).toMatchObject({
      eventId: "20000000-0000-4000-8000-000000000002",
      control: "merge-broker",
      enabled: false
    });
    expect(command.brokerDisableEvent?.value).toMatchObject({
      eventId: "30000000-0000-4000-8000-000000000003",
      control: "pr-broker",
      enabled: false,
      actor: {
        kind: "control-plane",
        role: "incident-commander",
        id: "incident-controller",
        sessionId: null
      }
    });
    expect(command.schedulerDisableEvent?.value).toMatchObject({
      eventId: "40000000-0000-4000-8000-000000000004",
      control: "scheduler",
      enabled: false
    });
    expect(command.containment.value).toMatchObject({
      containmentId: "50000000-0000-4000-8000-000000000005",
      healthReportDigest: report.digest,
      mergeBrokerDisableEventDigest: command.mergeBrokerDisableEvent?.digest,
      brokerDisableEventDigest: command.brokerDisableEvent?.digest,
      schedulerDisableEventDigest: command.schedulerDisableEvent?.digest
    });
    expect(command.brokerDisableEvent?.value.reason).toContain(report.digest);
  });

  it("reports already-contained critical health without writing another record", async () => {
    const report = criticalReport({ schedulerEnabled: false, prBrokerEnabled: false });
    const disableAtomically = vi.fn();

    await expect(service(report, disableAtomically).containIfCritical()).resolves.toMatchObject({
      status: "already-contained",
      authorityAfter: { scheduler: false, prBroker: false },
      containment: null
    });
    expect(disableAtomically).not.toHaveBeenCalled();
  });

  it("fails closed when authority changes during the atomic compare-and-disable", async () => {
    const report = criticalReport({ schedulerEnabled: true, prBrokerEnabled: false });

    await expect(service(report, () => Promise.resolve(null)).containIfCritical()).rejects.toThrow(
      /authority changed/u
    );
  });
});

function service(
  report: ReturnType<NodeFactoryDocumentCodec["operationsHealthReport"]>,
  disableAtomically: (
    command: FactoryIncidentDisableCommand
  ) => Promise<FactoryIncidentContainmentSnapshot | null>
) {
  const ids = [
    "20000000-0000-4000-8000-000000000002",
    "30000000-0000-4000-8000-000000000003",
    "40000000-0000-4000-8000-000000000004"
  ];
  return new FactoryIncidentContainmentService({
    controllerId: "incident-controller",
    health: { inspect: () => Promise.resolve(report) },
    repository: {
      disableAtomically,
      findByHealthReportDigest: () => Promise.resolve(null)
    },
    documents,
    now: () => "2026-08-31T12:00:01.000Z",
    createId: () => ids.shift() ?? "50000000-0000-4000-8000-000000000005"
  });
}

function criticalReport(authority: {
  readonly schedulerEnabled: boolean;
  readonly prBrokerEnabled: boolean;
  readonly mergeBrokerEnabled?: boolean;
}) {
  return documents.operationsHealthReport(
    testFactoryOperationsHealthReport({
      authority: {
        ...authority,
        mergeBrokerEnabled: authority.mergeBrokerEnabled ?? false,
        autonomousDraftsEnabled: authority.schedulerEnabled && authority.prBrokerEnabled,
        autonomousMergesEnabled:
          authority.schedulerEnabled &&
          authority.prBrokerEnabled &&
          (authority.mergeBrokerEnabled ?? false)
      },
      status: "critical",
      incidentRecommended: true,
      reasonCodes: ["overdue-schedule-run"]
    })
  );
}
