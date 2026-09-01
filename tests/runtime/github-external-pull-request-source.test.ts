import { describe, expect, it } from "vitest";

import { GitHubExternalPullRequestSource } from "../../packages/runtime/src/infrastructure/github/github-external-pull-request-source.js";
import type { GitHubReadApi } from "../../packages/runtime/src/infrastructure/github/github-rest-client.js";

describe("GitHubExternalPullRequestSource", () => {
  it("reads one bounded stable PR head and changed-file inventory using GET only", async () => {
    const api = new RecordingReadApi({
      "/repos/owner/agentlab/": {
        id: 99,
        full_name: "Owner/AgentLab",
        default_branch: "main"
      },
      "/repos/owner/agentlab/pulls?state=open&sort=updated&direction=asc&per_page=3": [
        { number: 42 },
        { number: 43 },
        { number: 44 }
      ],
      "/repos/owner/agentlab/pulls/42": pullRequest(),
      "/repos/owner/agentlab/pulls/42/files?per_page=100": [changedFile()]
    });
    const source = new GitHubExternalPullRequestSource({
      repositoryId: "owner/agentlab",
      repositoryNumericId: 99,
      observerId: "github/pr-reader",
      api
    });

    await expect(source.inspectRepository()).resolves.toEqual({
      repositoryId: "owner/agentlab",
      repositoryNumericId: 99,
      defaultBranch: "main"
    });
    const page = await source.listOpen(2);
    expect(page.truncated).toBe(true);
    expect(page.items).toHaveLength(2);
    expect(page.items[0]).toMatchObject({
      pullRequestNumber: 42,
      fromFork: true,
      totalChangedFiles: 1,
      filesComplete: true,
      changedLines: 6,
      author: { association: "contributor" }
    });
    expect(api.requests.map(({ method }) => method)).toEqual(api.requests.map(() => "GET"));
  });

  it("fails closed when a head changes during the bounded read", async () => {
    let detailReads = 0;
    const api: GitHubReadApi = {
      request: (_method, path) => {
        if (path.includes("?state=open")) return Promise.resolve([{ number: 42 }]);
        if (path.endsWith("/files?per_page=100")) return Promise.resolve([changedFile()]);
        detailReads += 1;
        return Promise.resolve(
          pullRequest({
            head: { ...pullRequest().head, sha: (detailReads === 1 ? "b" : "d").repeat(40) }
          })
        );
      }
    };
    const source = new GitHubExternalPullRequestSource({
      repositoryId: "owner/agentlab",
      repositoryNumericId: 99,
      observerId: "github/pr-reader",
      api
    });
    await expect(source.listOpen(1)).rejects.toThrow(/changed during bounded discovery/u);
  });

  it("fails closed when captured PR details change during the bounded read", async () => {
    let detailReads = 0;
    const source = new GitHubExternalPullRequestSource({
      repositoryId: "owner/agentlab",
      repositoryNumericId: 99,
      observerId: "github/pr-reader",
      api: {
        request: (_method, path) => {
          if (path.includes("?state=open")) return Promise.resolve([{ number: 42 }]);
          if (path.endsWith("/files?per_page=100")) return Promise.resolve([changedFile()]);
          detailReads += 1;
          return Promise.resolve(
            pullRequest({ title: detailReads === 1 ? "Fix parser" : "Changed title" })
          );
        }
      }
    });
    await expect(source.listOpen(1)).rejects.toThrow(/changed during bounded discovery/u);
  });

  it("rejects another repository identity during preflight", async () => {
    const source = new GitHubExternalPullRequestSource({
      repositoryId: "owner/agentlab",
      repositoryNumericId: 99,
      observerId: "github/pr-reader",
      api: {
        request: () =>
          Promise.resolve({ id: 100, full_name: "owner/other", default_branch: "main" })
      }
    });
    await expect(source.inspectRepository()).rejects.toThrow(/different repository/u);
  });
});

class RecordingReadApi implements GitHubReadApi {
  public readonly requests: { readonly method: "GET"; readonly path: string }[] = [];
  readonly #responses: Readonly<Record<string, unknown>>;

  public constructor(responses: Readonly<Record<string, unknown>>) {
    this.#responses = responses;
  }

  public request(method: "GET", path: string): Promise<unknown> {
    this.requests.push({ method, path });
    const response = this.#responses[path];
    if (response === undefined) {
      const number = path.includes("/43") ? 43 : null;
      if (number !== null && path.endsWith("/files?per_page=100")) {
        return Promise.resolve([changedFile({ filename: "docs/43.md" })]);
      }
      if (number !== null) {
        return Promise.resolve(
          pullRequest({
            number,
            html_url: `https://github.com/owner/agentlab/pull/${String(number)}`
          })
        );
      }
      return Promise.reject(new Error(`Unexpected request ${path}`));
    }
    return Promise.resolve(response);
  }
}

function pullRequest(overrides: Record<string, unknown> = {}) {
  return {
    number: 42,
    html_url: "https://github.com/owner/agentlab/pull/42",
    title: "Fix parser",
    body: "Untrusted instructions",
    state: "open",
    draft: false,
    merged: false,
    created_at: "2026-08-30T10:00:00Z",
    updated_at: "2026-09-01T11:00:00Z",
    changed_files: 1,
    additions: 4,
    deletions: 2,
    user: { id: 7, login: "contributor", type: "User" },
    author_association: "CONTRIBUTOR",
    base: {
      ref: "main",
      sha: "a".repeat(40),
      repo: { full_name: "owner/agentlab" }
    },
    head: {
      ref: "fix/parser",
      sha: "b".repeat(40),
      repo: { full_name: "contributor/agentlab" }
    },
    ...overrides
  };
}

function changedFile(overrides: Record<string, unknown> = {}) {
  return {
    sha: "c".repeat(40),
    filename: "packages/runtime/src/parser.ts",
    status: "modified",
    additions: 4,
    deletions: 2,
    changes: 6,
    ...overrides
  };
}
