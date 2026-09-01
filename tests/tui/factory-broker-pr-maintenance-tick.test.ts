import type {
  FactoryBrokerPreflight,
  FactoryCanaryPullRequestMaintenanceTickReport,
  LocalFactoryBrokerConfig,
  LocalFactoryBrokerRuntime
} from "@agentlab/runtime/factory-broker";
import { describe, expect, it, vi } from "vitest";

import {
  runFactoryBrokerPullRequestMaintenanceTick,
  type FactoryBrokerPullRequestMaintenanceTickRunnerDependencies
} from "../../apps/tui/src/run-factory-broker-pr-maintenance-tick.js";
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

describe("factory broker PR-maintenance tick CLI runner", () => {
  it("rejects malformed pins before loading credential-bearing configuration", async () => {
    const loadConfig = vi.fn(() => Promise.resolve(config()));
    const createRuntime = vi.fn(() => runtime(Promise.resolve(preflight()), idle()));

    await expect(
      runFactoryBrokerPullRequestMaintenanceTick(
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

  it("requires config v4 before constructing the broker runtime", async () => {
    const loadConfig = vi.fn(() => Promise.resolve(v1Config()));
    const createRuntime = vi.fn(() => runtime(Promise.resolve(preflight()), idle()));

    await expect(
      runFactoryBrokerPullRequestMaintenanceTick(
        configPath,
        schedulePolicyDigest,
        roleIdentityPolicyDigest,
        policyBundleDigest,
        { loadConfig, createRuntime, write: vi.fn() }
      )
    ).rejects.toThrow(/config v4/u);
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it("runs exact maintenance, closes before output, and reports bounded progress", async () => {
    const events: string[] = [];
    const maintain = vi.fn(() => Promise.resolve(completed()));
    const broker = runtime(Promise.resolve(preflight()), completed(), {
      maintain,
      close: () => {
        events.push("closed");
        return Promise.resolve();
      }
    });
    const writes: string[] = [];

    await expect(
      runFactoryBrokerPullRequestMaintenanceTick(
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

    expect(maintain).toHaveBeenCalledWith({
      expectedSchedulePolicyDigest: schedulePolicyDigest,
      expectedRoleIdentityPolicyDigest: roleIdentityPolicyDigest,
      expectedFactoryPolicyBundleDigest: policyBundleDigest
    });
    expect(events).toEqual(["closed", "written"]);
    expect(JSON.parse(writes[0] ?? "")).toMatchObject({
      schemaVersion: "agentlab.broker-pr-maintenance-tick-command-result.v1",
      status: "completed",
      reasonCodes: [],
      maintenance: {
        candidatesInspected: 1,
        maintenanceAttempts: 1,
        observationsCreated: 1,
        repairAuthorizationsCreated: 1
      }
    });
  });

  it("does not inspect maintenance work when broker preflight is blocked", async () => {
    const maintain = vi.fn(() => Promise.resolve(idle()));
    const broker = runtime(Promise.resolve(preflight("blocked", ["pr-broker-disabled"])), idle(), {
      maintain
    });
    const writes: string[] = [];

    await expect(
      runFactoryBrokerPullRequestMaintenanceTick(
        configPath,
        schedulePolicyDigest,
        roleIdentityPolicyDigest,
        policyBundleDigest,
        dependencies(broker, (message) => writes.push(message))
      )
    ).resolves.toBe(2);
    expect(maintain).not.toHaveBeenCalled();
    expect(JSON.parse(writes[0] ?? "")).toMatchObject({
      status: "blocked",
      reasonCodes: ["pr-broker-disabled"],
      maintenance: null
    });
  });

  it("returns attention as blocked and rejects a forged report identity", async () => {
    const attention: FactoryCanaryPullRequestMaintenanceTickReport = {
      ...idle(),
      status: "attention-required",
      reasonCodes: ["pull-request-head-drift"]
    };
    const writes: string[] = [];
    await expect(
      runFactoryBrokerPullRequestMaintenanceTick(
        configPath,
        schedulePolicyDigest,
        roleIdentityPolicyDigest,
        policyBundleDigest,
        dependencies(runtime(Promise.resolve(preflight()), attention), (message) =>
          writes.push(message)
        )
      )
    ).resolves.toBe(2);
    expect(JSON.parse(writes[0] ?? "")).toMatchObject({
      status: "attention-required",
      reasonCodes: ["pull-request-head-drift"]
    });

    const forged = { ...idle(), repositoryId: "another/repository" };
    const forgedWrites: string[] = [];
    await expect(
      runFactoryBrokerPullRequestMaintenanceTick(
        configPath,
        schedulePolicyDigest,
        roleIdentityPolicyDigest,
        policyBundleDigest,
        dependencies(runtime(Promise.resolve(preflight()), forged), (message) =>
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
): FactoryBrokerPullRequestMaintenanceTickRunnerDependencies {
  return {
    loadConfig: () => Promise.resolve(config()),
    createRuntime: () => broker,
    write
  };
}

function runtime(
  preflightResult: Promise<FactoryBrokerPreflight>,
  maintenanceResult: FactoryCanaryPullRequestMaintenanceTickReport,
  options: {
    readonly maintain?: LocalFactoryBrokerRuntime["commands"]["maintainCanaryPullRequests"];
    readonly close?: () => Promise<void>;
  } = {}
): LocalFactoryBrokerRuntime {
  return {
    commands: {
      preflight: () => preflightResult,
      openDraft: () => Promise.resolve({ status: "denied", reasonCodes: ["test"], decision: null }),
      reconcileCanaryDrafts: () => Promise.reject(new Error("not used")),
      maintainCanaryPullRequests: options.maintain ?? (() => Promise.resolve(maintenanceResult)),
      updateCanaryPullRequests: () => Promise.reject(new Error("not used")),
      observePullRequest: () =>
        Promise.resolve({ status: "denied", reasonCodes: ["pr-broker-disabled"] }),
      admitPullRequestRepair: () => Promise.resolve({ status: "denied", reasonCodes: ["test"] }),
      updatePullRequest: () =>
        Promise.resolve({ status: "denied", reasonCodes: ["test"], decision: null })
    },
    close: options.close ?? (() => Promise.resolve())
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

function idle(): FactoryCanaryPullRequestMaintenanceTickReport {
  return {
    schemaVersion: "agentlab.canary-pull-request-maintenance-tick-result.v1",
    status: "idle",
    repositoryId: "riadmefti/agentlab",
    schedulePolicyDigest,
    factoryPolicyBundleDigest: policyBundleDigest,
    roleIdentityPolicyDigest,
    maintenanceSlot: "2026-08-31T12:00:00.000Z",
    observedAt: "2026-08-31T13:00:00.000Z",
    candidatesInspected: 0,
    maintenanceAttempts: 0,
    observationsCreated: 0,
    repairAuthorizationsCreated: 0,
    hasMore: false,
    reasonCodes: [],
    tasks: []
  };
}

function completed(): FactoryCanaryPullRequestMaintenanceTickReport {
  return {
    ...idle(),
    status: "completed",
    candidatesInspected: 1,
    maintenanceAttempts: 1,
    observationsCreated: 1,
    repairAuthorizationsCreated: 1,
    tasks: [
      {
        taskId: "00000000-0000-4000-8000-000000000001",
        reservationDigest: testDigest("1"),
        source: "unobserved",
        status: "repair-authorized",
        reasonCodes: [],
        observationDigest: testDigest("2"),
        repairAuthorizationDigest: testDigest("3")
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
    databasePath: "/private/agentlab/factory.sqlite",
    artifactRoot: "/private/agentlab/artifacts",
    temporaryRoot: "/private/agentlab/tmp",
    repositoryId: "riadmefti/agentlab",
    repositoryNumericId: 1,
    brokerId: "agentlab-pr-broker",
    gitExecutable: "/usr/bin/git",
    githubApp: {
      clientId: "Iv1.test",
      installationId: 1,
      privateKeyPath: "/private/agentlab/github-app.pem",
      trustedStatusChecks: [
        { context: "verify", appId: 1 },
        { context: "factory-sandbox", appId: 1 }
      ]
    }
  };
}
