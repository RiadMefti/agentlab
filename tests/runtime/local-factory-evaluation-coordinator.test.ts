import { describe, expect, it } from "vitest";

import { LocalFactoryCanaryAuthorityCoordinator } from "../../packages/runtime/src/application/local-factory-canary-authority-coordinator.js";
import { LocalFactoryEvaluatorCoordinator } from "../../packages/runtime/src/application/local-factory-evaluator-coordinator.js";
import { RuntimeRepositoryOwner } from "../../packages/runtime/src/application/runtime-repository-owner.js";
import { RuntimeTaskOwner } from "../../packages/runtime/src/application/runtime-task-owner.js";
import {
  testFactoryCanaryDocuments,
  testFactoryEvalDocuments
} from "../helpers/factory-evaluation.js";

describe("local factory evaluation coordinators", () => {
  it("bounds, serializes, and drains evaluator work before repositories and lease", async () => {
    const evaluation = testFactoryEvalDocuments().snapshot;
    const pending = deferred<typeof evaluation>();
    const events: string[] = [];
    const repositories = new RuntimeRepositoryOwner();
    repositories.track({ close: () => events.push("repository") });
    const runtime = new LocalFactoryEvaluatorCoordinator({
      evaluator: {
        assess: () => pending.promise,
        inspect: () => Promise.resolve(evaluation)
      },
      tasks: new RuntimeTaskOwner(),
      repositories,
      writerLease: { databasePath: "/tmp/evaluator.sqlite", close: () => events.push("lease") },
      maximumQueuedCommands: 1
    });

    const assessing = runtime.commands.assess({});
    await expect(runtime.commands.inspect({})).rejects.toThrow(/queue is full/u);
    const closing = runtime.close();
    await Promise.resolve();
    expect(events).toEqual([]);
    pending.resolve(evaluation);
    await expect(assessing).resolves.toEqual(evaluation);
    await expect(closing).resolves.toBeUndefined();
    expect(events).toEqual(["repository", "lease"]);
  });

  it("drains human canary issuance before releasing its local authority lease", async () => {
    const evaluation = testFactoryEvalDocuments().snapshot;
    const authority = testFactoryCanaryDocuments(evaluation);
    const result = {
      schemaVersion: "agentlab.canary-authority-result.v1" as const,
      status: "authorized" as const,
      approval: authority.approval.value,
      approvalDigest: authority.approval.digest,
      cohort: authority.cohort.value,
      cohortDigest: authority.cohort.digest
    };
    const pending = deferred<typeof result>();
    const events: string[] = [];
    const repositories = new RuntimeRepositoryOwner();
    repositories.track({ close: () => events.push("repository") });
    const runtime = new LocalFactoryCanaryAuthorityCoordinator({
      authority: { authorize: () => pending.promise },
      tasks: new RuntimeTaskOwner(),
      repositories,
      writerLease: { databasePath: "/tmp/canary.sqlite", close: () => events.push("lease") }
    });

    const authorizing = runtime.commands.authorize({});
    const closing = runtime.close();
    await Promise.resolve();
    expect(events).toEqual([]);
    pending.resolve(result);
    await expect(authorizing).resolves.toEqual(result);
    await expect(closing).resolves.toBeUndefined();
    expect(events).toEqual(["repository", "lease"]);
    await expect(runtime.commands.authorize({})).rejects.toThrow(/runtime is closing/u);
  });
});

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
