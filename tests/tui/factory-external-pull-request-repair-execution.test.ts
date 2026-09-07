import type {
  LocalFactoryExternalPullRequestRepairExecutionConfig,
  LocalFactoryExternalPullRequestRepairExecutionRuntime
} from "@agentlab/runtime/factory-external-pull-request-repair-execution";
import { describe, expect, it, vi } from "vitest";

import {
  runFactoryExternalPullRequestRepairExecutionPreflight,
  runFactoryExternalPullRequestRepairExecutionTick
} from "../../apps/tui/src/run-factory-external-pull-request-repair-execution.js";
import { testDigest } from "../helpers/factory.js";

describe("external PR repair execution CLI runner", () => {
  it("runs preflight and a fully pinned tick, then closes", async () => {
    const config = {} as LocalFactoryExternalPullRequestRepairExecutionConfig;
    const preflight = vi.fn(() => Promise.resolve(preflightReport()));
    const tick = vi.fn(() => Promise.resolve(tickReport()));
    const close = vi.fn(() => Promise.resolve());
    const runtime: LocalFactoryExternalPullRequestRepairExecutionRuntime = {
      commands: { preflight, tick },
      close
    };
    const dependencies = {
      loadConfig: vi.fn(() => Promise.resolve(config)),
      createRuntime: vi.fn(() => runtime),
      write: vi.fn()
    };

    await expect(
      runFactoryExternalPullRequestRepairExecutionPreflight(
        "/private/repair-execution.json",
        dependencies
      )
    ).resolves.toBe(0);
    expect(close).toHaveBeenCalledOnce();
    close.mockClear();
    const pins = {
      expectedRepairExecutionPolicyDigest: testDigest("1"),
      expectedAdmissionPolicyDigest: testDigest("2"),
      expectedReviewPolicyDigest: testDigest("3"),
      expectedFeedbackPolicyDigest: testDigest("4"),
      expectedCostPolicyDigest: testDigest("5"),
      expectedRoleIdentityPolicyDigest: testDigest("6"),
      expectedGateProfileDigest: testDigest("7")
    };
    await expect(
      runFactoryExternalPullRequestRepairExecutionTick(
        "/private/repair-execution.json",
        pins,
        dependencies
      )
    ).resolves.toBe(0);
    expect(tick).toHaveBeenCalledWith(pins);
    expect(close).toHaveBeenCalledOnce();
    expect(JSON.parse(String(dependencies.write.mock.calls.at(-1)?.[0]))).toMatchObject({
      status: "completed",
      completed: 1
    });
  });

  it("validates every pin before constructing a runtime", async () => {
    const dependencies = {
      loadConfig: vi.fn(),
      createRuntime: vi.fn(),
      write: vi.fn()
    };
    await expect(
      runFactoryExternalPullRequestRepairExecutionTick(
        "/private/repair-execution.json",
        {
          expectedRepairExecutionPolicyDigest: "bad",
          expectedAdmissionPolicyDigest: testDigest("2"),
          expectedReviewPolicyDigest: testDigest("3"),
          expectedFeedbackPolicyDigest: testDigest("4"),
          expectedCostPolicyDigest: testDigest("5"),
          expectedRoleIdentityPolicyDigest: testDigest("6"),
          expectedGateProfileDigest: testDigest("7")
        },
        dependencies
      )
    ).rejects.toThrow(/invalid/u);
    expect(dependencies.loadConfig).not.toHaveBeenCalled();
  });
});

function preflightReport() {
  return {
    schemaVersion: "agentlab.external-pull-request-repair-execution-preflight.v1" as const,
    status: "ready" as const,
    repositoryId: "owner/agentlab",
    repairExecutionPolicyDigest: testDigest("1"),
    admissionPolicyDigest: testDigest("2"),
    costPolicyDigest: testDigest("5"),
    roleIdentityPolicyDigest: testDigest("6"),
    gateProfileDigest: testDigest("7"),
    provider: "codex",
    schedulerEnabled: true,
    repairAttempts: 1 as const,
    remoteWrite: false as const,
    autoMerge: false as const,
    release: false as const,
    reasonCodes: []
  };
}

function tickReport() {
  return {
    schemaVersion: "agentlab.external-pull-request-repair-execution-tick-result.v1" as const,
    status: "completed" as const,
    repositoryId: "owner/agentlab",
    repairExecutionPolicyDigest: testDigest("1"),
    inspected: 1,
    completed: 1,
    failed: 0,
    quarantined: 0,
    reasonCodes: [],
    runs: [
      {
        runId: "95000000-0000-4000-8000-000000000001",
        runDigest: testDigest("8"),
        authorizationDigest: testDigest("9"),
        pullRequestNumber: 42,
        status: "completed" as const,
        bundleDigest: testDigest("a"),
        patchDigest: testDigest("b"),
        reasonCode: null
      }
    ]
  };
}
