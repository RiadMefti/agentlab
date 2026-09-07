import {
  factoryAutonomousMergeAuthorizationSchema,
  factoryAutonomousMergeEventSchema,
  factoryAutonomousMergePolicySchema,
  factoryAutonomousMergeRecordSchema
} from "@agentlab/contracts";
import { describe, expect, it } from "vitest";

import {
  testFactoryAutonomousMergeAuthorization,
  testFactoryAutonomousMergePolicy
} from "../helpers/factory-autonomous-merge.js";
import { TEST_FACTORY_CORRELATION_ID, testDigest } from "../helpers/factory.js";

describe("factory autonomous merge contracts", () => {
  it("accepts only the fixed R1 scheduled merge-queue authority profile", () => {
    const policy = testFactoryAutonomousMergePolicy();

    expect(factoryAutonomousMergePolicySchema.parse(policy)).toEqual(policy);
    expect(() =>
      factoryAutonomousMergePolicySchema.parse({
        ...policy,
        mergerUserId: policy.prBrokerUserId
      })
    ).toThrow(/distinct POSIX users/u);
    expect(() =>
      factoryAutonomousMergePolicySchema.parse({
        ...policy,
        requiredStatusChecks: [policy.requiredStatusChecks[0], policy.requiredStatusChecks[0]]
      })
    ).toThrow(/verify and factory-sandbox/u);
    expect(
      factoryAutonomousMergePolicySchema.safeParse({ ...policy, directMerge: true }).success
    ).toBe(false);
  });

  it("rejects expired-at-issuance and widened exact-head authorizations", () => {
    const authorization = testFactoryAutonomousMergeAuthorization();

    expect(factoryAutonomousMergeAuthorizationSchema.parse(authorization)).toEqual(authorization);
    expect(() =>
      factoryAutonomousMergeAuthorizationSchema.parse({
        ...authorization,
        expiresAt: authorization.issuedAt
      })
    ).toThrow(/expire after issuance/u);
    expect(
      factoryAutonomousMergeAuthorizationSchema.safeParse({
        ...authorization,
        riskTier: "R2"
      }).success
    ).toBe(false);
  });

  it("requires an append-only predecessor chain and a queue-backed merge record", () => {
    const common = {
      schemaVersion: "agentlab.autonomous-merge-event.v1" as const,
      eventId: "53000000-0000-4000-8000-000000000003",
      mergeRunId: "52000000-0000-4000-8000-000000000002",
      runDigest: testDigest("1"),
      actor: {
        kind: "broker" as const,
        role: "merger" as const,
        id: "github-app/agentlab-merger",
        sessionId: null
      },
      occurredAt: "2026-09-01T12:00:01.000Z",
      reasonCode: "merge-run-registered",
      correlationId: TEST_FACTORY_CORRELATION_ID
    };
    expect(
      factoryAutonomousMergeEventSchema.parse({
        ...common,
        sequence: 1,
        previousEventDigest: null,
        kind: "registered",
        from: null,
        to: "ready"
      }).kind
    ).toBe("registered");
    expect(() =>
      factoryAutonomousMergeEventSchema.parse({
        ...common,
        sequence: 2,
        previousEventDigest: null,
        kind: "ready-intent-recorded",
        from: "ready",
        to: "ready-intent-recorded"
      })
    ).toThrow(/link a predecessor/u);

    const record = {
      schemaVersion: "agentlab.autonomous-merge-record.v1" as const,
      mergeRunId: common.mergeRunId,
      runDigest: common.runDigest,
      authorizationDigest: testDigest("2"),
      taskId: "11111111-1111-4111-8111-111111111111",
      contractDigest: testDigest("3"),
      repositoryId: "riadmefti/agentlab",
      pullRequestNumber: 42,
      pullRequestUrl: "https://github.com/RiadMefti/agentlab/pull/42",
      expectedHeadRevision: "b".repeat(40),
      mergedRevision: "c".repeat(40),
      mergerId: "github-app/agentlab-merger",
      mergeQueueEntryId: "MQE_123",
      mergedAt: "2026-09-01T12:02:00.000Z",
      recordedAt: "2026-09-01T12:01:59.000Z"
    };
    expect(() => factoryAutonomousMergeRecordSchema.parse(record)).toThrow(/cannot precede/u);
  });
});
