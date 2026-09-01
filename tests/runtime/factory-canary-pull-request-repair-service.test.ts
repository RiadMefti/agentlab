import type { FactoryTaskState } from "@agentlab/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  FactoryCanaryPullRequestRepairService,
  type FactoryCanaryPullRequestRepairServiceDependencies
} from "../../packages/runtime/src/application/factory-canary-pull-request-repair-service.js";
import type { FactoryPullRequestRepairExecutionOutcome } from "../../packages/runtime/src/application/factory-pull-request-repair-execution-service.js";
import type { FactoryPullRequestRepairRecoveryOutcome } from "../../packages/runtime/src/application/factory-pull-request-repair-recovery-service.js";
import type {
  FactoryCanaryPullRequestRepairAuthorizationItem,
  FactoryCanaryPullRequestRepairQueueItem,
  FactoryCanaryPullRequestRepairRecoveryItem
} from "../../packages/runtime/src/domain/factory-canary-pull-request-repair.js";
import type { FactoryTaskSnapshot } from "../../packages/runtime/src/domain/factory-task-repository.js";
import { NodeFactoryDocumentCodec } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { testFactorySchedulePolicy } from "../helpers/factory-schedule.js";
import { testDigest, testFactoryContract, testTaskEvent } from "../helpers/factory.js";

const codec = new NodeFactoryDocumentCodec();
const schedulePolicy = codec.schedulePolicy(testFactorySchedulePolicy());
const factoryPolicyBundleDigest = testFactoryContract().gateProfile.policyDigest;
const roleIdentityPolicyDigest = testDigest("a");
const dailyQuotaPolicyDigest = testDigest("b");
const observedAt = "2026-08-31T13:00:00.000Z";

describe("FactoryCanaryPullRequestRepairService", () => {
  it("consumes exact current canary repair authority through the credentialless worker", async () => {
    const item = authorizedItem(1);
    const fixture = serviceFixture([item]);

    await expect(fixture.service.tick(command())).resolves.toMatchObject({
      schemaVersion: "agentlab.canary-pull-request-repair-tick-result.v1",
      status: "completed",
      candidatesInspected: 1,
      recoveryAttempts: 0,
      repairAttempts: 1,
      repairRunsCreated: 1,
      proposalsCreated: 1,
      hasMore: false,
      tasks: [
        {
          taskId: item.taskId,
          source: "authorized",
          status: "pr-proposed",
          authorizationDigest: item.authorizationDigest,
          patchProposalDigest: testDigest("e")
        }
      ]
    });
    expect(fixture.preflight).toHaveBeenCalledOnce();
    expect(fixture.requireAuthority).toHaveBeenCalledWith(expect.anything(), {
      reservationDigest: item.reservationDigest,
      schedulePolicyDigest: schedulePolicy.digest,
      roleIdentityPolicyDigest
    });
    expect(fixture.execute).toHaveBeenCalledWith({
      taskId: item.taskId,
      authorizationDigest: item.authorizationDigest
    });
  });

  it("recovers interrupted work before honoring blockers on fresh model execution", async () => {
    const recovery = recoverableItem(1);
    const fresh = authorizedItem(2);
    const fixture = serviceFixture([recovery, fresh], {
      preflightReasonCodes: ["scheduler-disabled"]
    });

    await expect(fixture.service.tick(command())).resolves.toMatchObject({
      status: "blocked",
      recoveryAttempts: 1,
      repairAttempts: 0,
      hasMore: false,
      reasonCodes: ["pr-repair-interrupted", "scheduler-disabled"],
      tasks: [
        { source: "recoverable", status: "recovered" },
        { source: "authorized", status: "blocked", reasonCodes: ["scheduler-disabled"] }
      ]
    });
    expect(fixture.recover).toHaveBeenCalledWith({
      taskId: recovery.taskId,
      authorizationDigest: recovery.authorizationDigest,
      correlationId: "90000000-0000-4000-8000-000000000001"
    });
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(fixture.requireAuthority).not.toHaveBeenCalled();
  });

  it("preserves recovery under cost and host blockers even when there is no fresh item", async () => {
    const recovery = recoverableItem(1);
    const fixture = serviceFixture([recovery], {
      preflightReasonCodes: ["cost-policy-unconfigured", "provider-codex-unavailable"]
    });

    await expect(fixture.service.tick(command())).resolves.toMatchObject({
      status: "blocked",
      recoveryAttempts: 1,
      reasonCodes: [
        "cost-policy-unconfigured",
        "pr-repair-interrupted",
        "provider-codex-unavailable"
      ],
      tasks: [{ status: "recovered" }]
    });
    expect(fixture.recover).toHaveBeenCalledOnce();
  });

  it("surfaces expired authority without starting a worker and reports ready idle", async () => {
    const expired = authorizedItem(1, { expiresAt: observedAt });
    const fixture = serviceFixture([expired]);

    await expect(fixture.service.tick(command())).resolves.toMatchObject({
      status: "attention-required",
      repairAttempts: 0,
      tasks: [{ status: "expired", reasonCodes: ["canary-reservation-expired"] }]
    });
    expect(fixture.preflight).not.toHaveBeenCalled();
    expect(fixture.execute).not.toHaveBeenCalled();

    const idle = serviceFixture([]);
    await expect(idle.service.tick(command())).resolves.toMatchObject({
      status: "idle",
      candidatesInspected: 0
    });
    expect(idle.preflight).toHaveBeenCalledOnce();
  });

  it("fails closed on policy drift, aggregate tick exhaustion, and recovery clock regression", async () => {
    const policyDrift = serviceFixture([
      authorizedItem(1, { handoffRoleIdentityPolicyDigest: testDigest("f") })
    ]);
    await expect(policyDrift.service.tick(command())).rejects.toThrow(/immutable policy/u);
    expect(policyDrift.execute).not.toHaveBeenCalled();

    const tinyPolicy = codec.schedulePolicy({
      ...testFactorySchedulePolicy(),
      tickBudget: {
        ...testFactorySchedulePolicy().tickBudget,
        wallClockSeconds: 1
      }
    });
    const exhausted = serviceFixture(
      [
        authorizedItem(1, {
          schedulePolicyDigest: tinyPolicy.digest,
          handoffSchedulePolicyDigest: tinyPolicy.digest
        })
      ],
      { schedulePolicy: tinyPolicy }
    );
    await expect(exhausted.service.tick(command(tinyPolicy.digest))).resolves.toMatchObject({
      status: "blocked",
      repairAttempts: 0,
      reasonCodes: ["canary-pr-repair-tick-budget-exceeded"]
    });
    expect(exhausted.preflight).not.toHaveBeenCalled();

    const regressed = serviceFixture([
      recoverableItem(1, { lastEventAt: "2026-09-01T13:00:00.000Z" })
    ]);
    await expect(regressed.service.tick(command())).resolves.toMatchObject({
      status: "blocked",
      recoveryAttempts: 0,
      tasks: [{ reasonCodes: ["canary-pr-repair-recovery-clock-regression"] }]
    });
    expect(regressed.recover).not.toHaveBeenCalled();
  });

  it("stops after a failed repair and enforces the per-tick action ceiling", async () => {
    const first = authorizedItem(1);
    const second = authorizedItem(2);
    const third = authorizedItem(3);
    const failed = serviceFixture([first, second], {
      execution: executionOutcome(first, "needs-attention")
    });
    await expect(failed.service.tick(command())).resolves.toMatchObject({
      status: "attention-required",
      repairAttempts: 1,
      hasMore: true,
      tasks: [{ status: "needs-attention" }]
    });
    expect(failed.execute).toHaveBeenCalledOnce();

    const bounded = serviceFixture([first, second, third]);
    await expect(bounded.service.tick(command())).resolves.toMatchObject({
      status: "completed",
      repairAttempts: 2,
      hasMore: true,
      tasks: [{ status: "pr-proposed" }, { status: "pr-proposed" }]
    });
    expect(bounded.execute).toHaveBeenCalledTimes(2);
  });
});

interface FixtureOptions {
  readonly preflightReasonCodes?: readonly string[];
  readonly execution?: FactoryPullRequestRepairExecutionOutcome;
  readonly schedulePolicy?: typeof schedulePolicy;
}

function serviceFixture(
  items: readonly FactoryCanaryPullRequestRepairQueueItem[],
  options: FixtureOptions = {}
) {
  const selectedPolicy = options.schedulePolicy ?? schedulePolicy;
  const listPending = vi.fn(() => Promise.resolve({ items, truncated: false }));
  const findById = vi.fn((taskId: string) => Promise.resolve(task(taskId, "pr-open")));
  const requireAuthority = vi.fn(() => Promise.resolve(testDigest("1")));
  const reasonCodes = options.preflightReasonCodes ?? [];
  const preflight = vi.fn(() =>
    Promise.resolve({
      schemaVersion: "agentlab.worker-preflight.v4" as const,
      status: reasonCodes.length === 0 ? ("ready" as const) : ("blocked" as const),
      policyBundleDigest: factoryPolicyBundleDigest,
      schedulePolicyDigest: selectedPolicy.digest,
      roleIdentityPolicyDigest,
      dailyQuotaPolicyDigest,
      schedulerEnabled: !reasonCodes.includes("scheduler-disabled"),
      costPolicyConfigured: !reasonCodes.includes("cost-policy-unconfigured"),
      hostReady: !reasonCodes.some((reason) => reason.includes("unavailable")),
      configuredProviders: ["codex" as const],
      gateIds: ["architecture", "build", "format", "lint", "secret-scan", "test", "typecheck"],
      reasonCodes
    })
  );
  const execute = vi.fn(
    (input: { readonly taskId: string; readonly authorizationDigest: string }) => {
      const item = items.find(
        (candidate) =>
          candidate.taskId === input.taskId &&
          candidate.authorizationDigest === input.authorizationDigest
      );
      if (item?.source !== "authorized") throw new Error("Unexpected repair execution.");
      return Promise.resolve(options.execution ?? executionOutcome(item, "pr-proposed"));
    }
  );
  const recover = vi.fn(
    (input: { readonly taskId: string; readonly authorizationDigest: string }) => {
      const item = items.find(
        (candidate) =>
          candidate.taskId === input.taskId &&
          candidate.authorizationDigest === input.authorizationDigest
      );
      if (item?.source !== "recoverable") throw new Error("Unexpected repair recovery.");
      return Promise.resolve(recoveryOutcome(item));
    }
  );
  const dependencies: FactoryCanaryPullRequestRepairServiceDependencies = {
    schedulePolicy: selectedPolicy,
    factoryPolicyBundleDigest,
    roleIdentityPolicyDigest,
    queue: { listPending },
    tasks: { findById },
    canaryAuthority: { require: requireAuthority },
    worker: {
      preflight,
      executePullRequestRepair: execute,
      recoverPullRequestRepair: recover
    },
    now: () => observedAt,
    createId: () => "90000000-0000-4000-8000-000000000001"
  };
  return {
    service: new FactoryCanaryPullRequestRepairService(dependencies),
    listPending,
    findById,
    requireAuthority,
    preflight,
    execute,
    recover
  };
}

function authorizedItem(
  index: number,
  overrides: Partial<FactoryCanaryPullRequestRepairAuthorizationItem> = {}
): FactoryCanaryPullRequestRepairAuthorizationItem {
  return {
    source: "authorized",
    taskId: taskId(index),
    repositoryId: "agentlab",
    authorizationDigest: testDigest(index.toString(16)),
    observationDigest: testDigest("6"),
    reservationDigest: testDigest("7"),
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
    maintenanceSlot: "2026-08-31T12:00:00.000Z",
    observationCreatedAt: "2026-08-31T12:15:00.000Z",
    authorizationCreatedAt: "2026-08-31T12:16:00.000Z",
    pullRequestRecordDigest: testDigest("8"),
    headRevision: "b".repeat(40),
    ...overrides
  };
}

function recoverableItem(
  index: number,
  overrides: Partial<FactoryCanaryPullRequestRepairRecoveryItem> = {}
): FactoryCanaryPullRequestRepairRecoveryItem {
  return {
    source: "recoverable",
    taskId: taskId(index),
    repositoryId: "agentlab",
    authorizationDigest: testDigest(index.toString(16)),
    repairRunDigest: testDigest("d"),
    runPolicyBundleDigest: factoryPolicyBundleDigest,
    repairState: "operation-active",
    taskState: "repairing",
    runCreatedAt: "2026-08-31T12:17:00.000Z",
    lastEventAt: "2026-08-31T12:18:00.000Z",
    ...overrides
  };
}

function executionOutcome(
  item: FactoryCanaryPullRequestRepairAuthorizationItem,
  status: "pr-proposed" | "needs-attention"
): FactoryPullRequestRepairExecutionOutcome {
  const snapshot = task(item.taskId, status);
  return {
    status,
    task: snapshot,
    authorizationDigest: item.authorizationDigest,
    repairRunDigest: testDigest("d"),
    patch: status === "pr-proposed" ? ({ digest: testDigest("e") } as never) : null,
    reviews: [],
    usage: null,
    usageComplete: true,
    created: true
  };
}

function recoveryOutcome(
  item: FactoryCanaryPullRequestRepairRecoveryItem
): FactoryPullRequestRepairRecoveryOutcome {
  return {
    execution: {
      runDigest: item.repairRunDigest,
      run: { authorizationDigest: item.authorizationDigest },
      state: "abandoned"
    } as FactoryPullRequestRepairRecoveryOutcome["execution"],
    task: task(item.taskId, "needs-attention", "pr-repair-interrupted")
  };
}

function task(
  id: string,
  state: Extract<FactoryTaskState, "pr-open" | "pr-proposed" | "needs-attention">,
  reasonCode = state === "pr-proposed" ? "post-pr-independent-review-passed" : "test-state"
): FactoryTaskSnapshot {
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
      from:
        state === "pr-open" ? "pr-proposed" : state === "pr-proposed" ? "reviewing" : "repairing",
      to: state
    }),
    taskId: id,
    reasonCode
  };
  return {
    contract,
    contractDigest: testDigest("2"),
    state,
    sequence: 10,
    lastEvent,
    lastEventDigest: testDigest("0")
  };
}

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
