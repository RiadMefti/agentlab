import type {
  LocalFactoryExternalPullRequestDiscoveryConfig,
  LocalFactoryExternalPullRequestDiscoveryRuntime
} from "@agentlab/runtime/factory-external-pull-request-discovery";
import { describe, expect, it, vi } from "vitest";

import {
  runFactoryExternalPullRequestDiscoveryPreflight,
  runFactoryExternalPullRequestDiscoveryTick
} from "../../apps/tui/src/run-factory-external-pull-request-discovery.js";
import { testDigest } from "../helpers/factory.js";

describe("external PR discovery CLI runner", () => {
  it("runs read-only preflight and one explicitly pinned tick, then closes", async () => {
    const config = {} as LocalFactoryExternalPullRequestDiscoveryConfig;
    const preflight = vi.fn(() => Promise.resolve(preflightReport()));
    const tick = vi.fn(() => Promise.resolve(tickReport()));
    const close = vi.fn(() => Promise.resolve());
    const runtime: LocalFactoryExternalPullRequestDiscoveryRuntime = {
      commands: { preflight, tick },
      close
    };
    const dependencies = {
      loadConfig: vi.fn(() => Promise.resolve(config)),
      createRuntime: vi.fn(() => runtime),
      write: vi.fn()
    };

    await expect(
      runFactoryExternalPullRequestDiscoveryPreflight("/private/pr-reader.json", dependencies)
    ).resolves.toBe(0);
    expect(preflight).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    close.mockClear();

    await expect(
      runFactoryExternalPullRequestDiscoveryTick(
        "/private/pr-reader.json",
        testDigest("1"),
        testDigest("2"),
        dependencies
      )
    ).resolves.toBe(0);
    expect(tick).toHaveBeenCalledWith({
      expectedDiscoveryPolicyDigest: testDigest("1"),
      expectedSchedulePolicyDigest: testDigest("2")
    });
    expect(close).toHaveBeenCalledOnce();
    expect(JSON.parse(String(dependencies.write.mock.calls.at(-1)?.[0]))).toMatchObject({
      status: "completed",
      agentReviewCandidates: 1
    });
  });

  it("validates CLI boundaries and closes after command failure", async () => {
    const close = vi.fn(() => Promise.resolve());
    const runtime: LocalFactoryExternalPullRequestDiscoveryRuntime = {
      commands: {
        preflight: () => Promise.reject(new Error("reader failed")),
        tick: () => Promise.reject(new Error("tick failed"))
      },
      close
    };
    const dependencies = {
      loadConfig: vi.fn(() =>
        Promise.resolve({} as LocalFactoryExternalPullRequestDiscoveryConfig)
      ),
      createRuntime: vi.fn(() => runtime),
      write: vi.fn()
    };
    await expect(
      runFactoryExternalPullRequestDiscoveryPreflight("relative.json", dependencies)
    ).rejects.toThrow(/absolute config path/u);
    await expect(
      runFactoryExternalPullRequestDiscoveryTick(
        "/private/pr-reader.json",
        "bad",
        testDigest("2"),
        dependencies
      )
    ).rejects.toThrow(/digest is invalid/u);
    await expect(
      runFactoryExternalPullRequestDiscoveryPreflight("/private/pr-reader.json", dependencies)
    ).rejects.toThrow(/reader failed/u);
    expect(close).toHaveBeenCalledOnce();
  });
});

function preflightReport() {
  return {
    schemaVersion: "agentlab.external-pull-request-discovery-preflight.v1" as const,
    status: "ready" as const,
    repositoryId: "owner/agentlab",
    repositoryNumericId: 99,
    defaultBranch: "main",
    observerId: "github/pr-reader",
    discoveryPolicyDigest: testDigest("1"),
    schedulePolicyDigest: testDigest("2"),
    reasonCodes: []
  };
}

function tickReport() {
  return {
    schemaVersion: "agentlab.external-pull-request-discovery-tick-result.v1" as const,
    status: "completed" as const,
    repositoryId: "owner/agentlab",
    observerId: "github/pr-reader",
    discoveryPolicyDigest: testDigest("1"),
    schedulePolicyDigest: testDigest("2"),
    scheduledFor: "2026-09-01T12:00:00.000Z",
    runId: "91000000-0000-4000-8000-000000000001",
    runDigest: testDigest("3"),
    snapshotDigest: testDigest("4"),
    pullRequestsInspected: 1,
    agentReviewCandidates: 1,
    humanReviewRequired: 0,
    deferred: 0,
    factoryOwned: 0,
    hasMore: false,
    reasonCodes: []
  };
}
