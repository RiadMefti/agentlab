import { describe, expect, it, vi } from "vitest";

import { FactoryBrokerOperator } from "../../packages/runtime/src/application/factory-broker-operator.js";
import { LocalFactoryBrokerCoordinator } from "../../packages/runtime/src/application/local-factory-broker-coordinator.js";
import { RuntimeRepositoryOwner } from "../../packages/runtime/src/application/runtime-repository-owner.js";
import { RuntimeTaskOwner } from "../../packages/runtime/src/application/runtime-task-owner.js";
import type { FactoryRemoteRepositorySnapshot } from "../../packages/runtime/src/domain/factory-pull-request-broker.js";

const policyBundleDigest = `sha256:${"b".repeat(64)}`;

describe("LocalFactoryBrokerCoordinator", () => {
  it("drains admitted commands before clearing credentials and closing repositories in reverse order", async () => {
    const inspection = deferred<FactoryRemoteRepositorySnapshot>();
    const events: string[] = [];
    const repositories = new RuntimeRepositoryOwner();
    repositories.track({ close: () => events.push("repository-one") });
    repositories.track({ close: () => events.push("repository-two") });
    const operator = createOperator(() => inspection.promise);
    const runtime = new LocalFactoryBrokerCoordinator({
      operator,
      tasks: new RuntimeTaskOwner(),
      repositories,
      tokenSource: { clear: () => events.push("credentials") },
      writerLease: {
        databasePath: "/tmp/agentlab.sqlite",
        close: () => events.push("lease")
      }
    });

    const command = runtime.commands.preflight();
    const closing = runtime.close();
    await Promise.resolve();
    expect(events).toEqual([]);

    inspection.resolve(remoteSnapshot());
    await expect(command).resolves.toMatchObject({ status: "blocked" });
    await expect(closing).resolves.toBeUndefined();
    expect(events).toEqual(["credentials", "repository-two", "repository-one", "lease"]);
  });

  it("retains the writer lease and retries only repository handles that failed to close", async () => {
    let closeAttempts = 0;
    const tokenClear = vi.fn();
    const leaseClose = vi.fn();
    const repositories = new RuntimeRepositoryOwner();
    repositories.track({
      close() {
        closeAttempts += 1;
        if (closeAttempts === 1) throw new Error("ambiguous repository close");
      }
    });
    const runtime = new LocalFactoryBrokerCoordinator({
      operator: createOperator(() => Promise.resolve(remoteSnapshot())),
      tasks: new RuntimeTaskOwner(),
      repositories,
      tokenSource: { clear: tokenClear },
      writerLease: { databasePath: "/tmp/agentlab.sqlite", close: leaseClose }
    });

    await expect(runtime.close()).rejects.toThrow(/could not close cleanly/u);
    expect(closeAttempts).toBe(1);
    expect(tokenClear).toHaveBeenCalledOnce();
    expect(leaseClose).not.toHaveBeenCalled();

    await expect(runtime.close()).resolves.toBeUndefined();
    expect(closeAttempts).toBe(2);
    expect(tokenClear).toHaveBeenCalledOnce();
    expect(leaseClose).toHaveBeenCalledOnce();
    await expect(runtime.commands.preflight()).rejects.toThrow(/runtime is closing/u);
  });

  it("retries credential disposal even after persistence and lease closure succeeded", async () => {
    let clearAttempts = 0;
    const repositoryClose = vi.fn();
    const leaseClose = vi.fn();
    const repositories = new RuntimeRepositoryOwner();
    repositories.track({ close: repositoryClose });
    const runtime = new LocalFactoryBrokerCoordinator({
      operator: createOperator(() => Promise.resolve(remoteSnapshot())),
      tasks: new RuntimeTaskOwner(),
      repositories,
      tokenSource: {
        clear() {
          clearAttempts += 1;
          if (clearAttempts === 1) throw new Error("credential disposal failed");
        }
      },
      writerLease: { databasePath: "/tmp/agentlab.sqlite", close: leaseClose }
    });

    await expect(runtime.close()).rejects.toThrow(/could not close cleanly/u);
    expect(repositoryClose).toHaveBeenCalledOnce();
    expect(leaseClose).toHaveBeenCalledOnce();

    await expect(runtime.close()).resolves.toBeUndefined();
    expect(clearAttempts).toBe(2);
    expect(repositoryClose).toHaveBeenCalledOnce();
    expect(leaseClose).toHaveBeenCalledOnce();
  });
});

function createOperator(
  inspect: (repositoryId: string) => Promise<FactoryRemoteRepositorySnapshot>
): FactoryBrokerOperator {
  return new FactoryBrokerOperator({
    repositoryId: "riadmefti/agentlab",
    policyBundleDigest,
    costPolicyConfigured: false,
    remote: { inspect },
    controls: {
      state: () => Promise.resolve({ scheduler: false, prBroker: false })
    },
    pullRequests: {
      openDraft: () => Promise.resolve({ status: "denied", reasonCodes: ["test"], decision: null })
    },
    pullRequestObservations: {
      observe: () => Promise.resolve({ status: "denied", reasonCodes: ["pr-broker-disabled"] })
    },
    pullRequestRepairAdmissions: {
      admit: () => Promise.resolve({ status: "denied", reasonCodes: ["test"] })
    },
    pullRequestUpdates: {
      update: () => Promise.resolve({ status: "denied", reasonCodes: ["test"], decision: null })
    }
  });
}

function remoteSnapshot(): FactoryRemoteRepositorySnapshot {
  return {
    repositoryId: "riadmefti/agentlab",
    baseBranch: "main",
    baseRevision: "a".repeat(40),
    governance: {
      requiresPullRequest: true,
      requiredApprovals: 0,
      dismissesStaleReviews: true,
      requiresCodeOwnerReviews: false,
      requiresLastPushApproval: false,
      enforcesAdmins: true,
      allowsForcePushes: false,
      allowsDeletions: false,
      requiredStatusChecks: ["verify", "factory-sandbox"]
    }
  };
}

function deferred<Value>(): {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
} {
  let resolvePromise: ((value: Value) => void) | null = null;
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve(value) {
      if (resolvePromise === null) throw new Error("Deferred promise was not initialized.");
      resolvePromise(value);
    }
  };
}
