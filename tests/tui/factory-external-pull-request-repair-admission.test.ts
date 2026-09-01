import type {
  LocalFactoryExternalPullRequestRepairAdmissionConfig,
  LocalFactoryExternalPullRequestRepairAdmissionRuntime
} from "@agentlab/runtime/factory-external-pull-request-repair-admission";
import { describe, expect, it, vi } from "vitest";

import {
  runFactoryExternalPullRequestRepairAdmissionPreflight,
  runFactoryExternalPullRequestRepairAdmissionTick
} from "../../apps/tui/src/run-factory-external-pull-request-repair-admission.js";
import { testDigest } from "../helpers/factory.js";

describe("external PR repair admission CLI runner", () => {
  it("runs preflight and a fully pinned admission tick, then closes", async () => {
    const config = {} as LocalFactoryExternalPullRequestRepairAdmissionConfig;
    const preflight = vi.fn(() => Promise.resolve(preflightReport()));
    const tick = vi.fn(() => Promise.resolve(tickReport()));
    const close = vi.fn(() => Promise.resolve());
    const runtime: LocalFactoryExternalPullRequestRepairAdmissionRuntime = {
      commands: { preflight, tick },
      close
    };
    const dependencies = {
      loadConfig: vi.fn(() => Promise.resolve(config)),
      createRuntime: vi.fn(() => runtime),
      write: vi.fn()
    };
    await expect(
      runFactoryExternalPullRequestRepairAdmissionPreflight(
        "/private/repair-admission.json",
        dependencies
      )
    ).resolves.toBe(0);
    expect(close).toHaveBeenCalledOnce();
    close.mockClear();
    const pins = {
      expectedAdmissionPolicyDigest: testDigest("1"),
      expectedReviewPolicyDigest: testDigest("2"),
      expectedFeedbackPolicyDigest: testDigest("3"),
      expectedRepairExecutionPolicyDigest: testDigest("4"),
      expectedCostPolicyDigest: testDigest("5"),
      expectedRoleIdentityPolicyDigest: testDigest("6"),
      expectedGateProfileDigest: testDigest("7")
    };
    await expect(
      runFactoryExternalPullRequestRepairAdmissionTick(
        "/private/repair-admission.json",
        pins,
        dependencies
      )
    ).resolves.toBe(0);
    expect(tick).toHaveBeenCalledWith(pins);
    expect(close).toHaveBeenCalledOnce();
    expect(JSON.parse(String(dependencies.write.mock.calls.at(-1)?.[0]))).toMatchObject({
      status: "completed",
      authorized: 1
    });
  });

  it("validates every pin before constructing a runtime", async () => {
    const dependencies = {
      loadConfig: vi.fn(),
      createRuntime: vi.fn(),
      write: vi.fn()
    };
    await expect(
      runFactoryExternalPullRequestRepairAdmissionTick(
        "/private/repair-admission.json",
        {
          expectedAdmissionPolicyDigest: "bad",
          expectedReviewPolicyDigest: testDigest("2"),
          expectedFeedbackPolicyDigest: testDigest("3"),
          expectedRepairExecutionPolicyDigest: testDigest("4"),
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
    schemaVersion: "agentlab.external-pull-request-repair-admission-preflight.v1" as const,
    status: "ready" as const,
    repositoryId: "owner/agentlab",
    admissionPolicyDigest: testDigest("1"),
    reviewPolicyDigest: testDigest("2"),
    feedbackPolicyDigest: testDigest("3"),
    repairExecutionPolicyDigest: testDigest("4"),
    costPolicyDigest: testDigest("5"),
    roleIdentityPolicyDigest: testDigest("6"),
    gateProfileDigest: testDigest("7"),
    schedulerEnabled: true,
    remoteWrite: false as const,
    autoMerge: false as const,
    release: false as const,
    reasonCodes: []
  };
}

function tickReport() {
  return {
    schemaVersion: "agentlab.external-pull-request-repair-admission-tick-result.v1" as const,
    status: "completed" as const,
    repositoryId: "owner/agentlab",
    admissionPolicyDigest: testDigest("1"),
    inspected: 1,
    authorized: 1,
    denied: 0,
    existing: 0,
    hasMore: false,
    reasonCodes: [],
    decisions: [
      {
        decisionId: "94000000-0000-4000-8000-000000000001",
        decisionDigest: testDigest("8"),
        authorizationDigest: testDigest("9"),
        bundleDigest: testDigest("a"),
        pullRequestNumber: 42,
        status: "authorized" as const,
        reasonCodes: ["external-repair-authorized"]
      }
    ]
  };
}
