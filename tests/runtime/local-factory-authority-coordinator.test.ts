import type { FactoryControlEvent, FactoryControlName } from "@agentlab/contracts";
import { describe, expect, it } from "vitest";

import { FactoryAuthorityOperator } from "../../packages/runtime/src/application/factory-authority-operator.js";
import { LocalFactoryAuthorityCoordinator } from "../../packages/runtime/src/application/local-factory-authority-coordinator.js";
import { RuntimeRepositoryOwner } from "../../packages/runtime/src/application/runtime-repository-owner.js";
import { RuntimeTaskOwner } from "../../packages/runtime/src/application/runtime-task-owner.js";
import type { CanonicalFactoryDocument } from "../../packages/runtime/src/domain/factory-documents.js";
import type {
  FactoryAuthorityState,
  FactoryControlRepository
} from "../../packages/runtime/src/domain/factory-task-repository.js";
import { NodeFactoryDocumentCodec } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";

describe("LocalFactoryAuthorityCoordinator", () => {
  it("drains admitted authority commands before closing repositories and the writer lease", async () => {
    const inspection = deferred<FactoryAuthorityState>();
    const events: string[] = [];
    const repositories = new RuntimeRepositoryOwner();
    repositories.track({ close: () => events.push("repository-one") });
    repositories.track({ close: () => events.push("repository-two") });
    const runtime = new LocalFactoryAuthorityCoordinator({
      operator: createOperator(new DeferredControls(inspection.promise)),
      tasks: new RuntimeTaskOwner(),
      repositories,
      writerLease: {
        databasePath: "/tmp/agentlab.sqlite",
        close: () => events.push("lease")
      }
    });

    const command = runtime.commands.inspect();
    const closing = runtime.close();
    await Promise.resolve();
    expect(events).toEqual([]);

    inspection.resolve({ scheduler: false, prBroker: false });
    await expect(command).resolves.toMatchObject({ prBrokerEnabled: false });
    await expect(closing).resolves.toBeUndefined();
    expect(events).toEqual(["repository-two", "repository-one", "lease"]);
    await expect(runtime.commands.inspect()).rejects.toThrow(/runtime is closing/u);
  });

  it("retains the writer lease and retries only repository handles that failed to close", async () => {
    let closeAttempts = 0;
    let leaseAttempts = 0;
    const repositories = new RuntimeRepositoryOwner();
    repositories.track({
      close() {
        closeAttempts += 1;
        if (closeAttempts === 1) throw new Error("ambiguous repository close");
      }
    });
    const runtime = new LocalFactoryAuthorityCoordinator({
      operator: createOperator(
        new DeferredControls(Promise.resolve({ scheduler: false, prBroker: false }))
      ),
      tasks: new RuntimeTaskOwner(),
      repositories,
      writerLease: {
        databasePath: "/tmp/agentlab.sqlite",
        close: () => {
          leaseAttempts += 1;
        }
      }
    });

    await expect(runtime.close()).rejects.toThrow(/could not close/u);
    expect(closeAttempts).toBe(1);
    expect(leaseAttempts).toBe(0);

    await expect(runtime.close()).resolves.toBeUndefined();
    expect(closeAttempts).toBe(2);
    expect(leaseAttempts).toBe(1);
  });
});

class DeferredControls implements FactoryControlRepository {
  public constructor(private readonly statePromise: Promise<FactoryAuthorityState>) {}

  public state(): Promise<FactoryAuthorityState> {
    return this.statePromise;
  }

  public record(
    event: CanonicalFactoryDocument<FactoryControlEvent>
  ): Promise<FactoryAuthorityState>;
  public record(
    event: CanonicalFactoryDocument<FactoryControlEvent>,
    expectedEnabled: boolean
  ): Promise<FactoryAuthorityState | null>;
  public async record(
    event: CanonicalFactoryDocument<FactoryControlEvent>,
    expectedEnabled?: boolean
  ): Promise<FactoryAuthorityState | null> {
    void event;
    void expectedEnabled;
    return this.statePromise;
  }

  public history(
    control: FactoryControlName,
    limit: number
  ): Promise<readonly FactoryControlEvent[]> {
    void control;
    void limit;
    return Promise.resolve([]);
  }
}

function createOperator(controls: FactoryControlRepository): FactoryAuthorityOperator {
  return new FactoryAuthorityOperator({
    controls,
    documents: new NodeFactoryDocumentCodec(),
    operatorId: "maintainer",
    now: () => "2026-08-31T12:00:00.000Z",
    createId: () => "0198f005-4ec4-7000-8000-000000000001"
  });
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
