import { describe, expect, it, vi } from "vitest";

import { FactoryWorkerOperator } from "../../packages/runtime/src/application/factory-worker-operator.js";
import { LocalFactoryWorkerCoordinator } from "../../packages/runtime/src/application/local-factory-worker-coordinator.js";
import { RuntimeRepositoryOwner } from "../../packages/runtime/src/application/runtime-repository-owner.js";
import { RuntimeTaskOwner } from "../../packages/runtime/src/application/runtime-task-owner.js";

const policyBundleDigest = `sha256:${"b".repeat(64)}` as const;
const gateIds = ["architecture", "build", "format", "lint", "secret-scan", "test", "typecheck"];

describe("LocalFactoryWorkerCoordinator", () => {
  it("serializes a bounded command queue", async () => {
    const firstInspection = deferredSignal();
    let inspections = 0;
    const runtime = coordinator({
      maximumQueuedCommands: 2,
      inspect: async () => {
        inspections += 1;
        if (inspections === 1) await firstInspection.promise;
        return { status: "ready", reasonCodes: [] };
      }
    });

    const first = runtime.commands.preflight();
    const second = runtime.commands.preflight();
    await expect(runtime.commands.preflight()).rejects.toThrow(/queue is full/u);
    await Promise.resolve();
    await Promise.resolve();
    expect(inspections).toBe(1);

    firstInspection.resolve();
    await expect(first).resolves.toMatchObject({ status: "ready" });
    await expect(second).resolves.toMatchObject({ status: "ready" });
    expect(inspections).toBe(2);
    await runtime.close();
  });

  it("drains admitted work before closing resources, repositories, and the writer lease", async () => {
    const inspection = deferredSignal();
    const events: string[] = [];
    const repositories = new RuntimeRepositoryOwner();
    repositories.track({ close: () => events.push("repository-one") });
    repositories.track({ close: () => events.push("repository-two") });
    const runtime = coordinator({
      repositories,
      inspect: async () => {
        await inspection.promise;
        return { status: "ready", reasonCodes: [] };
      },
      resources: {
        closeAll: () => Promise.resolve(events.push("resources")).then(() => undefined)
      },
      writerLease: {
        databasePath: "/tmp/agentlab-worker.sqlite",
        close: () => events.push("lease")
      }
    });

    const command = runtime.commands.preflight();
    const closing = runtime.close();
    await Promise.resolve();
    expect(events).toEqual([]);

    inspection.resolve();
    await expect(command).resolves.toMatchObject({ status: "ready" });
    await expect(closing).resolves.toBeUndefined();
    expect(events).toEqual(["resources", "repository-two", "repository-one", "lease"]);
    await expect(runtime.commands.preflight()).rejects.toThrow(/runtime is closing/u);
  });

  it("retains persistence and the lease until ambiguous resource cleanup succeeds", async () => {
    let resourceAttempts = 0;
    const repositoryClose = vi.fn();
    const leaseClose = vi.fn();
    const repositories = new RuntimeRepositoryOwner();
    repositories.track({ close: repositoryClose });
    const runtime = coordinator({
      repositories,
      resources: {
        closeAll() {
          resourceAttempts += 1;
          return resourceAttempts === 1
            ? Promise.reject(new Error("process cleanup uncertain"))
            : Promise.resolve();
        }
      },
      writerLease: { databasePath: "/tmp/agentlab-worker.sqlite", close: leaseClose }
    });

    await expect(runtime.close()).rejects.toThrow(/could not close cleanly/u);
    expect(repositoryClose).not.toHaveBeenCalled();
    expect(leaseClose).not.toHaveBeenCalled();

    await expect(runtime.close()).resolves.toBeUndefined();
    expect(resourceAttempts).toBe(2);
    expect(repositoryClose).toHaveBeenCalledOnce();
    expect(leaseClose).toHaveBeenCalledOnce();
  });

  it("retries only unfinished repository and lease shutdown phases", async () => {
    let repositoryAttempts = 0;
    let leaseAttempts = 0;
    const resourceClose = vi.fn(() => Promise.resolve());
    const repositories = new RuntimeRepositoryOwner();
    repositories.track({
      close() {
        repositoryAttempts += 1;
        if (repositoryAttempts === 1) throw new Error("repository close uncertain");
      }
    });
    const runtime = coordinator({
      repositories,
      resources: { closeAll: resourceClose },
      writerLease: {
        databasePath: "/tmp/agentlab-worker.sqlite",
        close() {
          leaseAttempts += 1;
          if (leaseAttempts === 1) throw new Error("lease close uncertain");
        }
      }
    });

    await expect(runtime.close()).rejects.toThrow(/could not close cleanly/u);
    expect(repositoryAttempts).toBe(1);
    expect(leaseAttempts).toBe(0);

    await expect(runtime.close()).rejects.toThrow(/could not close cleanly/u);
    expect(repositoryAttempts).toBe(2);
    expect(leaseAttempts).toBe(1);

    await expect(runtime.close()).resolves.toBeUndefined();
    expect(resourceClose).toHaveBeenCalledOnce();
    expect(repositoryAttempts).toBe(2);
    expect(leaseAttempts).toBe(2);
  });
});

function coordinator(
  options: {
    readonly inspect?: () => Promise<{ readonly status: "ready"; readonly reasonCodes: [] }>;
    readonly maximumQueuedCommands?: number;
    readonly repositories?: RuntimeRepositoryOwner;
    readonly resources?: { closeAll(): Promise<void> };
    readonly writerLease?: { readonly databasePath: string; close(): void };
  } = {}
) {
  const noResult = () => Promise.resolve(undefined as never);
  const operator = new FactoryWorkerOperator({
    policyBundleDigest,
    costPolicyConfigured: true,
    configuredProviders: ["codex"],
    gateIds,
    controls: { state: () => Promise.resolve({ scheduler: true, prBroker: false }) },
    host: {
      inspect: options.inspect ?? (() => Promise.resolve({ status: "ready", reasonCodes: [] }))
    },
    preparation: { advance: noResult, recover: noResult },
    materializer: { materialize: noResult },
    admission: { admit: noResult },
    execution: { execute: noResult },
    executionRecovery: { recover: noResult }
  });
  return new LocalFactoryWorkerCoordinator({
    operator,
    taskRunner: { run: noResult },
    tasks: new RuntimeTaskOwner(),
    resources: options.resources ?? { closeAll: () => Promise.resolve() },
    repositories: options.repositories ?? new RuntimeRepositoryOwner(),
    writerLease: options.writerLease ?? {
      databasePath: "/tmp/agentlab-worker.sqlite",
      close: vi.fn()
    },
    ...(options.maximumQueuedCommands === undefined
      ? {}
      : { maximumQueuedCommands: options.maximumQueuedCommands })
  });
}

function deferredSignal(): {
  readonly promise: Promise<undefined>;
  readonly resolve: () => void;
} {
  let resolvePromise: ((value: undefined) => void) | null = null;
  const promise = new Promise<undefined>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve() {
      if (resolvePromise === null) throw new Error("Deferred promise was not initialized.");
      resolvePromise(undefined);
    }
  };
}
