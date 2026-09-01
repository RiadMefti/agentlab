import { describe, expect, it, vi } from "vitest";

import {
  FactoryCanaryPullRequestUpdateService,
  type FactoryCanaryPullRequestUpdateServiceDependencies
} from "../../packages/runtime/src/application/factory-canary-pull-request-update-service.js";
import type { FactoryPullRequestUpdateOutcome } from "../../packages/runtime/src/application/factory-pull-request-update-service.js";
import type {
  FactoryCanaryPullRequestUpdateAuthorizationItem,
  FactoryCanaryPullRequestUpdateQueueItem,
  FactoryCanaryPullRequestUpdateRecoveryItem
} from "../../packages/runtime/src/domain/factory-canary-pull-request-update.js";
import type { FactoryTaskSnapshot } from "../../packages/runtime/src/domain/factory-task-repository.js";
import { NodeFactoryDocumentCodec } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { testDigest, testFactoryContract, testTaskEvent } from "../helpers/factory.js";
import { testFactorySchedulePolicy } from "../helpers/factory-schedule.js";

const codec = new NodeFactoryDocumentCodec();
const schedulePolicy = codec.schedulePolicy(testFactorySchedulePolicy());
const factoryPolicyBundleDigest = testFactoryContract().gateProfile.policyDigest;
const roleIdentityPolicyDigest = testDigest("a");
const observedAt = "2026-08-31T13:00:00.000Z";
const repositoryId = "agentlab";
const brokerId = "github-app/test";

describe("FactoryCanaryPullRequestUpdateService", () => {
  it("publishes an exact completed canary repair through the durable update service", async () => {
    const item = authorizedItem(1);
    const fixture = serviceFixture([item]);

    await expect(fixture.service.tick(command())).resolves.toMatchObject({
      schemaVersion: "agentlab.canary-pull-request-update-tick-result.v1",
      status: "completed",
      repositoryId,
      candidatesInspected: 1,
      recoveryAttempts: 0,
      updateAttempts: 1,
      updatesCompleted: 1,
      remoteUpdates: 1,
      hasMore: false,
      tasks: [
        {
          taskId: item.taskId,
          source: "authorized",
          status: "updated",
          authorizationDigest: item.authorizationDigest,
          repairRunDigest: item.repairRunDigest,
          pullRequestNumber: 42,
          priorHeadRevision: item.headRevision,
          headRevision: "c".repeat(40),
          remoteUpdated: true
        }
      ]
    });
    expect(fixture.inspect).toHaveBeenCalledOnce();
    expect(fixture.requireAuthority).toHaveBeenCalledWith(expect.anything(), {
      reservationDigest: item.reservationDigest,
      schedulePolicyDigest: schedulePolicy.digest,
      roleIdentityPolicyDigest
    });
    expect(fixture.update).toHaveBeenCalledWith({
      taskId: item.taskId,
      authorizationDigest: item.authorizationDigest
    });
  });

  it("recovers an existing journal before honoring readiness blockers on fresh publication", async () => {
    const recovery = recoverableItem(1);
    const fresh = authorizedItem(2);
    const fixture = serviceFixture([recovery, fresh], { prBroker: false });

    await expect(fixture.service.tick(command())).resolves.toMatchObject({
      status: "blocked",
      recoveryAttempts: 1,
      updateAttempts: 0,
      updatesCompleted: 1,
      reasonCodes: ["pr-broker-disabled"],
      tasks: [
        { source: "recoverable", status: "recovered" },
        { source: "authorized", status: "blocked", reasonCodes: ["pr-broker-disabled"] }
      ]
    });
    expect(fixture.update).toHaveBeenCalledTimes(1);
    expect(fixture.update).toHaveBeenCalledWith({
      taskId: recovery.taskId,
      authorizationDigest: recovery.authorizationDigest
    });
    expect(fixture.requireAuthority).not.toHaveBeenCalled();
  });

  it("does not inspect GitHub or consume authority for expired fresh work", async () => {
    const item = authorizedItem(1, { expiresAt: observedAt });
    const fixture = serviceFixture([item]);

    await expect(fixture.service.tick(command())).resolves.toMatchObject({
      status: "attention-required",
      updateAttempts: 0,
      reasonCodes: ["canary-reservation-expired"],
      tasks: [{ status: "expired" }]
    });
    expect(fixture.inspect).not.toHaveBeenCalled();
    expect(fixture.requireAuthority).not.toHaveBeenCalled();
    expect(fixture.update).not.toHaveBeenCalled();
  });

  it("fails closed on reviewed policy drift and immutable candidate substitution", async () => {
    const item = authorizedItem(1);
    const fixture = serviceFixture([item]);

    await expect(fixture.service.tick(command(testDigest("f")))).rejects.toThrow(
      /schedule policy changed/u
    );
    const substituted = serviceFixture([{ ...item, repairRunPolicyBundleDigest: testDigest("f") }]);
    await expect(substituted.service.tick(command())).rejects.toThrow(/immutable policy/u);
    expect(substituted.update).not.toHaveBeenCalled();
  });

  it("stops at the schedule action ceiling and reports remaining work", async () => {
    const selectedPolicy = codec.schedulePolicy(
      testFactorySchedulePolicy({ maximumTasksPerTick: 1 })
    );
    const first = authorizedItem(1, {
      schedulePolicyDigest: selectedPolicy.digest,
      handoffSchedulePolicyDigest: selectedPolicy.digest
    });
    const second = authorizedItem(2, {
      schedulePolicyDigest: selectedPolicy.digest,
      handoffSchedulePolicyDigest: selectedPolicy.digest
    });
    const fixture = serviceFixture([first, second], { selectedPolicy });

    await expect(fixture.service.tick(command(selectedPolicy.digest))).resolves.toMatchObject({
      status: "completed",
      candidatesInspected: 1,
      updateAttempts: 1,
      updatesCompleted: 1,
      hasMore: true
    });
    expect(fixture.update).toHaveBeenCalledOnce();
  });
});

function serviceFixture(
  items: readonly FactoryCanaryPullRequestUpdateQueueItem[],
  options: {
    readonly prBroker?: boolean;
    readonly costPolicyConfigured?: boolean;
    readonly selectedPolicy?: typeof schedulePolicy;
    readonly outcome?: FactoryPullRequestUpdateOutcome;
  } = {}
) {
  const selectedPolicy = options.selectedPolicy ?? schedulePolicy;
  const listPending = vi.fn().mockResolvedValue({ items, truncated: false });
  const findById = vi.fn((taskId: string) => Promise.resolve(task(taskId)));
  const state = vi.fn().mockResolvedValue({ scheduler: true, prBroker: options.prBroker ?? true });
  const inspect = vi.fn().mockResolvedValue({
    repositoryId,
    baseBranch: "main",
    baseRevision: "a".repeat(40),
    governance: strongGovernance
  });
  const requireAuthority = vi.fn().mockResolvedValue(testDigest("9"));
  const update = vi.fn(
    (input: { readonly taskId: string; readonly authorizationDigest: string }) => {
      const item = items.find(
        (candidate) =>
          candidate.taskId === input.taskId &&
          candidate.authorizationDigest === input.authorizationDigest
      );
      if (item === undefined) throw new Error("Unexpected PR update.");
      return Promise.resolve(options.outcome ?? updatedOutcome(item));
    }
  );
  const dependencies: FactoryCanaryPullRequestUpdateServiceDependencies = {
    repositoryId,
    brokerId,
    schedulePolicy: selectedPolicy,
    factoryPolicyBundleDigest,
    roleIdentityPolicyDigest,
    costPolicyConfigured: options.costPolicyConfigured ?? true,
    queue: { listPending },
    tasks: { findById },
    controls: { state },
    remote: { inspect },
    canaryAuthority: { require: requireAuthority },
    updates: { update },
    now: () => observedAt
  };
  return {
    service: new FactoryCanaryPullRequestUpdateService(dependencies),
    listPending,
    findById,
    state,
    inspect,
    requireAuthority,
    update
  };
}

function authorizedItem(
  index: number,
  overrides: Partial<FactoryCanaryPullRequestUpdateAuthorizationItem> = {}
): FactoryCanaryPullRequestUpdateAuthorizationItem {
  return {
    source: "authorized",
    taskId: taskId(index),
    repositoryId,
    authorizationDigest: testDigest(index.toString(16)),
    observationDigest: testDigest("6"),
    repairRunDigest: testDigest("d"),
    repairRunPolicyBundleDigest: factoryPolicyBundleDigest,
    contractRepairAttempt: 1,
    repairFinishedAt: "2026-08-31T12:30:00.000Z",
    reservationDigest: testDigest("7"),
    schedulePolicyDigest: schedulePolicy.digest,
    factoryPolicyBundleDigest,
    roleIdentityPolicyDigest,
    handoffSchedulePolicyDigest: schedulePolicy.digest,
    handoffFactoryPolicyBundleDigest: factoryPolicyBundleDigest,
    handoffRoleIdentityPolicyDigest: roleIdentityPolicyDigest,
    scheduledFor: "2026-08-31T12:00:00.000Z",
    handoffFinishedAt: "2026-08-31T12:10:00.000Z",
    reservedAt: "2026-08-31T11:50:00.000Z",
    expiresAt: "2026-09-01T12:00:00.000Z",
    maintenanceSlot: "2026-08-31T12:00:00.000Z",
    observationCreatedAt: "2026-08-31T12:15:00.000Z",
    authorizationCreatedAt: "2026-08-31T12:16:00.000Z",
    pullRequestRecordDigest: testDigest("8"),
    headRevision: "b".repeat(40),
    brokerId,
    ...overrides
  };
}

function recoverableItem(
  index: number,
  overrides: Partial<FactoryCanaryPullRequestUpdateRecoveryItem> = {}
): FactoryCanaryPullRequestUpdateRecoveryItem {
  return {
    source: "recoverable",
    taskId: taskId(index),
    repositoryId,
    authorizationDigest: testDigest(index.toString(16)),
    repairRunDigest: testDigest("d"),
    updateRunDigest: testDigest("e"),
    runPolicyBundleDigest: factoryPolicyBundleDigest,
    brokerId,
    updateState: "update-active",
    taskState: "pr-proposed",
    runCreatedAt: "2026-08-31T12:31:00.000Z",
    lastEventAt: "2026-08-31T12:32:00.000Z",
    ...overrides
  };
}

function updatedOutcome(
  item: FactoryCanaryPullRequestUpdateQueueItem
): Extract<FactoryPullRequestUpdateOutcome, { status: "updated" }> {
  return {
    status: "updated",
    record: {
      schemaVersion: "agentlab.pull-request-update-record.v1",
      taskId: item.taskId,
      contractDigest: testDigest("2"),
      initialProposalDigest: testDigest("3"),
      updateProposalDigest: testDigest("4"),
      priorPullRequestRecordDigest: testDigest("8"),
      repairAuthorizationDigest: item.authorizationDigest,
      repairRunDigest: item.repairRunDigest,
      repairedPatchProposalDigest: testDigest("5"),
      repositoryId: item.repositoryId,
      number: 42,
      url: "https://github.com/example/agentlab/pull/42",
      baseRevision: "a".repeat(40),
      priorHeadRevision: item.source === "authorized" ? item.headRevision : "b".repeat(40),
      headRevision: "c".repeat(40),
      branchName: "agentlab/test",
      draft: true,
      brokerId,
      contractRepairAttempt: 1,
      updatedAt: "2026-08-31T12:35:00.000Z"
    },
    decision: {
      outcome: "allow",
      effectiveRiskTier: "R1",
      profileId: "r1-standard",
      reasonCodes: [],
      requiredGateIds: [],
      requiredEvidence: [],
      requiredHumanApprovals: 0,
      satisfiedHumanApprovals: 0
    },
    remoteUpdated: true
  };
}

function task(id: string): FactoryTaskSnapshot {
  const contract = {
    ...testFactoryContract(),
    taskId: id,
    trigger: "scheduled" as const,
    expiresAt: "2026-09-01T12:00:00.000Z"
  };
  const lastEvent = {
    ...testTaskEvent({
      contractDigest: testDigest("2"),
      eventId: `80000000-0000-4000-8000-${id.slice(-12)}`,
      sequence: 10,
      previousEventDigest: testDigest("9"),
      from: "reviewing",
      to: "pr-proposed"
    }),
    taskId: id,
    reasonCode: "post-pr-independent-review-passed"
  };
  return {
    contract,
    contractDigest: testDigest("2"),
    state: "pr-proposed",
    sequence: 10,
    lastEvent,
    lastEventDigest: testDigest("0")
  };
}

const strongGovernance = {
  requiresPullRequest: true,
  requiredApprovals: 1,
  dismissesStaleReviews: true,
  requiresCodeOwnerReviews: true,
  requiresLastPushApproval: true,
  enforcesAdmins: true,
  allowsForcePushes: false,
  allowsDeletions: false,
  requiredStatusChecks: ["verify", "factory-sandbox"]
} as const;

function taskId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function command(scheduleDigest = schedulePolicy.digest) {
  return {
    expectedSchedulePolicyDigest: scheduleDigest,
    expectedFactoryPolicyBundleDigest: factoryPolicyBundleDigest,
    expectedRoleIdentityPolicyDigest: roleIdentityPolicyDigest
  };
}
