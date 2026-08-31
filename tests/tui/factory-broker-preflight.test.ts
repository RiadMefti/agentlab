import type {
  FactoryBrokerPreflight,
  LocalFactoryBrokerConfig,
  LocalFactoryBrokerRuntime
} from "@agentlab/runtime/factory-broker";
import { describe, expect, it, vi } from "vitest";

import {
  runFactoryBrokerPreflight,
  type FactoryBrokerPreflightRunnerDependencies
} from "../../apps/tui/src/run-factory-broker-preflight.js";

const configPath = "/private/agentlab/broker.json";
const policyBundleDigest = `sha256:${"c".repeat(64)}`;

describe("factory broker preflight CLI runner", () => {
  it("prints one deterministic non-secret readiness record after clean shutdown", async () => {
    const writes: string[] = [];
    const close = vi.fn(() => Promise.resolve());
    const dependencies = runnerDependencies(
      preflightReport("ready", true, [], ["verify", "factory-sandbox"]),
      close,
      writes
    );

    await expect(runFactoryBrokerPreflight(configPath, dependencies)).resolves.toBe(0);

    expect(close).toHaveBeenCalledOnce();
    expect(writes).toHaveLength(1);
    expect(writes[0]?.endsWith("\n")).toBe(true);
    expect(writes[0]).not.toContain("github-app.pem");
    expect(JSON.parse(writes[0] ?? "")).toMatchObject({
      schemaVersion: "agentlab.broker-preflight.v1",
      status: "ready",
      authorityEnabled: true,
      reasonCodes: [],
      repository: {
        governance: {
          requiredStatusChecks: ["factory-sandbox", "verify"]
        }
      }
    });
  });

  it("returns a distinct blocked status and sorts reported reason codes", async () => {
    const writes: string[] = [];
    const dependencies = runnerDependencies(
      preflightReport(
        "blocked",
        false,
        ["repository-approval-rule-too-weak", "pr-broker-disabled"],
        ["verify"]
      ),
      vi.fn(() => Promise.resolve()),
      writes
    );

    await expect(runFactoryBrokerPreflight(configPath, dependencies)).resolves.toBe(2);
    expect(JSON.parse(writes[0] ?? "")).toMatchObject({
      status: "blocked",
      reasonCodes: ["pr-broker-disabled", "repository-approval-rule-too-weak"]
    });
  });

  it("closes on inspection failure and suppresses output when cleanup is not clean", async () => {
    const writes: string[] = [];
    const inspectionFailure = new Error("inspection failed");
    const cleanupFailure = new Error("cleanup failed");
    const close = vi.fn(() => Promise.reject(cleanupFailure));
    const runtime = brokerRuntime(Promise.reject(inspectionFailure), close);
    const dependencies: FactoryBrokerPreflightRunnerDependencies = {
      loadConfig: () => Promise.resolve(config()),
      createRuntime: () => runtime,
      write: (message) => writes.push(message)
    };

    await expect(runFactoryBrokerPreflight(configPath, dependencies)).rejects.toEqual(
      expect.objectContaining({
        name: "AggregateError",
        errors: [inspectionFailure, cleanupFailure]
      })
    );
    expect(close).toHaveBeenCalledOnce();
    expect(writes).toEqual([]);
  });
});

function runnerDependencies(
  report: FactoryBrokerPreflight,
  close: () => Promise<void>,
  writes: string[]
): FactoryBrokerPreflightRunnerDependencies {
  return {
    loadConfig: vi.fn(() => Promise.resolve(config())),
    createRuntime: vi.fn(() => brokerRuntime(Promise.resolve(report), close)),
    write: (message) => writes.push(message)
  };
}

function brokerRuntime(
  preflight: Promise<FactoryBrokerPreflight>,
  close: () => Promise<void>
): LocalFactoryBrokerRuntime {
  return {
    commands: {
      preflight: () => preflight,
      openDraft: () => Promise.resolve({ status: "denied", reasonCodes: ["test"], decision: null })
    },
    close
  };
}

function preflightReport(
  status: "ready" | "blocked",
  authorityEnabled: boolean,
  reasonCodes: readonly string[],
  requiredStatusChecks: readonly string[]
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
        requiredStatusChecks
      }
    },
    policyBundleDigest,
    authorityEnabled,
    reasonCodes
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
