import type {
  LocalFactoryExternalPullRequestReplacementDraftConfig,
  LocalFactoryExternalPullRequestReplacementDraftRuntime
} from "@agentlab/runtime/factory-external-pull-request-replacement-draft";
import { describe, expect, it, vi } from "vitest";

import {
  runFactoryExternalPullRequestReplacementDraftPreflight,
  runFactoryExternalPullRequestReplacementDraftTick
} from "../../apps/tui/src/run-factory-external-pull-request-replacement-draft.js";
import { testDigest } from "../helpers/factory.js";

describe("external PR replacement-draft CLI runner", () => {
  it("runs preflight and exact pinned tick and always closes", async () => {
    const preflight = vi.fn(() =>
      Promise.resolve({
        schemaVersion: "agentlab.external-pull-request-replacement-draft-preflight.v1" as const,
        status: "ready" as const,
        repositoryId: "owner/repo",
        brokerId: "github-app/repair",
        publicationPolicyDigest: testDigest("1"),
        qualificationPolicyDigest: testDigest("2"),
        roleIdentityPolicyDigest: testDigest("3"),
        schedulerEnabled: true,
        prBrokerEnabled: true,
        draftOnly: true as const,
        contributorBranchWrite: false as const,
        forcePush: false as const,
        approval: false as const,
        autoMerge: false as const,
        release: false as const,
        reasonCodes: []
      })
    );
    const tick = vi.fn(() =>
      Promise.resolve({
        schemaVersion: "agentlab.external-pull-request-replacement-draft-tick-result.v1" as const,
        status: "completed" as const,
        repositoryId: "owner/repo",
        publicationPolicyDigest: testDigest("1"),
        inspected: 1,
        completed: 1,
        stale: 0,
        blocked: 0,
        quarantined: 0,
        reasonCodes: [],
        runs: []
      })
    );
    const close = vi.fn(() => Promise.resolve());
    const runtime: LocalFactoryExternalPullRequestReplacementDraftRuntime = {
      commands: { preflight, tick },
      close
    };
    const dependencies = {
      loadConfig: vi.fn(() =>
        Promise.resolve({} as LocalFactoryExternalPullRequestReplacementDraftConfig)
      ),
      createRuntime: vi.fn(() => runtime),
      write: vi.fn()
    };
    await expect(
      runFactoryExternalPullRequestReplacementDraftPreflight(
        "/private/replacement.json",
        dependencies
      )
    ).resolves.toBe(0);
    const pins = {
      expectedPublicationPolicyDigest: testDigest("1"),
      expectedQualificationPolicyDigest: testDigest("2"),
      expectedRoleIdentityPolicyDigest: testDigest("3")
    };
    await expect(
      runFactoryExternalPullRequestReplacementDraftTick(
        "/private/replacement.json",
        pins,
        dependencies
      )
    ).resolves.toBe(0);
    expect(tick).toHaveBeenCalledWith(pins);
    expect(close).toHaveBeenCalledTimes(2);
  });

  it("rejects malformed pins before loading credentials", async () => {
    const dependencies = { loadConfig: vi.fn(), createRuntime: vi.fn(), write: vi.fn() };
    await expect(
      runFactoryExternalPullRequestReplacementDraftTick(
        "/private/replacement.json",
        {
          expectedPublicationPolicyDigest: "bad",
          expectedQualificationPolicyDigest: testDigest("2"),
          expectedRoleIdentityPolicyDigest: testDigest("3")
        },
        dependencies
      )
    ).rejects.toThrow(/exact policy digests/u);
    expect(dependencies.loadConfig).not.toHaveBeenCalled();
  });
});
