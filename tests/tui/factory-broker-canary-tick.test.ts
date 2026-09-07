import type {
  FactoryBrokerPreflight,
  FactoryCanaryBrokerTickReport,
  LocalFactoryBrokerConfig,
  LocalFactoryBrokerRuntime
} from "@agentlab/runtime/factory-broker";
import { describe, expect, it, vi } from "vitest";

import {
  runFactoryBrokerCanaryTick,
  type FactoryBrokerCanaryTickRunnerDependencies
} from "../../apps/tui/src/run-factory-broker-canary-tick.js";
import { NodeFactoryDocumentCodec } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { testFactoryDailyQuotaPolicy } from "../helpers/factory-daily-quota.js";
import { testFactoryRoleIdentityPolicy } from "../helpers/factory-evaluation.js";
import {
  testFactoryScheduleBudget,
  testFactorySchedulePolicy
} from "../helpers/factory-schedule.js";
import { testDigest } from "../helpers/factory.js";

const configPath = "/private/agentlab/broker.json";
const schedulePolicy = testFactorySchedulePolicy();
const dailyQuotaPolicy = testFactoryDailyQuotaPolicy({
  repositories: [
    {
      repositoryId: "riadmefti/agentlab",
      maximumTasksPerDay: 3,
      maximumDraftPullRequestsPerDay: 3,
      budget: testFactoryScheduleBudget()
    }
  ]
});
const roleIdentityPolicy = testFactoryRoleIdentityPolicy({
  keyId: testDigest("8"),
  workerUserId: 1_001,
  attestorUserId: 1_002
});
const codec = new NodeFactoryDocumentCodec();
const schedulePolicyDigest = codec.schedulePolicy(schedulePolicy).digest;
const dailyQuotaPolicyDigest = codec.dailyQuotaPolicy(dailyQuotaPolicy).digest;
const roleIdentityPolicyDigest = codec.roleIdentityPolicy(roleIdentityPolicy).digest;
const policyBundleDigest = testDigest("c");

describe("factory broker canary-tick CLI runner", () => {
  it("rejects malformed pins before loading authority-bearing configuration", async () => {
    const loadConfig = vi.fn(() => Promise.resolve(config()));
    const createRuntime = vi.fn(() =>
      runtime(Promise.resolve(preflight()), Promise.resolve(idle()))
    );

    await expect(
      runFactoryBrokerCanaryTick(
        configPath,
        "sha256:short",
        roleIdentityPolicyDigest,
        policyBundleDigest,
        { loadConfig, createRuntime, write: vi.fn() }
      )
    ).rejects.toThrow(/schedule policy digest is invalid/u);
    expect(loadConfig).not.toHaveBeenCalled();
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it("requires config v4 before constructing the credentialed runtime", async () => {
    const loadConfig = vi.fn(() => Promise.resolve(v1Config()));
    const createRuntime = vi.fn(() =>
      runtime(Promise.resolve(preflight()), Promise.resolve(idle()))
    );

    await expect(
      runFactoryBrokerCanaryTick(
        configPath,
        schedulePolicyDigest,
        roleIdentityPolicyDigest,
        policyBundleDigest,
        { loadConfig, createRuntime, write: vi.fn() }
      )
    ).rejects.toThrow(/config v4/u);
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it("reconciles exact pins, closes before output, and reports bounded progress", async () => {
    const events: string[] = [];
    const tick = vi.fn(() => Promise.resolve(completed()));
    const broker = runtime(
      Promise.resolve(preflight()),
      Promise.resolve(completed()),
      () => {
        events.push("closed");
        return Promise.resolve();
      },
      tick
    );
    const writes: string[] = [];

    await expect(
      runFactoryBrokerCanaryTick(
        configPath,
        schedulePolicyDigest,
        roleIdentityPolicyDigest,
        policyBundleDigest,
        dependencies(broker, (message) => {
          events.push("written");
          writes.push(message);
        })
      )
    ).resolves.toBe(0);

    expect(tick).toHaveBeenCalledWith({
      expectedSchedulePolicyDigest: schedulePolicyDigest,
      expectedRoleIdentityPolicyDigest: roleIdentityPolicyDigest,
      expectedFactoryPolicyBundleDigest: policyBundleDigest
    });
    expect(events).toEqual(["closed", "written"]);
    expect(JSON.parse(writes[0] ?? "")).toMatchObject({
      schemaVersion: "agentlab.broker-canary-tick-command-result.v1",
      status: "completed",
      reasonCodes: [],
      reconciliation: {
        candidatesInspected: 1,
        dispatchAttempts: 1,
        draftsCompleted: 1
      }
    });
  });

  it("does not inspect the queue when broker preflight is blocked", async () => {
    const tick = vi.fn(() => Promise.resolve(idle()));
    const broker = runtime(
      Promise.resolve(preflight("blocked", ["pr-broker-disabled"])),
      Promise.resolve(idle()),
      undefined,
      tick
    );
    const writes: string[] = [];

    await expect(
      runFactoryBrokerCanaryTick(
        configPath,
        schedulePolicyDigest,
        roleIdentityPolicyDigest,
        policyBundleDigest,
        dependencies(broker, (message) => writes.push(message))
      )
    ).resolves.toBe(2);
    expect(tick).not.toHaveBeenCalled();
    expect(JSON.parse(writes[0] ?? "")).toMatchObject({
      status: "blocked",
      reasonCodes: ["pr-broker-disabled"],
      reconciliation: null
    });
  });

  it("returns attention as policy-blocked and rejects a forged report identity", async () => {
    const attentionReport: FactoryCanaryBrokerTickReport = {
      ...idle(),
      status: "attention-required",
      reasonCodes: ["canary-reservation-expired"]
    };
    const writes: string[] = [];
    await expect(
      runFactoryBrokerCanaryTick(
        configPath,
        schedulePolicyDigest,
        roleIdentityPolicyDigest,
        policyBundleDigest,
        dependencies(
          runtime(Promise.resolve(preflight()), Promise.resolve(attentionReport)),
          (message) => writes.push(message)
        )
      )
    ).resolves.toBe(2);
    expect(JSON.parse(writes[0] ?? "")).toMatchObject({
      status: "attention-required",
      reasonCodes: ["canary-reservation-expired"]
    });

    const forged = { ...idle(), repositoryId: "another/repository" };
    const forgedWrites: string[] = [];
    await expect(
      runFactoryBrokerCanaryTick(
        configPath,
        schedulePolicyDigest,
        roleIdentityPolicyDigest,
        policyBundleDigest,
        dependencies(runtime(Promise.resolve(preflight()), Promise.resolve(forged)), (message) =>
          forgedWrites.push(message)
        )
      )
    ).rejects.toThrow(/different reviewed coordinates/u);
    expect(forgedWrites).toEqual([]);
  });
});

function dependencies(
  broker: LocalFactoryBrokerRuntime,
  write: (message: string) => void
): FactoryBrokerCanaryTickRunnerDependencies {
  return {
    loadConfig: () => Promise.resolve(config()),
    createRuntime: () => broker,
    write
  };
}

function runtime(
  preflightResult: Promise<FactoryBrokerPreflight>,
  tickResult: Promise<FactoryCanaryBrokerTickReport>,
  close: () => Promise<void> = () => Promise.resolve(),
  tick: LocalFactoryBrokerRuntime["commands"]["reconcileCanaryDrafts"] = () => tickResult
): LocalFactoryBrokerRuntime {
  return {
    commands: {
      preflight: () => preflightResult,
      openDraft: () => Promise.resolve({ status: "denied", reasonCodes: ["test"], decision: null }),
      reconcileCanaryDrafts: tick,
      maintainCanaryPullRequests: () => Promise.reject(new Error("not used")),
      updateCanaryPullRequests: () => Promise.reject(new Error("not used")),
      observePullRequest: () =>
        Promise.resolve({ status: "denied", reasonCodes: ["pr-broker-disabled"] }),
      admitPullRequestRepair: () => Promise.resolve({ status: "denied", reasonCodes: ["test"] }),
      updatePullRequest: () =>
        Promise.resolve({ status: "denied", reasonCodes: ["test"], decision: null })
    },
    close
  };
}

function preflight(
  status: "ready" | "blocked" = "ready",
  reasonCodes: readonly string[] = []
): FactoryBrokerPreflight {
  return {
    schemaVersion: "agentlab.broker-preflight.v1",
    status,
    repository: {
      repositoryId: "riadmefti/agentlab",
      baseBranch: "main",
      baseRevision: "a".repeat(40),
      governance: {
        requiresPullRequest: true,
        requiredApprovals: 1,
        dismissesStaleReviews: true,
        requiresCodeOwnerReviews: true,
        requiresLastPushApproval: true,
        enforcesAdmins: true,
        allowsForcePushes: false,
        allowsDeletions: false,
        requiredStatusChecks: ["verify", "factory-sandbox"]
      }
    },
    policyBundleDigest,
    authorityEnabled: status === "ready",
    reasonCodes
  };
}

function idle(): FactoryCanaryBrokerTickReport {
  return {
    schemaVersion: "agentlab.canary-broker-tick-result.v1",
    status: "idle",
    repositoryId: "riadmefti/agentlab",
    schedulePolicyDigest,
    factoryPolicyBundleDigest: policyBundleDigest,
    roleIdentityPolicyDigest,
    observedAt: "2026-08-31T13:00:00.000Z",
    candidatesInspected: 0,
    dispatchAttempts: 0,
    draftsCompleted: 0,
    hasMore: false,
    reasonCodes: [],
    tasks: []
  };
}

function completed(): FactoryCanaryBrokerTickReport {
  return {
    ...idle(),
    status: "completed",
    candidatesInspected: 1,
    dispatchAttempts: 1,
    draftsCompleted: 1,
    tasks: [
      {
        taskId: "00000000-0000-4000-8000-000000000001",
        reservationDigest: testDigest("1"),
        source: "undispatched",
        status: "completed",
        reasonCodes: [],
        pullRequestNumber: 42
      }
    ]
  };
}

function config(): LocalFactoryBrokerConfig {
  return {
    ...v1Config(),
    schemaVersion: "agentlab.local-factory-broker.v4",
    costPolicyPath: "/private/agentlab/cost-policy.json",
    schedulePolicyPath: "/private/agentlab/schedule-policy.json",
    dailyQuotaPolicyPath: "/private/agentlab/daily-quota-policy.json",
    expectedDailyQuotaPolicyDigest: dailyQuotaPolicyDigest,
    roleIdentityPolicyPath: "/private/agentlab/role-identities.json",
    expectedRoleIdentityPolicyDigest: roleIdentityPolicyDigest,
    costPolicy: {
      schemaVersion: "agentlab.cost-policy.v1",
      id: "agentlab/test-costs",
      version: "1.0.0",
      rules: []
    },
    schedulePolicy,
    dailyQuotaPolicy,
    roleIdentityPolicy
  };
}

function v1Config(): LocalFactoryBrokerConfig {
  return {
    schemaVersion: "agentlab.local-factory-broker.v1",
    databasePath: "/private/agentlab/agentlab.sqlite",
    artifactRoot: "/private/agentlab/artifacts",
    temporaryRoot: "/private/agentlab/temporary",
    repositoryId: "riadmefti/agentlab",
    repositoryNumericId: 12_345,
    brokerId: "agentlab-pr-broker",
    gitExecutable: "/usr/bin/git",
    githubApp: {
      clientId: "Iv1.agentlab-test",
      installationId: 67_890,
      privateKeyPath: "/private/agentlab/github-app.pem",
      trustedStatusChecks: [
        { context: "verify", appId: 15_368 },
        { context: "factory-sandbox", appId: 15_368 }
      ]
    }
  };
}
