import type {
  FactoryBrokerPreflight,
  LocalFactoryBrokerConfig,
  LocalFactoryBrokerRuntime
} from "@agentlab/runtime/factory-broker";
import { describe, expect, it, vi } from "vitest";

import {
  runFactoryBrokerOpenDraft,
  type FactoryBrokerOpenDraftRunnerDependencies
} from "../../apps/tui/src/run-factory-broker-open-draft.js";

const configPath = "/private/agentlab/broker.json";
const taskId = "0198f005-4ec4-7000-8000-000000000001";
const policyBundleDigest = `sha256:${"c".repeat(64)}` as const;
const baseRevision = "a".repeat(40);

describe("factory broker open-draft CLI runner", () => {
  it("rejects malformed intent before loading authority-bearing config", async () => {
    const loadConfig = vi.fn(() => Promise.resolve(config()));
    const createRuntime = vi.fn(() =>
      brokerRuntime(Promise.resolve(preflight()), () => Promise.resolve(openedOutcome()))
    );

    await expect(
      runFactoryBrokerOpenDraft(configPath, taskId, policyBundleDigest, "not-confirmed", {
        loadConfig,
        createRuntime,
        write: vi.fn()
      })
    ).rejects.toThrow(/explicit draft confirmation/u);
    await expect(
      runFactoryBrokerOpenDraft(configPath, taskId, "sha256:short", "confirm-draft", {
        loadConfig,
        createRuntime,
        write: vi.fn()
      })
    ).rejects.toThrow(/policy digest is invalid/u);
    await expect(
      runFactoryBrokerOpenDraft(configPath, "not-a-task", policyBundleDigest, "confirm-draft", {
        loadConfig,
        createRuntime,
        write: vi.fn()
      })
    ).rejects.toThrow(/task ID is invalid/u);

    expect(loadConfig).not.toHaveBeenCalled();
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it("opens only the confirmed task after preflight and closes before reporting", async () => {
    const events: string[] = [];
    const openDraft = vi.fn(() => Promise.resolve(openedOutcome()));
    const runtime = brokerRuntime(Promise.resolve(preflight()), openDraft, () =>
      Promise.resolve(events.push("closed")).then(() => undefined)
    );
    const writes: string[] = [];

    await expect(
      runFactoryBrokerOpenDraft(
        configPath,
        taskId,
        policyBundleDigest,
        "confirm-draft",
        dependencies(runtime, (message) => {
          events.push("written");
          writes.push(message);
        })
      )
    ).resolves.toBe(0);

    expect(openDraft).toHaveBeenCalledOnce();
    expect(openDraft).toHaveBeenCalledWith({ taskId });
    expect(events).toEqual(["closed", "written"]);
    expect(JSON.parse(writes[0] ?? "")).toEqual({
      schemaVersion: "agentlab.broker-open-draft-result.v1",
      status: "opened",
      taskId,
      policyBundleDigest,
      repository: {
        repositoryId: "riadmefti/agentlab",
        baseBranch: "main",
        baseRevision
      },
      reasonCodes: [],
      pullRequest: {
        number: 42,
        url: "https://github.com/riadmefti/agentlab/pull/42",
        branchName: "agentlab/canary",
        baseRevision,
        headRevision: "b".repeat(40),
        proposalDigest: `sha256:${"e".repeat(64)}`,
        draft: true
      }
    });
  });

  it("does not invoke the write port when governance or authority preflight is blocked", async () => {
    const openDraft = vi.fn(() => Promise.resolve(openedOutcome()));
    const runtime = brokerRuntime(
      Promise.resolve(preflight("blocked", ["pr-broker-disabled"])),
      openDraft
    );
    const writes: string[] = [];

    await expect(
      runFactoryBrokerOpenDraft(
        configPath,
        taskId,
        policyBundleDigest,
        "confirm-draft",
        dependencies(runtime, (message) => writes.push(message))
      )
    ).resolves.toBe(2);

    expect(openDraft).not.toHaveBeenCalled();
    expect(JSON.parse(writes[0] ?? "")).toMatchObject({
      status: "blocked",
      reasonCodes: ["pr-broker-disabled"],
      pullRequest: null
    });
  });

  it("reports an idempotent completed dispatch after the remote base has advanced", async () => {
    const currentBaseRevision = "c".repeat(40);
    const runtime = brokerRuntime(
      Promise.resolve(preflight("ready", [], currentBaseRevision)),
      () => Promise.resolve(openedOutcome())
    );
    const writes: string[] = [];

    await expect(
      runFactoryBrokerOpenDraft(
        configPath,
        taskId,
        policyBundleDigest,
        "confirm-draft",
        dependencies(runtime, (message) => writes.push(message))
      )
    ).resolves.toBe(0);

    expect(JSON.parse(writes[0] ?? "")).toMatchObject({
      repository: { baseRevision: currentBaseRevision },
      pullRequest: { baseRevision }
    });
  });

  it("does not invoke the write port when the operator policy pin differs", async () => {
    const openDraft = vi.fn(() => Promise.resolve(openedOutcome()));
    const runtime = brokerRuntime(Promise.resolve(preflight()), openDraft);
    const writes: string[] = [];

    await expect(
      runFactoryBrokerOpenDraft(
        configPath,
        taskId,
        `sha256:${"f".repeat(64)}`,
        "confirm-draft",
        dependencies(runtime, (message) => writes.push(message))
      )
    ).resolves.toBe(2);

    expect(openDraft).not.toHaveBeenCalled();
    expect(JSON.parse(writes[0] ?? "")).toMatchObject({
      status: "blocked",
      reasonCodes: ["policy-bundle-digest-mismatch"]
    });
  });

  it("reports a policy denial without claiming a remote write", async () => {
    const runtime = brokerRuntime(Promise.resolve(preflight()), () =>
      Promise.resolve({
        status: "denied",
        reasonCodes: ["budget-cost-exceeded", "budget-cost-exceeded"],
        decision: null
      })
    );
    const writes: string[] = [];

    await expect(
      runFactoryBrokerOpenDraft(
        configPath,
        taskId,
        policyBundleDigest,
        "confirm-draft",
        dependencies(runtime, (message) => writes.push(message))
      )
    ).resolves.toBe(2);

    expect(JSON.parse(writes[0] ?? "")).toMatchObject({
      status: "denied",
      reasonCodes: ["budget-cost-exceeded"],
      pullRequest: null
    });
  });

  it("closes and suppresses output after an invalid broker result or cleanup failure", async () => {
    const primary = brokerRuntime(Promise.resolve(preflight()), () =>
      Promise.resolve({
        ...openedOutcome(),
        record: { ...openedOutcome().record, taskId: "0198f005-4ec4-7000-8000-000000000002" }
      })
    );
    const writes: string[] = [];
    await expect(
      runFactoryBrokerOpenDraft(
        configPath,
        taskId,
        policyBundleDigest,
        "confirm-draft",
        dependencies(primary, (message) => writes.push(message))
      )
    ).rejects.toThrow(/does not match/u);
    expect(writes).toEqual([]);

    const dispatchFailure = new Error("dispatch failed");
    const cleanupFailure = new Error("cleanup failed");
    const failed = brokerRuntime(
      Promise.resolve(preflight()),
      () => Promise.reject(dispatchFailure),
      () => Promise.reject(cleanupFailure)
    );
    await expect(
      runFactoryBrokerOpenDraft(
        configPath,
        taskId,
        policyBundleDigest,
        "confirm-draft",
        dependencies(failed, (message) => writes.push(message))
      )
    ).rejects.toEqual(
      expect.objectContaining({
        name: "AggregateError",
        errors: [dispatchFailure, cleanupFailure]
      })
    );
    expect(writes).toEqual([]);
  });
});

function dependencies(
  runtime: LocalFactoryBrokerRuntime,
  write: (message: string) => void
): FactoryBrokerOpenDraftRunnerDependencies {
  return {
    loadConfig: vi.fn(() => Promise.resolve(config())),
    createRuntime: vi.fn(() => runtime),
    write
  };
}

function brokerRuntime(
  preflightResult: Promise<FactoryBrokerPreflight>,
  openDraft: LocalFactoryBrokerRuntime["commands"]["openDraft"],
  close: () => Promise<void> = () => Promise.resolve()
): LocalFactoryBrokerRuntime {
  return { commands: { preflight: () => preflightResult, openDraft }, close };
}

function preflight(
  status: "ready" | "blocked" = "ready",
  reasonCodes: readonly string[] = [],
  inspectedBaseRevision: string = baseRevision
): FactoryBrokerPreflight {
  return {
    schemaVersion: "agentlab.broker-preflight.v1",
    status,
    repository: {
      repositoryId: "riadmefti/agentlab",
      baseBranch: "main",
      baseRevision: inspectedBaseRevision,
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

function openedOutcome() {
  return {
    status: "opened" as const,
    record: {
      schemaVersion: "agentlab.pull-request-record.v1" as const,
      taskId,
      contractDigest: `sha256:${"d".repeat(64)}` as const,
      proposalDigest: `sha256:${"e".repeat(64)}` as const,
      repositoryId: "riadmefti/agentlab",
      number: 42,
      url: "https://github.com/riadmefti/agentlab/pull/42",
      baseRevision,
      headRevision: "b".repeat(40),
      branchName: "agentlab/canary",
      draft: true as const,
      brokerId: "agentlab-pr-broker",
      createdAt: "2026-08-31T10:00:00.000Z"
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
    }
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
