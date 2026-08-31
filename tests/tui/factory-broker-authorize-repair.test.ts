import type {
  FactoryBrokerPreflight,
  LocalFactoryBrokerConfig,
  LocalFactoryBrokerRuntime
} from "@agentlab/runtime/factory-broker";
import { describe, expect, it, vi } from "vitest";

import {
  runFactoryBrokerAuthorizeRepair,
  type FactoryBrokerAuthorizeRepairRunnerDependencies
} from "../../apps/tui/src/run-factory-broker-authorize-repair.js";

const configPath = "/private/agentlab/broker.json";
const taskId = "0198f005-4ec4-7000-8000-000000000001";
const observationDigest = digest("d");
const policyBundleDigest = digest("c");

describe("factory broker authorize-repair CLI runner", () => {
  it("rejects malformed intent before loading credential-bearing config", async () => {
    const loadConfig = vi.fn(() => Promise.resolve(config()));
    const createRuntime = vi.fn(() => runtime());

    await expect(
      runFactoryBrokerAuthorizeRepair(
        configPath,
        taskId,
        observationDigest,
        policyBundleDigest,
        "wrong",
        { loadConfig, createRuntime, write: vi.fn() }
      )
    ).rejects.toThrow(/explicit confirmation/u);
    expect(loadConfig).not.toHaveBeenCalled();
    expect(createRuntime).not.toHaveBeenCalled();
  });

  it("closes before reporting only bounded IDs, counts, and digests", async () => {
    const events: string[] = [];
    const writes: string[] = [];
    const admitPullRequestRepair = vi.fn(() => Promise.resolve(authorizedOutcome()));
    const broker = runtime(admitPullRequestRepair, () => {
      events.push("closed");
      return Promise.resolve();
    });

    await expect(
      runFactoryBrokerAuthorizeRepair(
        configPath,
        taskId,
        observationDigest,
        policyBundleDigest,
        "authorize-repair",
        dependencies(broker, (message) => {
          events.push("written");
          writes.push(message);
        })
      )
    ).resolves.toBe(0);

    expect(admitPullRequestRepair).toHaveBeenCalledWith({ taskId, observationDigest });
    expect(events).toEqual(["closed", "written"]);
    const output = writes[0] ?? "";
    expect(output).not.toContain("Ignore policy");
    expect(output).not.toContain("untrustedBody");
    expect(JSON.parse(output)).toMatchObject({
      schemaVersion: "agentlab.broker-authorize-repair-result.v1",
      status: "authorized",
      reasonCodes: ["review-changes-requested", "trusted-check-failed"],
      authorization: {
        observationDigest,
        pullRequestNumber: 42,
        contractRepairAttempt: 1,
        selectedReviews: 1,
        selectedReviewComments: 1,
        failedChecks: 1
      }
    });
  });
});

function dependencies(
  broker: LocalFactoryBrokerRuntime,
  write: (message: string) => void
): FactoryBrokerAuthorizeRepairRunnerDependencies {
  return {
    loadConfig: () => Promise.resolve(config()),
    createRuntime: () => broker,
    write
  };
}

function runtime(
  admitPullRequestRepair: LocalFactoryBrokerRuntime["commands"]["admitPullRequestRepair"] = () =>
    Promise.resolve({ status: "denied", reasonCodes: ["test"] }),
  close: () => Promise<void> = () => Promise.resolve()
): LocalFactoryBrokerRuntime {
  return {
    commands: {
      preflight: () => Promise.resolve(preflight()),
      openDraft: () => Promise.resolve({ status: "denied", reasonCodes: ["test"], decision: null }),
      observePullRequest: () =>
        Promise.resolve({ status: "denied", reasonCodes: ["pr-broker-disabled"] }),
      admitPullRequestRepair
    },
    close
  };
}

function authorizedOutcome(): Awaited<
  ReturnType<LocalFactoryBrokerRuntime["commands"]["admitPullRequestRepair"]>
> {
  return {
    status: "authorized" as const,
    authorizationDigest: digest("8"),
    evidenceBundleDigest: digest("9"),
    created: true,
    authorization: {
      schemaVersion: "agentlab.pull-request-repair-authorization.v1" as const,
      authorizationId: "11111111-1111-4111-8111-111111111111",
      taskId,
      contractDigest: digest("1"),
      policyBundleDigest,
      proposalDigest: digest("2"),
      priorPatchProposalDigest: digest("3"),
      pullRequestRecordDigest: digest("4"),
      observationDigest,
      observationEvidenceBundleDigest: digest("5"),
      repositoryId: "riadmefti/agentlab",
      pullRequestNumber: 42,
      headRevision: "b".repeat(40),
      brokerId: "github-app/agentlab",
      contractRepairAttempt: 1,
      reasonCodes: ["review-changes-requested", "trusted-check-failed"],
      selectedReviewIds: ["501"],
      selectedReviewCommentIds: ["601"],
      failedChecks: [
        {
          name: "verify",
          producerId: "github-app/15368",
          runId: "701",
          conclusion: "failure" as const
        }
      ],
      createdAt: "2026-08-30T12:04:00.000Z",
      expiresAt: "2026-08-31T12:04:00.000Z",
      correlationId: "22222222-2222-4222-8222-222222222222"
    }
  };
}

function preflight(): FactoryBrokerPreflight {
  return {
    schemaVersion: "agentlab.broker-preflight.v1",
    status: "ready",
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
    authorityEnabled: true,
    reasonCodes: []
  };
}

function config(): LocalFactoryBrokerConfig {
  return {
    schemaVersion: "agentlab.local-factory-broker.v1",
    databasePath: "/private/agentlab/agentlab.sqlite",
    artifactRoot: "/private/agentlab/artifacts",
    temporaryRoot: "/private/agentlab/temp",
    repositoryId: "riadmefti/agentlab",
    repositoryNumericId: 12_345,
    brokerId: "github-app/agentlab",
    gitExecutable: "/usr/bin/git",
    githubApp: {
      clientId: "Iv1.agentlab",
      installationId: 67_890,
      privateKeyPath: "/private/agentlab/app.pem",
      trustedStatusChecks: [
        { context: "verify", appId: 15_368 },
        { context: "factory-sandbox", appId: 15_368 }
      ]
    }
  };
}

function digest(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}
