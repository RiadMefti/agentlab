import type {
  FactoryPullRequestObservation,
  FactoryPullRequestRepairAuthorization
} from "@agentlab/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  FactoryCanaryPullRequestMaintenanceService,
  type FactoryCanaryPullRequestMaintenanceServiceDependencies
} from "../../packages/runtime/src/application/factory-canary-pull-request-maintenance-service.js";
import type { FactoryPullRequestObservationOutcome } from "../../packages/runtime/src/application/factory-pull-request-observation-service.js";
import type { FactoryPullRequestRepairAdmissionOutcome } from "../../packages/runtime/src/application/factory-pull-request-repair-admission-service.js";
import type { FactoryCanaryPullRequestMaintenanceQueueItem } from "../../packages/runtime/src/domain/factory-canary-pull-request-maintenance.js";
import type { FactoryTaskSnapshot } from "../../packages/runtime/src/domain/factory-task-repository.js";
import { NodeFactoryDocumentCodec } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { testFactorySchedulePolicy } from "../helpers/factory-schedule.js";
import { testDigest, testFactoryContract, testTaskEvent } from "../helpers/factory.js";

const codec = new NodeFactoryDocumentCodec();
const schedulePolicy = codec.schedulePolicy(testFactorySchedulePolicy());
const factoryPolicyBundleDigest = testFactoryContract().gateProfile.policyDigest;
const roleIdentityPolicyDigest = testDigest("a");
const observedAt = "2026-08-31T13:00:00.000Z";
const maintenanceSlot = "2026-08-31T12:00:00.000Z";

describe("FactoryCanaryPullRequestMaintenanceService", () => {
  it("observes an exact head and durably authorizes deterministic repair", async () => {
    const item = queueItem(1);
    const fixture = serviceFixture([item], {
      observations: [observed(item, "actionable", ["trusted-check-failed"])]
    });

    await expect(fixture.service.tick(command())).resolves.toMatchObject({
      schemaVersion: "agentlab.canary-pull-request-maintenance-tick-result.v1",
      status: "completed",
      maintenanceSlot,
      candidatesInspected: 1,
      maintenanceAttempts: 1,
      observationsCreated: 1,
      repairAuthorizationsCreated: 1,
      hasMore: false,
      tasks: [
        {
          taskId: item.taskId,
          source: "unobserved",
          status: "repair-authorized",
          observationDigest: testDigest("6"),
          repairAuthorizationDigest: testDigest("7")
        }
      ]
    });
    expect(fixture.observe).toHaveBeenCalledWith({
      taskId: item.taskId,
      maintenance: {
        reservationDigest: item.reservationDigest,
        schedulePolicyDigest: schedulePolicy.digest,
        factoryPolicyBundleDigest,
        roleIdentityPolicyDigest,
        scheduledFor: maintenanceSlot
      }
    });
    expect(fixture.requireAuthority).toHaveBeenCalledOnce();
    expect(fixture.admit).toHaveBeenCalledWith({
      taskId: item.taskId,
      observationDigest: testDigest("6")
    });
  });

  it("resumes an actionable observation checkpoint without another remote read", async () => {
    const item = queueItem(1, {
      source: "observed-actionable",
      observationDigest: testDigest("6")
    });
    const fixture = serviceFixture([item]);

    await expect(fixture.service.tick(command())).resolves.toMatchObject({
      status: "completed",
      observationsCreated: 0,
      repairAuthorizationsCreated: 1,
      tasks: [{ source: "observed-actionable", status: "repair-authorized" }]
    });
    expect(fixture.observe).not.toHaveBeenCalled();
    expect(fixture.requireAuthority).toHaveBeenCalledOnce();
  });

  it("records clear and pending heads without inventing repair authority", async () => {
    const clear = queueItem(1);
    const pending = queueItem(2);
    const fixture = serviceFixture([clear, pending], {
      observations: [
        observed(clear, "clear", []),
        observed(pending, "pending", ["trusted-check-pending"])
      ]
    });

    await expect(fixture.service.tick(command())).resolves.toMatchObject({
      status: "completed",
      maintenanceAttempts: 2,
      observationsCreated: 2,
      repairAuthorizationsCreated: 0,
      reasonCodes: ["trusted-check-pending"],
      tasks: [{ status: "clear" }, { status: "pending" }]
    });
    expect(fixture.admit).not.toHaveBeenCalled();
    expect(fixture.requireAuthority).not.toHaveBeenCalled();
  });

  it("stops the page on unsafe remote identity or deterministic denial", async () => {
    const first = queueItem(1);
    const second = queueItem(2);
    const unsafe = serviceFixture([first, second], {
      observations: [observed(first, "unsafe", ["pull-request-head-drift"])]
    });

    await expect(unsafe.service.tick(command())).resolves.toMatchObject({
      status: "attention-required",
      maintenanceAttempts: 1,
      hasMore: true,
      tasks: [{ status: "unsafe" }]
    });
    expect(unsafe.observe).toHaveBeenCalledOnce();
    expect(unsafe.admit).not.toHaveBeenCalled();

    const denied = serviceFixture(
      [
        queueItem(1, {
          source: "observed-actionable",
          observationDigest: testDigest("6")
        }),
        second
      ],
      { admission: deniedAdmission("repair-budget-exhausted") }
    );
    await expect(denied.service.tick(command())).resolves.toMatchObject({
      status: "attention-required",
      hasMore: true,
      tasks: [{ status: "denied", reasonCodes: ["repair-budget-exhausted"] }]
    });
    expect(denied.observe).not.toHaveBeenCalled();
  });

  it("surfaces expired work without spending a maintenance attempt", async () => {
    const expired = queueItem(1, { expiresAt: observedAt });
    const current = queueItem(2);
    const fixture = serviceFixture([expired, current], {
      observations: [observed(current, "clear", [])]
    });

    await expect(fixture.service.tick(command())).resolves.toMatchObject({
      status: "attention-required",
      maintenanceAttempts: 1,
      observationsCreated: 1,
      tasks: [{ status: "expired" }, { status: "clear" }]
    });
    expect(fixture.observe).toHaveBeenCalledOnce();
  });

  it("rejects policy or durable head substitution before remote access", async () => {
    const fixture = serviceFixture([queueItem(1)]);

    await expect(
      fixture.service.tick({ ...command(), expectedSchedulePolicyDigest: testDigest("f") })
    ).rejects.toThrow(/schedule policy changed/u);
    expect(fixture.listPending).not.toHaveBeenCalled();

    const drifted = serviceFixture([
      queueItem(1, { handoffRoleIdentityPolicyDigest: testDigest("f") })
    ]);
    await expect(drifted.service.tick(command())).rejects.toThrow(/immutable identity/u);
    expect(drifted.observe).not.toHaveBeenCalled();

    const wrongHead = serviceFixture([queueItem(1)], {
      observations: [observed(queueItem(1), "clear", [], { recordedHeadRevision: "c".repeat(40) })]
    });
    await expect(wrongHead.service.tick(command())).rejects.toThrow(/different durable PR head/u);
    expect(wrongHead.admit).not.toHaveBeenCalled();
  });

  it("blocks an empty rate card before queue access and reports idempotent idle", async () => {
    const blocked = serviceFixture([queueItem(1)], { costPolicyConfigured: false });
    await expect(blocked.service.tick(command())).resolves.toMatchObject({
      status: "blocked",
      reasonCodes: ["cost-policy-unconfigured"],
      maintenanceAttempts: 0
    });
    expect(blocked.listPending).not.toHaveBeenCalled();

    const idle = serviceFixture([]);
    await expect(idle.service.tick(command())).resolves.toMatchObject({
      status: "idle",
      maintenanceSlot,
      candidatesInspected: 0,
      hasMore: false
    });
    expect(idle.observe).not.toHaveBeenCalled();
  });
});

interface FixtureOptions {
  readonly observations?: readonly FactoryPullRequestObservationOutcome[];
  readonly admission?: FactoryPullRequestRepairAdmissionOutcome;
  readonly costPolicyConfigured?: boolean;
}

function serviceFixture(
  items: readonly FactoryCanaryPullRequestMaintenanceQueueItem[],
  options: FixtureOptions = {}
) {
  const listPending = vi.fn(() => Promise.resolve({ items, truncated: false }));
  const findById = vi.fn(() => Promise.resolve(task()));
  const requireAuthority = vi.fn(() => Promise.resolve(testDigest("1")));
  const observations = [...(options.observations ?? [])];
  const observe = vi.fn(() => {
    const outcome = observations.shift();
    if (outcome === undefined) throw new Error("Unexpected observation call.");
    return Promise.resolve(outcome);
  });
  const admit = vi.fn(() => Promise.resolve(options.admission ?? authorizedAdmission()));
  const dependencies: FactoryCanaryPullRequestMaintenanceServiceDependencies = {
    repositoryId: "agentlab",
    schedulePolicy,
    factoryPolicyBundleDigest,
    roleIdentityPolicyDigest,
    costPolicyConfigured: options.costPolicyConfigured ?? true,
    queue: { listPending },
    tasks: { findById },
    canaryAuthority: { require: requireAuthority },
    observations: { observe },
    repairAdmissions: { admit },
    now: () => observedAt
  };
  return {
    service: new FactoryCanaryPullRequestMaintenanceService(dependencies),
    listPending,
    findById,
    requireAuthority,
    observe,
    admit
  };
}

function queueItem(
  index: number,
  overrides: Partial<FactoryCanaryPullRequestMaintenanceQueueItem> = {}
): FactoryCanaryPullRequestMaintenanceQueueItem {
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
    currentPullRequestRecordDigest: testDigest("3"),
    currentHeadRevision: "b".repeat(40),
    source: "unobserved",
    observationDigest: null,
    ...overrides
  };
}

function observed(
  item: FactoryCanaryPullRequestMaintenanceQueueItem,
  disposition: "clear" | "pending" | "actionable" | "unsafe",
  reasonCodes: readonly string[],
  overrides: Partial<FactoryPullRequestObservation> = {}
): FactoryPullRequestObservationOutcome {
  return {
    status: "observed",
    observation: {
      schemaVersion: "agentlab.pull-request-observation.v1",
      taskId: item.taskId,
      contractDigest: testDigest("2"),
      proposalDigest: testDigest("4"),
      pullRequestRecordDigest: item.currentPullRequestRecordDigest,
      repositoryId: "agentlab",
      pullRequestNumber: 42,
      url: "https://github.com/example/agentlab/pull/42",
      brokerId: "agentlab-pr-broker",
      authorizedBaseRevision: "a".repeat(40),
      recordedHeadRevision: item.currentHeadRevision,
      remoteBaseRevision: "a".repeat(40),
      remoteHeadRevision: item.currentHeadRevision,
      branchName: "agentlab/canary",
      state: "open",
      draft: true,
      merged: false,
      trustedChecks: [
        {
          name: "verify",
          producerId: "github-app/1",
          status: "completed",
          runId: "1",
          conclusion: "success",
          url: null,
          startedAt: observedAt,
          completedAt: observedAt
        }
      ],
      reviews: [],
      reviewComments: [],
      conversationComments: [],
      observedAt,
      ...overrides
    },
    observationDigest: testDigest("6"),
    evidenceBundleDigest: testDigest("5"),
    assessment: { disposition, reasonCodes }
  };
}

function authorizedAdmission(): FactoryPullRequestRepairAdmissionOutcome {
  return {
    status: "authorized",
    authorization: {} as FactoryPullRequestRepairAuthorization,
    authorizationDigest: testDigest("7"),
    evidenceBundleDigest: testDigest("8"),
    created: true
  };
}

function deniedAdmission(reasonCode: string): FactoryPullRequestRepairAdmissionOutcome {
  return { status: "denied", reasonCodes: [reasonCode] };
}

function task(): FactoryTaskSnapshot {
  const contract = { ...testFactoryContract(), trigger: "scheduled" as const };
  const lastEvent = testTaskEvent({
    contractDigest: testDigest("2"),
    eventId: "99999999-9999-4999-8999-999999999999",
    sequence: 10,
    previousEventDigest: testDigest("9"),
    from: "pr-proposed",
    to: "pr-open"
  });
  return {
    contract,
    contractDigest: testDigest("2"),
    state: "pr-open",
    sequence: 10,
    lastEvent,
    lastEventDigest: testDigest("0")
  };
}

function command() {
  return {
    expectedSchedulePolicyDigest: schedulePolicy.digest,
    expectedFactoryPolicyBundleDigest: factoryPolicyBundleDigest,
    expectedRoleIdentityPolicyDigest: roleIdentityPolicyDigest
  };
}
