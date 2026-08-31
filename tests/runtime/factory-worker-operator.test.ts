import { describe, expect, it, vi } from "vitest";

import { FactoryWorkerOperator } from "../../packages/runtime/src/application/factory-worker-operator.js";

const policyBundleDigest = `sha256:${"a".repeat(64)}` as const;
const gateIds = ["format", "architecture", "typecheck", "lint", "test", "build", "secret-scan"];

describe("FactoryWorkerOperator", () => {
  it("reports autonomous readiness without acquiring authority", async () => {
    const fixture = dependencies({
      scheduler: false,
      costPolicyConfigured: false,
      hostReasonCodes: ["provider-codex-unavailable"]
    });
    const operator = new FactoryWorkerOperator(fixture.value);

    await expect(operator.preflight()).resolves.toEqual({
      schemaVersion: "agentlab.worker-preflight.v1",
      status: "blocked",
      policyBundleDigest,
      schedulerEnabled: false,
      costPolicyConfigured: false,
      hostReady: false,
      configuredProviders: ["claude", "codex"],
      gateIds: [...gateIds].sort(),
      reasonCodes: ["cost-policy-unconfigured", "provider-codex-unavailable", "scheduler-disabled"]
    });
    expect(fixture.controlsState).toHaveBeenCalledOnce();
    expect(fixture.hostInspect).toHaveBeenCalledOnce();
    expect(fixture.mutations).toEqual([]);
  });

  it("fails normal work closed while preserving recovery access", async () => {
    const unpriced = dependencies({ costPolicyConfigured: false });
    const operator = new FactoryWorkerOperator(unpriced.value);

    await expect(operator.advancePreparation({})).rejects.toThrow(/cost policy/u);
    await expect(operator.materializePreparation({})).rejects.toThrow(/cost policy/u);
    await expect(operator.admitExecution({})).rejects.toThrow(/cost policy/u);
    await expect(operator.execute({})).rejects.toThrow(/cost policy/u);
    await expect(operator.executePullRequestRepair({})).rejects.toThrow(/cost policy/u);
    await expect(operator.recoverPreparation({ taskId: "recovery" })).resolves.toBeUndefined();
    await expect(operator.recoverExecution({ taskId: "recovery" })).resolves.toBeUndefined();
    await expect(
      operator.recoverPullRequestRepair({ taskId: "recovery" })
    ).resolves.toBeUndefined();
    expect(unpriced.hostInspect).not.toHaveBeenCalled();
    expect(unpriced.mutations).toEqual([
      "recover-preparation",
      "recover-execution",
      "recover-pr-repair"
    ]);

    const unhealthy = dependencies({ hostReasonCodes: ["systemd-run-identity-unverified"] });
    await expect(new FactoryWorkerOperator(unhealthy.value).execute({})).rejects.toThrow(
      /systemd-run-identity-unverified/u
    );
    expect(unhealthy.mutations).toEqual([]);
  });

  it("allows explicitly invoked authorized work while the autonomous scheduler remains off", async () => {
    const fixture = dependencies({ scheduler: false });
    const operator = new FactoryWorkerOperator(fixture.value);

    await expect(operator.advancePreparation({ taskId: "task" })).resolves.toBeUndefined();
    await expect(operator.materializePreparation({ taskId: "task" })).resolves.toBeUndefined();
    await expect(operator.admitExecution({ taskId: "task" })).resolves.toBeUndefined();
    await expect(operator.execute({ taskId: "task" })).resolves.toBeUndefined();
    await expect(operator.executePullRequestRepair({ taskId: "task" })).resolves.toBeUndefined();
    expect(fixture.mutations).toEqual([
      "advance-preparation",
      "materialize-preparation",
      "admit-execution",
      "execute",
      "execute-pr-repair"
    ]);
  });

  it("rejects an incomplete gate set or duplicate provider binding", () => {
    const fixture = dependencies();
    expect(
      () =>
        new FactoryWorkerOperator({
          ...fixture.value,
          gateIds: gateIds.slice(1)
        })
    ).toThrow(/exact R1 gate set/u);
    expect(
      () =>
        new FactoryWorkerOperator({
          ...fixture.value,
          configuredProviders: ["codex", "codex"]
        })
    ).toThrow(/unique supported IDs/u);
  });
});

function dependencies(
  options: {
    readonly scheduler?: boolean;
    readonly costPolicyConfigured?: boolean;
    readonly hostReasonCodes?: readonly string[];
  } = {}
) {
  const mutations: string[] = [];
  const controlsState = vi.fn(() =>
    Promise.resolve({ scheduler: options.scheduler ?? true, prBroker: false })
  );
  const hostReasonCodes = options.hostReasonCodes ?? [];
  const hostInspect = vi.fn(() =>
    Promise.resolve({
      status: hostReasonCodes.length === 0 ? ("ready" as const) : ("blocked" as const),
      reasonCodes: hostReasonCodes
    })
  );
  const operation = (name: string) => () => {
    mutations.push(name);
    return Promise.resolve(undefined as never);
  };
  return {
    mutations,
    controlsState,
    hostInspect,
    value: {
      policyBundleDigest,
      costPolicyConfigured: options.costPolicyConfigured ?? true,
      configuredProviders: ["codex", "claude"] as const,
      gateIds,
      controls: { state: controlsState },
      host: { inspect: hostInspect },
      preparation: {
        advance: operation("advance-preparation"),
        recover: operation("recover-preparation")
      },
      materializer: { materialize: operation("materialize-preparation") },
      admission: { admit: operation("admit-execution") },
      execution: { execute: operation("execute") },
      executionRecovery: { recover: operation("recover-execution") },
      pullRequestRepair: { execute: operation("execute-pr-repair") },
      pullRequestRepairRecovery: { recover: operation("recover-pr-repair") }
    }
  };
}
