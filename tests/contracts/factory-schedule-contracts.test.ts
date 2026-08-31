import { describe, expect, it } from "vitest";

import {
  factoryScheduleEventSchema,
  factorySchedulePolicySchema,
  factoryScheduleRunSchema
} from "@agentlab/contracts";

import { testDigest } from "../helpers/factory.js";
import {
  TEST_FACTORY_SCHEDULE_DEADLINE,
  TEST_FACTORY_SCHEDULE_NOW,
  TEST_FACTORY_SCHEDULED_FOR,
  testFactorySchedulePolicy
} from "../helpers/factory-schedule.js";

const runId = "10000000-0000-4000-8000-000000000001";
const correlationId = "20000000-0000-4000-8000-000000000002";

describe("factory schedule contracts", () => {
  it("strictly bounds one daily UTC policy and its aggregate quota", () => {
    const policy = testFactorySchedulePolicy();

    expect(factorySchedulePolicySchema.parse(policy)).toEqual(policy);
    expect(
      factorySchedulePolicySchema.safeParse({ ...policy, id: "agentlab/second-daily-run" }).success
    ).toBe(false);
    expect(
      factorySchedulePolicySchema.safeParse({ ...policy, maximumCandidatesPerTick: 1 }).success
    ).toBe(false);
    expect(
      factorySchedulePolicySchema.safeParse({
        ...policy,
        cadence: { ...policy.cadence, timeZone: "Canada/Eastern" }
      }).success
    ).toBe(false);
    expect(factorySchedulePolicySchema.safeParse({ ...policy, command: "npm test" }).success).toBe(
      false
    );
  });

  it("binds an immutable run to one admitted slot window", () => {
    const run = {
      schemaVersion: "agentlab.schedule-run.v1",
      runId,
      schedulePolicyDigest: testDigest("1"),
      schedulePolicy: testFactorySchedulePolicy(),
      factoryPolicyBundleDigest: testDigest("2"),
      scheduledFor: TEST_FACTORY_SCHEDULED_FOR,
      deadlineAt: TEST_FACTORY_SCHEDULE_DEADLINE,
      createdAt: TEST_FACTORY_SCHEDULE_NOW,
      correlationId
    } as const;

    expect(factoryScheduleRunSchema.parse(run)).toEqual(run);
    expect(
      factoryScheduleRunSchema.safeParse({ ...run, createdAt: "2026-08-31T12:31:00.000Z" }).success
    ).toBe(false);
    expect(
      factoryScheduleRunSchema.safeParse({ ...run, scheduledFor: run.deadlineAt }).success
    ).toBe(false);
  });

  it("requires an initial registration and digest-linked later events", () => {
    const common = {
      schemaVersion: "agentlab.schedule-event.v1",
      runId,
      runDigest: testDigest("3"),
      actor: {
        kind: "control-plane",
        role: "policy-engine",
        id: "agentlab-scheduler",
        sessionId: null
      },
      occurredAt: TEST_FACTORY_SCHEDULE_NOW,
      correlationId
    } as const;
    const registration = {
      ...common,
      eventId: "30000000-0000-4000-8000-000000000003",
      sequence: 1,
      previousEventDigest: null,
      kind: "registered",
      from: null,
      to: "ready",
      reasonCode: "schedule-slot-registered"
    } as const;
    const completion = {
      ...common,
      eventId: "40000000-0000-4000-8000-000000000004",
      sequence: 2,
      previousEventDigest: testDigest("4"),
      kind: "completed",
      from: "ready",
      to: "completed",
      tasksClaimed: 0,
      tasksFinished: 0,
      tasksSkipped: 0,
      reservedUsage: {
        wallClockSeconds: 0,
        agentTurns: 0,
        toolCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        costMicrousd: 0,
        processes: 0,
        outputBytes: 0,
        workers: 0,
        repairAttempts: 0,
        changedFiles: 0,
        changedLines: 0
      },
      reasonCode: "schedule-slot-completed"
    } as const;

    expect(factoryScheduleEventSchema.safeParse(registration).success).toBe(true);
    expect(factoryScheduleEventSchema.safeParse(completion).success).toBe(true);
    expect(
      factoryScheduleEventSchema.safeParse({ ...completion, previousEventDigest: null }).success
    ).toBe(false);
    expect(factoryScheduleEventSchema.safeParse({ ...registration, sequence: 2 }).success).toBe(
      false
    );

    const finished = {
      ...common,
      eventId: "50000000-0000-4000-8000-000000000005",
      sequence: 2,
      previousEventDigest: testDigest("5"),
      kind: "task-finished",
      from: "task-active",
      to: "ready",
      taskId: "60000000-0000-4000-8000-000000000006",
      taskCorrelationId: "70000000-0000-4000-8000-000000000007",
      result: "stopped",
      preparationState: "registered",
      taskState: null,
      contractDigest: null,
      reasonCodes: [],
      reasonCode: "scheduled-task-stopped"
    } as const;
    expect(factoryScheduleEventSchema.safeParse(finished).success).toBe(true);
    expect(factoryScheduleEventSchema.safeParse({ ...finished, result: "failed" }).success).toBe(
      false
    );
    expect(
      factoryScheduleEventSchema.safeParse({ ...finished, preparationState: null }).success
    ).toBe(false);
  });
});
