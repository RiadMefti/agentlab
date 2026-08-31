import { describe, expect, it, vi } from "vitest";

import { LocalFactoryIntakeCoordinator } from "../../packages/runtime/src/application/local-factory-intake-coordinator.js";
import { RuntimeRepositoryOwner } from "../../packages/runtime/src/application/runtime-repository-owner.js";
import { RuntimeTaskOwner } from "../../packages/runtime/src/application/runtime-task-owner.js";

describe("LocalFactoryIntakeCoordinator", () => {
  it("serializes and bounds intake commands", async () => {
    const firstInspection = deferredSignal();
    let inspections = 0;
    const runtime = coordinator({
      maximumQueuedCommands: 2,
      preflight: async () => {
        inspections += 1;
        if (inspections === 1) await firstInspection.promise;
        return undefined as never;
      }
    });

    const first = runtime.commands.preflight();
    const second = runtime.commands.preflight();
    await expect(runtime.commands.preflight()).rejects.toThrow(/queue is full/u);
    await Promise.resolve();
    await Promise.resolve();
    expect(inspections).toBe(1);

    firstInspection.resolve();
    await Promise.all([first, second]);
    expect(inspections).toBe(2);
    await runtime.close();
  });

  it("drains commands before resources, repositories, and writer authority", async () => {
    const inspection = deferredSignal();
    const events: string[] = [];
    const repositories = new RuntimeRepositoryOwner();
    repositories.track({ close: () => events.push("repository-one") });
    repositories.track({ close: () => events.push("repository-two") });
    const runtime = coordinator({
      repositories,
      preflight: async () => {
        await inspection.promise;
        return undefined as never;
      },
      resources: {
        closeAll: () => Promise.resolve(events.push("resources")).then(() => undefined)
      },
      writerLease: {
        databasePath: "/tmp/agentlab-intake.sqlite",
        close: () => events.push("lease")
      }
    });

    const command = runtime.commands.preflight();
    const closing = runtime.close();
    await Promise.resolve();
    expect(events).toEqual([]);
    inspection.resolve();
    await command;
    await closing;

    expect(events).toEqual(["resources", "repository-two", "repository-one", "lease"]);
    await expect(runtime.commands.preflight()).rejects.toThrow(/runtime is closing/u);
  });
});

function coordinator(
  options: {
    readonly preflight?: () => Promise<never>;
    readonly maximumQueuedCommands?: number;
    readonly repositories?: RuntimeRepositoryOwner;
    readonly resources?: { closeAll(): Promise<void> };
    readonly writerLease?: { readonly databasePath: string; close(): void };
  } = {}
) {
  return new LocalFactoryIntakeCoordinator({
    operator: {
      preflight: options.preflight ?? (() => Promise.resolve(undefined as never)),
      register: () => Promise.resolve(undefined as never)
    },
    tasks: new RuntimeTaskOwner(),
    resources: options.resources ?? { closeAll: () => Promise.resolve() },
    repositories: options.repositories ?? new RuntimeRepositoryOwner(),
    writerLease: options.writerLease ?? {
      databasePath: "/tmp/agentlab-intake.sqlite",
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
