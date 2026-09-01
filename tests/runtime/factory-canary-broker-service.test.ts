import type { FactoryPolicyDecision } from "@agentlab/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  FactoryCanaryBrokerService,
  type FactoryCanaryBrokerServiceDependencies
} from "../../packages/runtime/src/application/factory-canary-broker-service.js";
import type { FactoryPullRequestOutcome } from "../../packages/runtime/src/application/factory-pull-request-service.js";
import type { FactoryCanaryBrokerQueueItem } from "../../packages/runtime/src/domain/factory-canary-broker-queue.js";
import { NodeFactoryDocumentCodec } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { testFactorySchedulePolicy } from "../helpers/factory-schedule.js";
import { testDigest } from "../helpers/factory.js";

const codec = new NodeFactoryDocumentCodec();
const schedulePolicy = codec.schedulePolicy(testFactorySchedulePolicy());
const factoryPolicyBundleDigest = testDigest("b");
const roleIdentityPolicyDigest = testDigest("a");
const observedAt = "2026-08-31T13:00:00.000Z";

describe("FactoryCanaryBrokerService", () => {
  it("prioritizes recovery coordinates and obeys the existing per-tick task ceiling", async () => {
    const recoverable = queueItem(1, { source: "recoverable" });
    const next = queueItem(2);
    const candidates = [recoverable, next, queueItem(3)];
    const fixture = serviceFixture(candidates, true);

    await expect(fixture.service.tick(command())).resolves.toMatchObject({
      schemaVersion: "agentlab.canary-broker-tick-result.v1",
      status: "completed",
      candidatesInspected: 2,
      dispatchAttempts: 2,
      draftsCompleted: 2,
      hasMore: true,
      reasonCodes: [],
      tasks: [
        { taskId: candidates[0]?.taskId, source: "recoverable", status: "completed" },
        { taskId: candidates[1]?.taskId, source: "undispatched", status: "completed" }
      ]
    });
    expect(fixture.openDraft).toHaveBeenCalledTimes(2);
    expect(fixture.openDraft).toHaveBeenNthCalledWith(1, brokerCommand(recoverable));
    expect(fixture.openDraft).toHaveBeenNthCalledWith(2, brokerCommand(next));
  });

  it("surfaces expired work without letting it prevent a current task", async () => {
    const expired = queueItem(1, { expiresAt: observedAt });
    const current = queueItem(2);
    const fixture = serviceFixture([expired, current]);

    await expect(fixture.service.tick(command())).resolves.toMatchObject({
      status: "attention-required",
      candidatesInspected: 2,
      dispatchAttempts: 1,
      draftsCompleted: 1,
      hasMore: false,
      reasonCodes: ["canary-reservation-expired"],
      tasks: [
        { taskId: expired.taskId, status: "expired", pullRequestNumber: null },
        { taskId: current.taskId, status: "completed", pullRequestNumber: 42 }
      ]
    });
    expect(fixture.openDraft).toHaveBeenCalledOnce();
    expect(fixture.openDraft).toHaveBeenCalledWith(brokerCommand(current));
  });

  it("stops the bounded page after a deterministic denial", async () => {
    const candidates = [queueItem(1), queueItem(2)];
    const fixture = serviceFixture(candidates, true, () =>
      Promise.resolve({
        status: "denied",
        reasonCodes: ["pr-broker-disabled", "pr-broker-disabled"],
        decision: null
      })
    );

    await expect(fixture.service.tick(command())).resolves.toMatchObject({
      status: "attention-required",
      candidatesInspected: 1,
      dispatchAttempts: 1,
      draftsCompleted: 0,
      hasMore: true,
      reasonCodes: ["pr-broker-disabled"],
      tasks: [{ taskId: candidates[0]?.taskId, status: "denied" }]
    });
    expect(fixture.openDraft).toHaveBeenCalledOnce();
  });

  it("rejects command or durable handoff policy substitution before dispatch", async () => {
    const fixture = serviceFixture([queueItem(1)]);

    await expect(
      fixture.service.tick({ ...command(), expectedSchedulePolicyDigest: testDigest("f") })
    ).rejects.toThrow(/schedule policy changed/u);
    expect(fixture.listPending).not.toHaveBeenCalled();

    const drifted = serviceFixture([
      queueItem(1, { handoffRoleIdentityPolicyDigest: testDigest("f") })
    ]);
    await expect(drifted.service.tick(command())).rejects.toThrow(/immutable policy/u);
    expect(drifted.openDraft).not.toHaveBeenCalled();
  });

  it("blocks on clock regression without touching the credentialed writer", async () => {
    const future = queueItem(1, { finishedAt: "2026-08-31T14:00:00.000Z" });
    const fixture = serviceFixture([future]);

    await expect(fixture.service.tick(command())).resolves.toMatchObject({
      status: "attention-required",
      dispatchAttempts: 0,
      reasonCodes: ["canary-broker-clock-regression"],
      tasks: [{ status: "blocked" }]
    });
    expect(fixture.openDraft).not.toHaveBeenCalled();
  });

  it("blocks an empty rate card before reading the queue", async () => {
    const fixture = serviceFixture([queueItem(1)], false);

    await expect(fixture.service.tick(command())).resolves.toMatchObject({
      status: "blocked",
      candidatesInspected: 0,
      dispatchAttempts: 0,
      reasonCodes: ["cost-policy-unconfigured"]
    });
    expect(fixture.listPending).not.toHaveBeenCalled();
    expect(fixture.openDraft).not.toHaveBeenCalled();
  });

  it("reports an idempotent idle reconciliation without remote access", async () => {
    const fixture = serviceFixture([]);

    await expect(fixture.service.tick(command())).resolves.toMatchObject({
      status: "idle",
      candidatesInspected: 0,
      dispatchAttempts: 0,
      draftsCompleted: 0,
      hasMore: false,
      tasks: []
    });
    expect(fixture.openDraft).not.toHaveBeenCalled();
  });
});

function serviceFixture(
  items: readonly FactoryCanaryBrokerQueueItem[],
  costPolicyConfigured = true,
  outcome: (input: unknown) => Promise<FactoryPullRequestOutcome> = (input) =>
    Promise.resolve(openedOutcome(input))
) {
  const listPending = vi.fn(() => Promise.resolve({ items, truncated: false }));
  const openDraft = vi.fn(outcome);
  const dependencies: FactoryCanaryBrokerServiceDependencies = {
    repositoryId: "riadmefti/agentlab",
    schedulePolicy,
    factoryPolicyBundleDigest,
    roleIdentityPolicyDigest,
    costPolicyConfigured,
    queue: { listPending },
    pullRequests: { openDraft },
    now: () => observedAt
  };
  return {
    service: new FactoryCanaryBrokerService(dependencies),
    listPending,
    openDraft
  };
}

function queueItem(
  index: number,
  overrides: Partial<FactoryCanaryBrokerQueueItem> = {}
): FactoryCanaryBrokerQueueItem {
  return {
    taskId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    reservationDigest: testDigest(index.toString(16)),
    schedulePolicyDigest: schedulePolicy.digest,
    factoryPolicyBundleDigest,
    roleIdentityPolicyDigest,
    handoffSchedulePolicyDigest: schedulePolicy.digest,
    handoffFactoryPolicyBundleDigest: factoryPolicyBundleDigest,
    handoffRoleIdentityPolicyDigest: roleIdentityPolicyDigest,
    scheduledFor: "2026-08-31T12:00:00.000Z",
    finishedAt: "2026-08-31T12:10:00.000Z",
    reservedAt: "2026-08-31T11:50:00.000Z",
    expiresAt: "2026-09-01T12:00:00.000Z",
    source: "undispatched",
    ...overrides
  };
}

function command() {
  return {
    expectedSchedulePolicyDigest: schedulePolicy.digest,
    expectedFactoryPolicyBundleDigest: factoryPolicyBundleDigest,
    expectedRoleIdentityPolicyDigest: roleIdentityPolicyDigest
  };
}

function brokerCommand(item: FactoryCanaryBrokerQueueItem) {
  return {
    taskId: item.taskId,
    canary: {
      reservationDigest: item.reservationDigest,
      schedulePolicyDigest: item.schedulePolicyDigest,
      roleIdentityPolicyDigest: item.roleIdentityPolicyDigest
    }
  };
}

function openedOutcome(input: unknown): FactoryPullRequestOutcome {
  const taskId = (input as { taskId: string }).taskId;
  const decision: FactoryPolicyDecision = {
    outcome: "allow",
    effectiveRiskTier: "R1",
    profileId: "r1-standard",
    reasonCodes: [],
    requiredGateIds: [],
    requiredEvidence: [],
    requiredHumanApprovals: 0,
    satisfiedHumanApprovals: 0
  };
  return {
    status: "opened",
    decision,
    record: {
      schemaVersion: "agentlab.pull-request-record.v1",
      taskId,
      contractDigest: testDigest("c"),
      proposalDigest: testDigest("d"),
      repositoryId: "riadmefti/agentlab",
      number: 42,
      url: "https://github.com/riadmefti/agentlab/pull/42",
      baseRevision: "a".repeat(40),
      headRevision: "b".repeat(40),
      branchName: "agentlab/canary",
      draft: true,
      brokerId: "agentlab-pr-broker",
      createdAt: observedAt
    }
  };
}
