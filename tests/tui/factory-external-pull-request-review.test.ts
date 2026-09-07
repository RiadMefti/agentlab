import type {
  LocalFactoryExternalPullRequestReviewConfig,
  LocalFactoryExternalPullRequestReviewRuntime
} from "@agentlab/runtime/factory-external-pull-request-review";
import { describe, expect, it, vi } from "vitest";

import {
  runFactoryExternalPullRequestReviewPreflight,
  runFactoryExternalPullRequestReviewTick
} from "../../apps/tui/src/run-factory-external-pull-request-review.js";
import { testDigest } from "../helpers/factory.js";

describe("external PR review CLI runner", () => {
  it("runs credentialless preflight and one fully pinned review tick, then closes", async () => {
    const config = {} as LocalFactoryExternalPullRequestReviewConfig;
    const preflight = vi.fn(() => Promise.resolve(preflightReport()));
    const tick = vi.fn(() => Promise.resolve(tickReport()));
    const close = vi.fn(() => Promise.resolve());
    const runtime: LocalFactoryExternalPullRequestReviewRuntime = {
      commands: { preflight, tick },
      close
    };
    const dependencies = {
      loadConfig: vi.fn(() => Promise.resolve(config)),
      createRuntime: vi.fn(() => runtime),
      write: vi.fn()
    };

    await expect(
      runFactoryExternalPullRequestReviewPreflight("/private/pr-reviewer.json", dependencies)
    ).resolves.toBe(0);
    expect(close).toHaveBeenCalledOnce();
    close.mockClear();
    await expect(
      runFactoryExternalPullRequestReviewTick(
        "/private/pr-reviewer.json",
        testDigest("1"),
        testDigest("2"),
        testDigest("3"),
        dependencies
      )
    ).resolves.toBe(0);
    expect(tick).toHaveBeenCalledWith({
      expectedReviewPolicyDigest: testDigest("1"),
      expectedDiscoveryPolicyDigest: testDigest("2"),
      expectedCostPolicyDigest: testDigest("3")
    });
    expect(close).toHaveBeenCalledOnce();
    expect(JSON.parse(String(dependencies.write.mock.calls.at(-1)?.[0]))).toMatchObject({
      status: "completed",
      humanReviewRequired: 1
    });
  });

  it("validates all boundary pins and closes after a command failure", async () => {
    const close = vi.fn(() => Promise.resolve());
    const runtime: LocalFactoryExternalPullRequestReviewRuntime = {
      commands: {
        preflight: () => Promise.reject(new Error("preflight failed")),
        tick: () => Promise.reject(new Error("tick failed"))
      },
      close
    };
    const dependencies = {
      loadConfig: vi.fn(() => Promise.resolve({} as LocalFactoryExternalPullRequestReviewConfig)),
      createRuntime: vi.fn(() => runtime),
      write: vi.fn()
    };
    await expect(
      runFactoryExternalPullRequestReviewTick(
        "/private/pr-reviewer.json",
        "bad",
        testDigest("2"),
        testDigest("3"),
        dependencies
      )
    ).rejects.toThrow(/digest is invalid/u);
    await expect(
      runFactoryExternalPullRequestReviewPreflight("/private/pr-reviewer.json", dependencies)
    ).rejects.toThrow(/preflight failed/u);
    expect(close).toHaveBeenCalledOnce();
  });
});

function preflightReport() {
  return {
    schemaVersion: "agentlab.external-pull-request-review-preflight.v1" as const,
    status: "ready" as const,
    repositoryId: "owner/agentlab",
    reviewPolicyDigest: testDigest("1"),
    discoveryPolicyDigest: testDigest("2"),
    costPolicyDigest: testDigest("3"),
    reviewers: 2,
    reasonCodes: []
  };
}

function tickReport() {
  return {
    schemaVersion: "agentlab.external-pull-request-review-tick-result.v1" as const,
    status: "completed" as const,
    repositoryId: "owner/agentlab",
    reviewPolicyDigest: testDigest("1"),
    inspected: 1,
    completed: 1,
    approved: 0,
    changesRequested: 0,
    humanReviewRequired: 1,
    failed: 0,
    quarantined: 0,
    reasonCodes: [],
    runs: [
      {
        runId: "92000000-0000-4000-8000-000000000001",
        runDigest: testDigest("4"),
        pullRequestNumber: 42,
        status: "completed" as const,
        decision: "human-review-required" as const,
        bundleDigest: testDigest("5"),
        reasonCode: null
      }
    ]
  };
}
