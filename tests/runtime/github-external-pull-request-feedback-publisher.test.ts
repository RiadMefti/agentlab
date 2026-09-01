import { createHash } from "node:crypto";

import type { GitHubRestApi } from "../../packages/runtime/src/infrastructure/github/github-rest-client.js";
import { describe, expect, it, vi } from "vitest";

import { GitHubExternalPullRequestFeedbackPublisher } from "../../packages/runtime/src/infrastructure/github/github-external-pull-request-feedback-publisher.js";

const repositoryId = "owner/agentlab";
const publisherUserId = 123_456;
const baseRevision = "a".repeat(40);
const headRevision = "b".repeat(40);
const marker = `<!-- agentlab-external-review:sha256:${"c".repeat(64)} -->`;
const body = `${marker}\n## AgentLab automated review\n`;
const bodyDigest = digest(body);

describe("GitHubExternalPullRequestFeedbackPublisher", () => {
  it("reconciles the exact publisher marker and submits only a COMMENT review", async () => {
    const api = new RecordingApi();
    const publisher = createPublisher(api);

    await expect(publisher.inspectRepository()).resolves.toEqual({
      repositoryId,
      repositoryNumericId: 77
    });
    await expect(
      publisher.inspect({ pullRequestNumber: 42, headRevision, marker, body, bodyDigest })
    ).resolves.toMatchObject({
      state: "open",
      baseRevision,
      headRevision,
      existingPublication: null
    });
    await expect(
      publisher.publish({ pullRequestNumber: 42, headRevision, marker, body, bodyDigest })
    ).resolves.toMatchObject({
      reviewId: "9001",
      state: "commented",
      headRevision,
      bodyDigest
    });
    expect(api.request).toHaveBeenLastCalledWith(
      "POST",
      `/repos/${repositoryId}/pulls/42/reviews`,
      { body, event: "COMMENT", commit_id: headRevision }
    );

    api.reviews = [reviewResponse()];
    await expect(
      publisher.inspect({ pullRequestNumber: 42, headRevision, marker, body, bodyDigest })
    ).resolves.toMatchObject({ existingPublication: { reviewId: "9001" } });
  });

  it("rejects a copied or conflicting marker instead of duplicating feedback", async () => {
    const api = new RecordingApi();
    const publisher = createPublisher(api);
    api.reviews = [reviewResponse({ body: `${body}changed` })];
    await expect(
      publisher.inspect({ pullRequestNumber: 42, headRevision, marker, body, bodyDigest })
    ).rejects.toThrow(/conflicting AgentLab feedback/u);

    api.reviews = [reviewResponse(), reviewResponse({ id: 9002 })];
    await expect(
      publisher.inspect({ pullRequestNumber: 42, headRevision, marker, body, bodyDigest })
    ).rejects.toThrow(/duplicate/u);
    await expect(
      publisher.publish({
        pullRequestNumber: 42,
        headRevision,
        marker,
        body: `${body}tampered`,
        bodyDigest
      })
    ).rejects.toThrow(/digest boundary/u);
  });
});

class RecordingApi implements GitHubRestApi {
  public reviews: unknown[] = [];
  public readonly request = vi.fn(
    (method: "GET" | "POST" | "PATCH" | "DELETE", path: string, requestBody?: unknown) => {
      if (path === `/repos/${repositoryId}/`) {
        return Promise.resolve({ id: 77, full_name: repositoryId, default_branch: "main" });
      }
      if (path === `/repos/${repositoryId}/pulls/42`) return Promise.resolve(pullRequest());
      if (path.endsWith("/reviews?per_page=100")) return Promise.resolve(this.reviews);
      if (method === "POST" && path.endsWith("/reviews")) {
        expect(requestBody).toEqual({ body, event: "COMMENT", commit_id: headRevision });
        return Promise.resolve(reviewResponse());
      }
      throw new Error(`Unexpected GitHub request ${method} ${path}.`);
    }
  );
}

function createPublisher(api: GitHubRestApi) {
  return new GitHubExternalPullRequestFeedbackPublisher({
    repositoryId,
    repositoryNumericId: 77,
    publisherId: "external-review-feedback-broker",
    publisherUserId,
    api
  });
}

function pullRequest() {
  return {
    number: 42,
    html_url: `https://github.com/${repositoryId}/pull/42`,
    title: "A change",
    body: "Description",
    state: "open",
    draft: false,
    merged: false,
    created_at: "2026-09-01T10:00:00.000Z",
    base: { ref: "main", sha: baseRevision },
    head: { ref: "contributor/change", sha: headRevision }
  };
}

function reviewResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: 9001,
    user: { id: publisherUserId, login: "agentlab-reviewer[bot]", type: "Bot" },
    author_association: "NONE",
    state: "COMMENTED",
    body,
    commit_id: headRevision,
    submitted_at: "2026-09-01T12:20:00.000Z",
    html_url: `https://github.com/${repositoryId}/pull/42#pullrequestreview-9001`,
    ...overrides
  };
}

function digest(value: string) {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}` as const;
}
