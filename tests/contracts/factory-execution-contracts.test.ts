import { describe, expect, it } from "vitest";

import { factoryExecutionEventSchema, factoryExecutionRunSchema } from "@agentlab/contracts";

import { testDigest } from "../helpers/factory.js";

describe("factory execution contracts", () => {
  it("strictly binds one immutable run to its contract and attempt budget", () => {
    const run = executionRun();
    expect(factoryExecutionRunSchema.parse(run)).toEqual(run);
    expect(factoryExecutionRunSchema.safeParse({ ...run, mutableState: "running" }).success).toBe(
      false
    );
    expect(factoryExecutionRunSchema.safeParse({ ...run, maximumAttempts: 21 }).success).toBe(
      false
    );
  });

  it("requires exact resource coordinates when an interrupted run is abandoned", () => {
    const event = abandonedEvent();
    expect(factoryExecutionEventSchema.parse(event)).toEqual(event);
    expect(factoryExecutionEventSchema.safeParse({ ...event, operationId: null }).success).toBe(
      false
    );
    expect(factoryExecutionEventSchema.safeParse({ ...event, from: "ready" }).success).toBe(false);
  });

  it("makes agent and gate operation identities structurally disjoint", () => {
    const event = operationStartedEvent();
    expect(factoryExecutionEventSchema.parse(event)).toEqual(event);
    expect(
      factoryExecutionEventSchema.safeParse({ ...event, gateId: "test", requestDigest: null })
        .success
    ).toBe(false);
  });
});

function executionRun() {
  return {
    schemaVersion: "agentlab.execution-run.v1" as const,
    runId: "11111111-1111-4111-8111-111111111111",
    taskId: "22222222-2222-4222-8222-222222222222",
    contractDigest: testDigest("a"),
    repository: { id: "agentlab", baseRevision: "b".repeat(40) },
    maximumAttempts: 3,
    createdAt: "2026-08-30T13:00:00.000Z",
    correlationId: "33333333-3333-4333-8333-333333333333"
  };
}

function commonEvent() {
  return {
    schemaVersion: "agentlab.execution-event.v1" as const,
    eventId: "44444444-4444-4444-8444-444444444444",
    runId: executionRun().runId,
    runDigest: testDigest("c"),
    taskId: executionRun().taskId,
    contractDigest: executionRun().contractDigest,
    sequence: 3,
    previousEventDigest: testDigest("d"),
    actor: {
      kind: "control-plane" as const,
      role: "policy-engine" as const,
      id: "agentlab-execution",
      sessionId: null
    },
    occurredAt: "2026-08-30T13:02:00.000Z",
    reasonCode: "test-event",
    summary: null,
    correlationId: executionRun().correlationId
  };
}

function operationStartedEvent() {
  return {
    ...commonEvent(),
    kind: "operation-started" as const,
    from: "workspace-active" as const,
    to: "operation-active" as const,
    attempt: 1,
    workspaceId: "55555555-5555-4555-8555-555555555555",
    operationKind: "agent" as const,
    operationId: "66666666-6666-4666-8666-666666666666",
    role: "implementer" as const,
    gateId: null,
    requestDigest: testDigest("e")
  };
}

function abandonedEvent() {
  return {
    ...commonEvent(),
    kind: "execution-abandoned" as const,
    from: "operation-active" as const,
    to: "abandoned" as const,
    attempt: 1,
    workspaceId: "55555555-5555-4555-8555-555555555555",
    operationId: "66666666-6666-4666-8666-666666666666"
  };
}
