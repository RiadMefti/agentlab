import type {
  LocalFactoryExternalPullRequestFeedbackConfig,
  LocalFactoryExternalPullRequestFeedbackRuntime
} from "@agentlab/runtime/factory-external-pull-request-feedback";
import { describe, expect, it, vi } from "vitest";

import {
  runFactoryExternalPullRequestFeedbackPreflight,
  runFactoryExternalPullRequestFeedbackTick
} from "../../apps/tui/src/run-factory-external-pull-request-feedback.js";
import { testDigest } from "../helpers/factory.js";

describe("external PR feedback CLI runner", () => {
  it("runs preflight and a fully pinned publication tick, then clears its runtime", async () => {
    const config = {} as LocalFactoryExternalPullRequestFeedbackConfig;
    const preflight = vi.fn(() => Promise.resolve(preflightReport()));
    const tick = vi.fn(() => Promise.resolve(tickReport()));
    const close = vi.fn(() => Promise.resolve());
    const runtime: LocalFactoryExternalPullRequestFeedbackRuntime = {
      commands: { preflight, tick },
      close
    };
    const dependencies = {
      loadConfig: vi.fn(() => Promise.resolve(config)),
      createRuntime: vi.fn(() => runtime),
      write: vi.fn()
    };

    await expect(
      runFactoryExternalPullRequestFeedbackPreflight("/private/pr-feedback.json", dependencies)
    ).resolves.toBe(0);
    expect(close).toHaveBeenCalledOnce();
    close.mockClear();
    await expect(
      runFactoryExternalPullRequestFeedbackTick(
        "/private/pr-feedback.json",
        testDigest("1"),
        testDigest("2"),
        dependencies
      )
    ).resolves.toBe(0);
    expect(tick).toHaveBeenCalledWith({
      expectedFeedbackPolicyDigest: testDigest("1"),
      expectedReviewPolicyDigest: testDigest("2")
    });
    expect(close).toHaveBeenCalledOnce();
    expect(JSON.parse(String(dependencies.write.mock.calls.at(-1)?.[0]))).toMatchObject({
      status: "completed",
      published: 1
    });
  });

  it("validates both policy pins and closes after command failure", async () => {
    const close = vi.fn(() => Promise.resolve());
    const runtime: LocalFactoryExternalPullRequestFeedbackRuntime = {
      commands: {
        preflight: () => Promise.reject(new Error("preflight failed")),
        tick: () => Promise.reject(new Error("tick failed"))
      },
      close
    };
    const dependencies = {
      loadConfig: vi.fn(() => Promise.resolve({} as LocalFactoryExternalPullRequestFeedbackConfig)),
      createRuntime: vi.fn(() => runtime),
      write: vi.fn()
    };
    await expect(
      runFactoryExternalPullRequestFeedbackTick(
        "/private/pr-feedback.json",
        "bad",
        testDigest("2"),
        dependencies
      )
    ).rejects.toThrow(/digest is invalid/u);
    await expect(
      runFactoryExternalPullRequestFeedbackPreflight("/private/pr-feedback.json", dependencies)
    ).rejects.toThrow(/preflight failed/u);
    expect(close).toHaveBeenCalledOnce();
  });
});

function preflightReport() {
  return {
    schemaVersion: "agentlab.external-pull-request-feedback-preflight.v1" as const,
    status: "ready" as const,
    repositoryId: "owner/agentlab",
    repositoryNumericId: 77,
    publisherId: "external-review-feedback-broker",
    publisherUserId: 123_456,
    feedbackPolicyDigest: testDigest("1"),
    reviewPolicyDigest: testDigest("2"),
    authorityEnabled: true,
    reasonCodes: []
  };
}

function tickReport() {
  return {
    schemaVersion: "agentlab.external-pull-request-feedback-tick-result.v1" as const,
    status: "completed" as const,
    repositoryId: "owner/agentlab",
    publisherId: "external-review-feedback-broker",
    feedbackPolicyDigest: testDigest("1"),
    inspected: 1,
    published: 1,
    reconciled: 0,
    skipped: 0,
    attentionRequired: 0,
    failed: 0,
    hasMore: false,
    reasonCodes: [],
    runs: [
      {
        publicationRunId: "93000000-0000-4000-8000-000000000001",
        runDigest: testDigest("3"),
        pullRequestNumber: 42,
        status: "published" as const,
        bundleDigest: testDigest("4"),
        recordDigest: testDigest("5"),
        remoteReviewId: "98765",
        reasonCode: null
      }
    ]
  };
}
