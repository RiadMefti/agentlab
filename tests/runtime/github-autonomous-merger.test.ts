import { describe, expect, it, vi } from "vitest";

import { FactoryAutonomousMergeQuarantineError } from "../../packages/runtime/src/domain/factory-autonomous-merge-broker.js";
import { GitHubAutonomousMerger } from "../../packages/runtime/src/infrastructure/github/github-autonomous-merger.js";
import type { GitHubGraphqlApi } from "../../packages/runtime/src/infrastructure/github/github-graphql-client.js";
import {
  TEST_MERGE_BASE_REVISION,
  TEST_MERGE_HEAD_REVISION,
  testFactoryAutonomousMergeAuthorization,
  testFactoryAutonomousMergeRecord,
  testFactoryAutonomousMergeRun,
  testFactoryAutonomousMergePolicy
} from "../helpers/factory-autonomous-merge.js";
import { testDigest } from "../helpers/factory.js";

describe("GitHubAutonomousMerger", () => {
  it("marks the exact draft ready and enqueues it with expectedHeadOid", async () => {
    const authorization = testFactoryAutonomousMergeAuthorization();
    const request = vi
      .fn<GitHubGraphqlApi["request"]>()
      .mockResolvedValueOnce(queryResponse(pullRequest({ isDraft: true })))
      .mockResolvedValueOnce(markReadyResponse(pullRequest({ isDraft: false })))
      .mockResolvedValueOnce(queryResponse(pullRequest({ isDraft: false })))
      .mockResolvedValueOnce(queryResponse(pullRequest({ isDraft: false })))
      .mockResolvedValueOnce({
        data: { enqueuePullRequest: { mergeQueueEntry: { id: "MQE_123" } } }
      })
      .mockResolvedValueOnce(
        queryResponse(pullRequest({ isDraft: false, mergeQueueEntry: { id: "MQE_123" } }))
      );
    const merger = createMerger({ request });

    await expect(merger.markReadyForReview(authorization)).resolves.toMatchObject({
      draft: false,
      headRevision: TEST_MERGE_HEAD_REVISION
    });
    await expect(merger.enqueue(authorization)).resolves.toMatchObject({
      mergeQueueEntryId: "MQE_123",
      created: true
    });

    const enqueueCall = request.mock.calls.find(([query]) => query.includes("Enqueue"));
    expect(enqueueCall?.[1]).toMatchObject({
      input: {
        expectedHeadOid: TEST_MERGE_HEAD_REVISION,
        pullRequestId: "PR_42",
        clientMutationId: authorization.authorizationId
      }
    });
    expect(request.mock.calls.some(([query]) => query.includes("mergePullRequest"))).toBe(false);
  });

  it("quarantines head drift before any remote mutation", async () => {
    const request = vi
      .fn<GitHubGraphqlApi["request"]>()
      .mockResolvedValue(queryResponse(pullRequest({ headRefOid: "c".repeat(40) })));
    const merger = createMerger({ request });

    await expect(
      merger.markReadyForReview(testFactoryAutonomousMergeAuthorization())
    ).rejects.toBeInstanceOf(FactoryAutonomousMergeQuarantineError);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("reconciles an ambiguous enqueue response instead of repeating the effect", async () => {
    const request = vi
      .fn<GitHubGraphqlApi["request"]>()
      .mockResolvedValueOnce(queryResponse(pullRequest({ isDraft: false })))
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockResolvedValueOnce(
        queryResponse(pullRequest({ isDraft: false, mergeQueueEntry: { id: "MQE_456" } }))
      );
    const merger = createMerger({ request });

    await expect(merger.enqueue(testFactoryAutonomousMergeAuthorization())).resolves.toMatchObject({
      mergeQueueEntryId: "MQE_456",
      created: false
    });
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("verifies a completed record against GitHub's merged readback", async () => {
    const authorization = testFactoryAutonomousMergeAuthorization();
    const policy = testFactoryAutonomousMergePolicy();
    const run = testFactoryAutonomousMergeRun({
      policy,
      policyDigest: authorization.mergePolicyDigest,
      authorization,
      authorizationDigest: testDigest("f")
    });
    const record = testFactoryAutonomousMergeRecord({
      run,
      runDigest: testDigest("a"),
      authorizationDigest: testDigest("f")
    });
    const request = vi.fn<GitHubGraphqlApi["request"]>().mockResolvedValue(
      queryResponse(
        pullRequest({
          state: "MERGED",
          isDraft: false,
          merged: true,
          mergedAt: record.mergedAt,
          mergeCommit: { oid: record.mergedRevision },
          mergeQueueEntry: { id: record.mergeQueueEntryId }
        })
      )
    );

    await expect(createMerger({ request }).verifyRecord(authorization, record)).resolves.toBe(
      undefined
    );
  });
});

function createMerger(api: GitHubGraphqlApi) {
  return new GitHubAutonomousMerger({
    repositoryId: "riadmefti/agentlab",
    mergerId: "github-app/agentlab-merger",
    api
  });
}

function pullRequest(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    id: "PR_42",
    number: 42,
    url: "https://github.com/RiadMefti/agentlab/pull/42",
    state: "OPEN",
    isDraft: true,
    merged: false,
    mergedAt: null,
    baseRefOid: TEST_MERGE_BASE_REVISION,
    headRefOid: TEST_MERGE_HEAD_REVISION,
    mergeCommit: null,
    mergeQueueEntry: null,
    ...overrides
  };
}

function queryResponse(pullRequestValue: Readonly<Record<string, unknown>>) {
  return { data: { repository: { pullRequest: pullRequestValue } } };
}

function markReadyResponse(pullRequestValue: Readonly<Record<string, unknown>>) {
  return { data: { markPullRequestReadyForReview: { pullRequest: pullRequestValue } } };
}
