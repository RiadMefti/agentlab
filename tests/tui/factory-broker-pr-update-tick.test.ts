import type {
  FactoryCanaryPullRequestUpdateTickReport,
  LocalFactoryBrokerConfig,
  LocalFactoryBrokerRuntime
} from "@agentlab/runtime/factory-broker";
import { describe, expect, it, vi } from "vitest";

import {
  runFactoryBrokerPullRequestUpdateTick,
  type FactoryBrokerPullRequestUpdateTickRunnerDependencies
} from "../../apps/tui/src/run-factory-broker-pr-update-tick.js";
import { NodeFactoryDocumentCodec } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { testDigest } from "../helpers/factory.js";
import { testFactoryRoleIdentityPolicy } from "../helpers/factory-evaluation.js";
import { testFactorySchedulePolicy } from "../helpers/factory-schedule.js";

const configPath = "/private/agentlab/broker.json";
const schedulePolicy = testFactorySchedulePolicy();
const roleIdentityPolicy = testFactoryRoleIdentityPolicy({
  keyId: testDigest("8"),
  workerUserId: 1_001,
  attestorUserId: 1_002
});
const codec = new NodeFactoryDocumentCodec();
const schedulePolicyDigest = codec.schedulePolicy(schedulePolicy).digest;
const roleIdentityPolicyDigest = codec.roleIdentityPolicy(roleIdentityPolicy).digest;
const policyBundleDigest = testDigest("c");

describe("factory broker PR-update tick CLI runner", () => {
  it("rejects malformed pins before loading credential-bearing configuration", async () => {
    const loadConfig = vi.fn(() => Promise.resolve(config()));
    const createRuntime = vi.fn(() => runtime(idle()));

    await expect(
      runFactoryBrokerPullRequestUpdateTick(
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

  it("requires config v3 before constructing the broker runtime", async () => {
    const createRuntime = vi.fn(() => runtime(idle()));
    await expect(
      runFactoryBrokerPullRequestUpdateTick(
        configPath,
        schedulePolicyDigest,
        roleIdentityPolicyDigest,
        policyBundleDigest,
        { loadConfig: () => Promise.resolve(v1Config()), createRuntime, write: vi.fn() }
      )
    ).rejects.toThrow(/config v3/u);
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it("runs the exact consumer, closes before output, and reports publication", async () => {
    const events: string[] = [];
    const update = vi.fn(() => Promise.resolve(completed()));
    const broker = runtime(completed(), {
      update,
      close: () => {
        events.push("closed");
        return Promise.resolve();
      }
    });
    const writes: string[] = [];

    await expect(
      runFactoryBrokerPullRequestUpdateTick(
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

    expect(update).toHaveBeenCalledWith({
      expectedSchedulePolicyDigest: schedulePolicyDigest,
      expectedRoleIdentityPolicyDigest: roleIdentityPolicyDigest,
      expectedFactoryPolicyBundleDigest: policyBundleDigest
    });
    expect(events).toEqual(["closed", "written"]);
    expect(JSON.parse(writes[0] ?? "")).toMatchObject({
      schemaVersion: "agentlab.broker-pr-update-tick-command-result.v1",
      status: "completed",
      reasonCodes: [],
      update: {
        candidatesInspected: 1,
        updateAttempts: 1,
        updatesCompleted: 1,
        remoteUpdates: 1
      }
    });
  });

  it("returns attention as exit 2 and rejects a forged report identity", async () => {
    const attention: FactoryCanaryPullRequestUpdateTickReport = {
      ...idle(),
      status: "attention-required",
      reasonCodes: ["canary-reservation-expired"]
    };
    const writes: string[] = [];
    await expect(
      runFactoryBrokerPullRequestUpdateTick(
        configPath,
        schedulePolicyDigest,
        roleIdentityPolicyDigest,
        policyBundleDigest,
        dependencies(runtime(attention), (message) => writes.push(message))
      )
    ).resolves.toBe(2);
    expect(JSON.parse(writes[0] ?? "")).toMatchObject({
      status: "attention-required",
      reasonCodes: ["canary-reservation-expired"]
    });

    const forged = { ...idle(), repositoryId: "another/repository" };
    await expect(
      runFactoryBrokerPullRequestUpdateTick(
        configPath,
        schedulePolicyDigest,
        roleIdentityPolicyDigest,
        policyBundleDigest,
        dependencies(runtime(forged), vi.fn())
      )
    ).rejects.toThrow(/different reviewed coordinates/u);
  });
});

function dependencies(
  broker: LocalFactoryBrokerRuntime,
  write: (message: string) => void
): FactoryBrokerPullRequestUpdateTickRunnerDependencies {
  return { loadConfig: () => Promise.resolve(config()), createRuntime: () => broker, write };
}

function runtime(
  report: FactoryCanaryPullRequestUpdateTickReport,
  options: {
    readonly update?: LocalFactoryBrokerRuntime["commands"]["updateCanaryPullRequests"];
    readonly close?: () => Promise<void>;
  } = {}
): LocalFactoryBrokerRuntime {
  return {
    commands: {
      preflight: () => Promise.reject(new Error("not used")),
      openDraft: () => Promise.resolve({ status: "denied", reasonCodes: ["test"], decision: null }),
      reconcileCanaryDrafts: () => Promise.reject(new Error("not used")),
      maintainCanaryPullRequests: () => Promise.reject(new Error("not used")),
      updateCanaryPullRequests: options.update ?? (() => Promise.resolve(report)),
      observePullRequest: () =>
        Promise.resolve({ status: "denied", reasonCodes: ["pr-broker-disabled"] }),
      admitPullRequestRepair: () => Promise.resolve({ status: "denied", reasonCodes: ["test"] }),
      updatePullRequest: () =>
        Promise.resolve({ status: "denied", reasonCodes: ["test"], decision: null })
    },
    close: options.close ?? (() => Promise.resolve())
  };
}

function idle(): FactoryCanaryPullRequestUpdateTickReport {
  return {
    schemaVersion: "agentlab.canary-pull-request-update-tick-result.v1",
    status: "idle",
    repositoryId: "riadmefti/agentlab",
    schedulePolicyDigest,
    factoryPolicyBundleDigest: policyBundleDigest,
    roleIdentityPolicyDigest,
    observedAt: "2026-08-31T13:00:00.000Z",
    candidatesInspected: 0,
    recoveryAttempts: 0,
    updateAttempts: 0,
    updatesCompleted: 0,
    remoteUpdates: 0,
    hasMore: false,
    reasonCodes: [],
    tasks: []
  };
}

function completed(): FactoryCanaryPullRequestUpdateTickReport {
  return {
    ...idle(),
    status: "completed",
    candidatesInspected: 1,
    updateAttempts: 1,
    updatesCompleted: 1,
    remoteUpdates: 1,
    tasks: [
      {
        taskId: "00000000-0000-4000-8000-000000000001",
        repositoryId: "riadmefti/agentlab",
        authorizationDigest: testDigest("1"),
        repairRunDigest: testDigest("2"),
        source: "authorized",
        status: "updated",
        reasonCodes: [],
        pullRequestNumber: 42,
        priorHeadRevision: "b".repeat(40),
        headRevision: "c".repeat(40),
        remoteUpdated: true
      }
    ]
  };
}

function config(): LocalFactoryBrokerConfig {
  return {
    ...v1Config(),
    schemaVersion: "agentlab.local-factory-broker.v3",
    costPolicyPath: "/private/agentlab/cost-policy.json",
    schedulePolicyPath: "/private/agentlab/schedule-policy.json",
    roleIdentityPolicyPath: "/private/agentlab/role-identities.json",
    expectedRoleIdentityPolicyDigest: roleIdentityPolicyDigest,
    costPolicy: {
      schemaVersion: "agentlab.cost-policy.v1",
      id: "agentlab/test-costs",
      version: "1.0.0",
      rules: []
    },
    schedulePolicy,
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
