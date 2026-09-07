import type {
  LocalFactoryExternalPullRequestRepairQualificationConfig,
  LocalFactoryExternalPullRequestRepairQualificationRuntime
} from "@agentlab/runtime/factory-external-pull-request-repair-qualification";
import { describe, expect, it, vi } from "vitest";

import {
  runFactoryExternalPullRequestRepairQualificationPreflight,
  runFactoryExternalPullRequestRepairQualificationTick
} from "../../apps/tui/src/run-factory-external-pull-request-repair-qualification.js";
import { testDigest } from "../helpers/factory.js";

describe("external PR repair qualification CLI runner", () => {
  it("runs preflight and a fully pinned tick, then closes", async () => {
    const config = {} as LocalFactoryExternalPullRequestRepairQualificationConfig;
    const preflight = vi.fn(() => Promise.resolve(preflightReport()));
    const tick = vi.fn(() => Promise.resolve(tickReport()));
    const close = vi.fn(() => Promise.resolve());
    const runtime: LocalFactoryExternalPullRequestRepairQualificationRuntime = {
      commands: { preflight, tick },
      close
    };
    const dependencies = {
      loadConfig: vi.fn(() => Promise.resolve(config)),
      createRuntime: vi.fn(() => runtime),
      write: vi.fn()
    };

    await expect(
      runFactoryExternalPullRequestRepairQualificationPreflight(
        "/private/repair-qualification.json",
        dependencies
      )
    ).resolves.toBe(0);
    expect(close).toHaveBeenCalledOnce();
    close.mockClear();
    const pins = {
      expectedQualificationPolicyDigest: testDigest("1"),
      expectedRepairExecutionPolicyDigest: testDigest("2"),
      expectedCostPolicyDigest: testDigest("3"),
      expectedRoleIdentityPolicyDigest: testDigest("4"),
      expectedGateProfileDigest: testDigest("5")
    };
    await expect(
      runFactoryExternalPullRequestRepairQualificationTick(
        "/private/repair-qualification.json",
        pins,
        dependencies
      )
    ).resolves.toBe(0);
    expect(tick).toHaveBeenCalledWith(pins);
    expect(close).toHaveBeenCalledOnce();
    expect(JSON.parse(String(dependencies.write.mock.calls.at(-1)?.[0]))).toMatchObject({
      status: "completed",
      qualified: 1
    });
  });

  it("validates every pin before constructing a runtime", async () => {
    const dependencies = { loadConfig: vi.fn(), createRuntime: vi.fn(), write: vi.fn() };
    await expect(
      runFactoryExternalPullRequestRepairQualificationTick(
        "/private/repair-qualification.json",
        {
          expectedQualificationPolicyDigest: "bad",
          expectedRepairExecutionPolicyDigest: testDigest("2"),
          expectedCostPolicyDigest: testDigest("3"),
          expectedRoleIdentityPolicyDigest: testDigest("4"),
          expectedGateProfileDigest: testDigest("5")
        },
        dependencies
      )
    ).rejects.toThrow(/invalid/u);
    expect(dependencies.loadConfig).not.toHaveBeenCalled();
  });
});

function preflightReport() {
  return {
    schemaVersion: "agentlab.external-pull-request-repair-qualification-preflight.v1" as const,
    status: "ready" as const,
    repositoryId: "owner/agentlab",
    qualificationPolicyDigest: testDigest("1"),
    repairExecutionPolicyDigest: testDigest("2"),
    costPolicyDigest: testDigest("3"),
    roleIdentityPolicyDigest: testDigest("4"),
    gateProfileDigest: testDigest("5"),
    gateIds: ["format", "architecture", "typecheck", "lint", "test", "build", "secret-scan"],
    reviewers: 1,
    schedulerEnabled: true,
    remoteWrite: false as const,
    autoMerge: false as const,
    release: false as const,
    reasonCodes: []
  };
}

function tickReport() {
  return {
    schemaVersion: "agentlab.external-pull-request-repair-qualification-tick-result.v1" as const,
    status: "completed" as const,
    repositoryId: "owner/agentlab",
    qualificationPolicyDigest: testDigest("1"),
    inspected: 1,
    completed: 1,
    qualified: 1,
    rejected: 0,
    humanReviewRequired: 0,
    failed: 0,
    quarantined: 0,
    reasonCodes: [],
    runs: [
      {
        qualificationRunId: "96000000-0000-4000-8000-000000000001",
        runDigest: testDigest("6"),
        repairBundleDigest: testDigest("7"),
        pullRequestNumber: 42,
        status: "completed" as const,
        decision: "qualified" as const,
        qualificationBundleDigest: testDigest("8"),
        reasonCode: null
      }
    ]
  };
}
