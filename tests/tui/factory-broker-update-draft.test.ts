import type {
  FactoryBrokerPreflight,
  LocalFactoryBrokerConfig,
  LocalFactoryBrokerRuntime
} from "@agentlab/runtime/factory-broker";
import { describe, expect, it, vi } from "vitest";

import {
  runFactoryBrokerUpdateDraft,
  type FactoryBrokerUpdateDraftRunnerDependencies
} from "../../apps/tui/src/run-factory-broker-update-draft.js";

const configPath = "/private/agentlab/broker.json";
const taskId = "0198f005-4ec4-7000-8000-000000000001";
const authorizationDigest = `sha256:${"a".repeat(64)}` as const;
const policyBundleDigest = `sha256:${"b".repeat(64)}` as const;
const baseRevision = "c".repeat(40);

describe("factory broker update-draft CLI runner", () => {
  it("rejects malformed intent before loading authority-bearing config", async () => {
    const loadConfig = vi.fn(() => Promise.resolve(config()));
    const createRuntime = vi.fn(() => brokerRuntime(() => Promise.resolve(updatedOutcome())));
    const dependencies = { loadConfig, createRuntime, write: vi.fn() };

    await expect(
      runFactoryBrokerUpdateDraft(
        configPath,
        taskId,
        authorizationDigest,
        policyBundleDigest,
        "not-confirmed",
        dependencies
      )
    ).rejects.toThrow(/explicit update confirmation/u);
    await expect(
      runFactoryBrokerUpdateDraft(
        configPath,
        taskId,
        "sha256:short",
        policyBundleDigest,
        "confirm-update",
        dependencies
      )
    ).rejects.toThrow(/authorization digest is invalid/u);
    await expect(
      runFactoryBrokerUpdateDraft(
        configPath,
        "not-a-task",
        authorizationDigest,
        policyBundleDigest,
        "confirm-update",
        dependencies
      )
    ).rejects.toThrow(/task ID is invalid/u);

    expect(loadConfig).not.toHaveBeenCalled();
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it("updates only the confirmed authorization and closes before reporting", async () => {
    const events: string[] = [];
    const updatePullRequest = vi.fn(() => Promise.resolve(updatedOutcome()));
    const runtime = brokerRuntime(updatePullRequest, preflight(), () => {
      events.push("closed");
      return Promise.resolve();
    });
    const writes: string[] = [];

    await expect(
      runFactoryBrokerUpdateDraft(
        configPath,
        taskId,
        authorizationDigest,
        policyBundleDigest,
        "confirm-update",
        dependencies(runtime, (message) => {
          events.push("written");
          writes.push(message);
        })
      )
    ).resolves.toBe(0);

    expect(updatePullRequest).toHaveBeenCalledOnce();
    expect(updatePullRequest).toHaveBeenCalledWith({ taskId, authorizationDigest });
    expect(events).toEqual(["closed", "written"]);
    expect(JSON.parse(writes[0] ?? "")).toEqual({
      schemaVersion: "agentlab.broker-update-draft-result.v1",
      status: "updated",
      taskId,
      authorizationDigest,
      policyBundleDigest,
      repositoryId: "riadmefti/agentlab",
      reasonCodes: [],
      pullRequest: {
        number: 42,
        url: "https://github.com/riadmefti/agentlab/pull/42",
        branchName: "agentlab/canary",
        baseRevision,
        priorHeadRevision: "d".repeat(40),
        headRevision: "e".repeat(40),
        updateProposalDigest: `sha256:${"f".repeat(64)}`,
        repairedPatchProposalDigest: `sha256:${"1".repeat(64)}`,
        contractRepairAttempt: 1,
        draft: true
      }
    });
  });

  it("does not invoke the write port when readiness or the policy pin is blocked", async () => {
    const updatePullRequest = vi.fn(() => Promise.resolve(updatedOutcome()));
    const writes: string[] = [];
    const blocked = brokerRuntime(updatePullRequest, preflight("blocked", ["pr-broker-disabled"]));
    await expect(
      runFactoryBrokerUpdateDraft(
        configPath,
        taskId,
        authorizationDigest,
        policyBundleDigest,
        "confirm-update",
        dependencies(blocked, (message) => writes.push(message))
      )
    ).resolves.toBe(2);
    expect(updatePullRequest).not.toHaveBeenCalled();
    expect(JSON.parse(writes[0] ?? "")).toMatchObject({
      status: "blocked",
      reasonCodes: ["pr-broker-disabled"],
      pullRequest: null
    });

    const mismatched = brokerRuntime(updatePullRequest);
    await expect(
      runFactoryBrokerUpdateDraft(
        configPath,
        taskId,
        authorizationDigest,
        `sha256:${"9".repeat(64)}`,
        "confirm-update",
        dependencies(mismatched, (message) => writes.push(message))
      )
    ).resolves.toBe(2);
    expect(updatePullRequest).not.toHaveBeenCalled();
    expect(JSON.parse(writes[1] ?? "")).toMatchObject({
      status: "blocked",
      reasonCodes: ["policy-bundle-digest-mismatch"],
      pullRequest: null
    });
  });

  it("closes and suppresses output after an invalid result or cleanup failure", async () => {
    const writes: string[] = [];
    const invalid = brokerRuntime(() =>
      Promise.resolve({
        ...updatedOutcome(),
        record: { ...updatedOutcome().record, taskId: "0198f005-4ec4-7000-8000-000000000002" }
      })
    );
    await expect(
      runFactoryBrokerUpdateDraft(
        configPath,
        taskId,
        authorizationDigest,
        policyBundleDigest,
        "confirm-update",
        dependencies(invalid, (message) => writes.push(message))
      )
    ).rejects.toThrow(/does not match/u);
    expect(writes).toEqual([]);

    const primary = new Error("update failed");
    const cleanup = new Error("cleanup failed");
    const failed = brokerRuntime(
      () => Promise.reject(primary),
      preflight(),
      () => Promise.reject(cleanup)
    );
    await expect(
      runFactoryBrokerUpdateDraft(
        configPath,
        taskId,
        authorizationDigest,
        policyBundleDigest,
        "confirm-update",
        dependencies(failed, (message) => writes.push(message))
      )
    ).rejects.toEqual(
      expect.objectContaining({ name: "AggregateError", errors: [primary, cleanup] })
    );
    expect(writes).toEqual([]);
  });
});

function dependencies(
  runtime: LocalFactoryBrokerRuntime,
  write: (message: string) => void
): FactoryBrokerUpdateDraftRunnerDependencies {
  return {
    loadConfig: vi.fn(() => Promise.resolve(config())),
    createRuntime: vi.fn(() => runtime),
    write
  };
}

function brokerRuntime(
  updatePullRequest: LocalFactoryBrokerRuntime["commands"]["updatePullRequest"],
  preflightResult: FactoryBrokerPreflight = preflight(),
  close: () => Promise<void> = () => Promise.resolve()
): LocalFactoryBrokerRuntime {
  return {
    commands: {
      preflight: () => Promise.resolve(preflightResult),
      openDraft: () => Promise.resolve({ status: "denied", reasonCodes: ["test"], decision: null }),
      observePullRequest: () =>
        Promise.resolve({ status: "denied", reasonCodes: ["pr-broker-disabled"] }),
      admitPullRequestRepair: () => Promise.resolve({ status: "denied", reasonCodes: ["test"] }),
      updatePullRequest
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
      baseRevision,
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

function updatedOutcome() {
  return {
    status: "updated" as const,
    record: {
      schemaVersion: "agentlab.pull-request-update-record.v1" as const,
      taskId,
      contractDigest: `sha256:${"2".repeat(64)}` as const,
      initialProposalDigest: `sha256:${"3".repeat(64)}` as const,
      updateProposalDigest: `sha256:${"f".repeat(64)}` as const,
      priorPullRequestRecordDigest: `sha256:${"4".repeat(64)}` as const,
      repairAuthorizationDigest: authorizationDigest,
      repairRunDigest: `sha256:${"5".repeat(64)}` as const,
      repairedPatchProposalDigest: `sha256:${"1".repeat(64)}` as const,
      repositoryId: "riadmefti/agentlab",
      number: 42,
      url: "https://github.com/riadmefti/agentlab/pull/42",
      baseRevision,
      priorHeadRevision: "d".repeat(40),
      headRevision: "e".repeat(40),
      branchName: "agentlab/canary",
      draft: true as const,
      brokerId: "agentlab-pr-broker",
      contractRepairAttempt: 1,
      updatedAt: "2026-08-31T10:00:00.000Z"
    },
    decision: {
      outcome: "allow" as const,
      effectiveRiskTier: "R1" as const,
      profileId: "baseline/r1",
      reasonCodes: [],
      requiredGateIds: [],
      requiredEvidence: [],
      requiredHumanApprovals: 0,
      satisfiedHumanApprovals: 0
    },
    remoteUpdated: true
  };
}

function config(): LocalFactoryBrokerConfig {
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
