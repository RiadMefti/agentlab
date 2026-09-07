import { factoryIncidentContainmentSchema } from "@agentlab/contracts";
import { describe, expect, it } from "vitest";

import { testFactoryOperationsHealthReport } from "../helpers/factory-operations-health.js";
import { testDigest } from "../helpers/factory.js";

describe("factory incident containment contracts", () => {
  it("accepts a strict critical containment with exact disable evidence", () => {
    const containment = validContainment();

    expect(factoryIncidentContainmentSchema.parse(containment)).toEqual(containment);
  });

  it("rejects noncritical, authority-free, privileged, or incomplete containment", () => {
    const containment = validContainment();
    expect(() =>
      factoryIncidentContainmentSchema.parse({
        ...containment,
        healthReport: testFactoryOperationsHealthReport()
      })
    ).toThrow(/critical health report/u);
    expect(() =>
      factoryIncidentContainmentSchema.parse({
        ...containment,
        authorityBefore: { schedulerEnabled: false, prBrokerEnabled: false },
        brokerDisableEventDigest: null,
        schedulerDisableEventDigest: null
      })
    ).toThrow(/at least one enabled authority/u);
    expect(() =>
      factoryIncidentContainmentSchema.parse({
        ...containment,
        brokerDisableEventDigest: null
      })
    ).toThrow(/exactly match prior broker authority/u);
    expect(() =>
      factoryIncidentContainmentSchema.parse({
        ...containment,
        actor: { ...containment.actor, kind: "human" }
      })
    ).toThrow(/isolated control-plane/u);
  });
});

function validContainment() {
  return {
    schemaVersion: "agentlab.incident-containment.v1" as const,
    containmentId: "20000000-0000-4000-8000-000000000002",
    healthReportDigest: testDigest("a"),
    healthReport: testFactoryOperationsHealthReport({
      authority: {
        schedulerEnabled: true,
        prBrokerEnabled: true,
        autonomousDraftsEnabled: true
      },
      status: "critical",
      incidentRecommended: true,
      reasonCodes: ["overdue-schedule-run"]
    }),
    authorityBefore: { schedulerEnabled: true, prBrokerEnabled: true },
    brokerDisableEventDigest: testDigest("b"),
    schedulerDisableEventDigest: testDigest("c"),
    actor: {
      kind: "control-plane" as const,
      role: "incident-commander" as const,
      id: "incident-controller",
      sessionId: null
    },
    containedAt: "2026-08-31T12:00:01.000Z"
  };
}
