import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  factoryExternalPullRequestReplacementDraftProposalSchema,
  replacementDraftBranchName,
  replacementDraftMarker
} from "@agentlab/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { GitHubExternalPullRequestReplacementDraftBroker } from "../../packages/runtime/src/infrastructure/github/github-external-pull-request-replacement-draft-broker.js";
import {
  GitHubApiError,
  type GitHubRestApi
} from "../../packages/runtime/src/infrastructure/github/github-rest-client.js";
import { NodeFactoryDocumentCodec } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import type {
  CommandRunner,
  RunOptions,
  RunResult
} from "../../packages/runtime/src/infrastructure/process/command-runner.js";
import { NodeCommandRunner } from "../../packages/runtime/src/infrastructure/process/command-runner.js";

const repositoryId = "riadmefti/agentlab";
const gitExecutable = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("GitHubExternalPullRequestReplacementDraftBroker", () => {
  it("publishes a new exact-parent branch and idempotent draft without touching the contributor ref", async () => {
    const fixture = brokerFixture();
    const published = await fixture.broker.publishBranch({
      proposal: fixture.proposal,
      patch: fixture.patch,
      repositoryRoot: fixture.repository
    });
    const opened = await fixture.broker.openDraft({
      proposal: fixture.proposal,
      headRevision: published.headRevision
    });
    const retry = await fixture.broker.openDraft({
      proposal: fixture.proposal,
      headRevision: published.headRevision
    });

    expect(published.created).toBe(true);
    expect(git(fixture.remote, ["rev-parse", `${published.headRevision}^`]).trim()).toBe(
      fixture.headRevision
    );
    expect(fixture.runner.pushArguments).not.toContain("--force");
    expect(fixture.runner.pushArguments.join(" ")).toContain(
      `:refs/heads/${fixture.proposal.branchName}`
    );
    expect(opened).toMatchObject({
      created: true,
      record: { originalPullRequestNumber: 42, replacementPullRequestNumber: 99, draft: true }
    });
    expect(retry.created).toBe(false);
    expect(fixture.api.createdBody).toMatchObject({
      draft: true,
      maintainer_can_modify: false,
      head: fixture.proposal.branchName,
      base: "main"
    });
    await expect(
      fixture.broker.verifyDraft({ proposal: fixture.proposal, record: opened.record })
    ).resolves.toBeUndefined();
  });

  it("fails stale before any branch mutation when the original head moves", async () => {
    const fixture = brokerFixture();
    fixture.api.originalHead = "f".repeat(40);
    await expect(
      fixture.broker.publishBranch({
        proposal: fixture.proposal,
        patch: fixture.patch,
        repositoryRoot: fixture.repository
      })
    ).rejects.toThrow(/moved after repair qualification/u);
    expect(fixture.runner.pushes).toBe(0);
  });

  it("rejects and closes a created draft whose publisher identity is not the pinned App", async () => {
    const fixture = brokerFixture();
    const published = await fixture.broker.publishBranch({
      proposal: fixture.proposal,
      patch: fixture.patch,
      repositoryRoot: fixture.repository
    });
    fixture.api.publisherUserId = 88;
    await expect(
      fixture.broker.openDraft({ proposal: fixture.proposal, headRevision: published.headRevision })
    ).rejects.toThrow(/differs from its durable intent/u);
    expect(fixture.api.closedPullRequests).toBe(1);
  });
});

function brokerFixture() {
  const root = mkdtempSync(join(tmpdir(), "agentlab-replacement-draft-"));
  roots.push(root);
  const repository = join(root, "source");
  const remote = join(root, "remote.git");
  git(root, ["init", "--initial-branch=main", repository]);
  writeFileSync(join(repository, "tracked.txt"), "old\n", "utf8");
  git(repository, ["add", "tracked.txt"]);
  git(repository, [
    "-c",
    "user.name=test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    "base"
  ]);
  const baseRevision = git(repository, ["rev-parse", "HEAD"]).trim();
  writeFileSync(join(repository, "contribution.txt"), "contribution\n", "utf8");
  git(repository, ["add", "contribution.txt"]);
  git(repository, [
    "-c",
    "user.name=test",
    "-c",
    "user.email=test@example.com",
    "commit",
    "-m",
    "contribution"
  ]);
  const headRevision = git(repository, ["rev-parse", "HEAD"]).trim();
  writeFileSync(join(repository, "tracked.txt"), "new\n", "utf8");
  const patch = git(repository, ["diff", "--binary", "--full-index", "--no-ext-diff"]);
  git(repository, ["restore", "tracked.txt"]);
  git(root, ["init", "--bare", remote]);
  // GitHub retains the authenticated PR-head object in the base repository's PR namespace.
  git(repository, ["push", remote, `${headRevision}:refs/pull/42/head`]);
  const qualificationDigest = digest("b");
  const publicationRunId = "97000000-0000-4000-8000-000000000001";
  const runDigest = digest("a");
  const branchName = replacementDraftBranchName(42, qualificationDigest);
  const proposal = factoryExternalPullRequestReplacementDraftProposalSchema.parse({
    schemaVersion: "agentlab.external-pull-request-replacement-draft-proposal.v1",
    publicationRunId,
    runDigest,
    repositoryId,
    originalPullRequestNumber: 42,
    originalPullRequestUrl: "https://github.com/riadmefti/agentlab/pull/42",
    qualificationBundleDigest: qualificationDigest,
    expectedBaseBranch: "main",
    expectedBaseRevision: baseRevision,
    expectedOriginalHeadRevision: headRevision,
    repairedPatchDigest: `sha256:${createHash("sha256").update(patch, "utf8").digest("hex")}`,
    changeSet: {
      baseRevision: headRevision,
      headRevision: null,
      changedPaths: ["tracked.txt"],
      binaryPaths: [],
      changedFiles: 1,
      changedLines: 2
    },
    branchName,
    title: "Qualified repair for external PR #42",
    body: `${replacementDraftMarker(publicationRunId, runDigest)}\n\nEvidence only.`,
    commitTitle: "repair: qualify external PR #42",
    createdAt: "2026-09-01T13:00:00.000Z",
    draft: true,
    maintainerCanModify: false
  });
  const state = { branchHead: null as string | null };
  const runner = new RecordingRunner(remote, branchName, state);
  const api = new FakeApi(baseRevision, headRevision, branchName, state);
  const documents = new NodeFactoryDocumentCodec();
  const broker = new GitHubExternalPullRequestReplacementDraftBroker(runner, {
    repositoryId,
    brokerId: "github-app/external-repair",
    tokenSource: { token: () => Promise.resolve("test-token") },
    api,
    documents,
    gitExecutable,
    temporaryRoot: join(root, "temporary"),
    maximumPatchBytes: 1_048_576,
    publisherUserId: 77,
    trustedStatusChecks: [
      { context: "verify", appId: 15_368 },
      { context: "factory-sandbox", appId: 15_368 }
    ]
  });
  return { api, baseRevision, broker, headRevision, patch, proposal, remote, repository, runner };
}

class RecordingRunner implements CommandRunner {
  readonly #delegate = new NodeCommandRunner();
  public pushes = 0;
  public pushArguments: readonly string[] = [];
  public constructor(
    private readonly remote: string,
    private readonly branch: string,
    private readonly state: { branchHead: string | null }
  ) {}
  public run(
    executable: string,
    args: readonly string[],
    options?: RunOptions
  ): Promise<RunResult> {
    const mapped = args.map((value) =>
      value === `https://github.com/${repositoryId}.git` ? this.remote : value
    );
    if (!args.includes("push")) return this.#delegate.run(executable, mapped, options);
    this.pushes += 1;
    this.pushArguments = args;
    return this.#delegate.run(executable, mapped, options).then((result) => {
      this.state.branchHead = git(this.remote, ["rev-parse", `refs/heads/${this.branch}`]).trim();
      return result;
    });
  }
}

class FakeApi implements GitHubRestApi {
  public originalHead: string;
  public publisherUserId = 77;
  public closedPullRequests = 0;
  public createdBody: unknown = null;
  #replacement: ReturnType<typeof replacementPullRequest> | null = null;
  public constructor(
    private readonly base: string,
    head: string,
    private readonly branch: string,
    private readonly state: { branchHead: string | null }
  ) {
    this.originalHead = head;
  }
  public request(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown
  ): Promise<unknown> {
    if (method === "GET" && path.endsWith("/pulls/42"))
      return Promise.resolve({
        number: 42,
        html_url: "https://github.com/riadmefti/agentlab/pull/42",
        title: "Contributor change",
        body: "Untrusted",
        state: "open",
        draft: false,
        created_at: "2026-09-01T12:00:00Z",
        updated_at: "2026-09-01T12:30:00Z",
        changed_files: 1,
        additions: 1,
        deletions: 0,
        user: { id: 7, login: "contributor", type: "User" },
        author_association: "CONTRIBUTOR",
        base: { ref: "main", sha: this.base, repo: { full_name: repositoryId } },
        head: { ref: "topic", sha: this.originalHead, repo: { full_name: "contributor/agentlab" } }
      });
    if (method === "GET" && path.endsWith("/branches/main/protection"))
      return Promise.resolve({
        required_pull_request_reviews: {
          required_approving_review_count: 1,
          dismiss_stale_reviews: true,
          require_code_owner_reviews: true,
          require_last_push_approval: true
        },
        required_status_checks: {
          checks: [
            { context: "verify", app_id: 15_368 },
            { context: "factory-sandbox", app_id: 15_368 }
          ]
        },
        enforce_admins: { enabled: true },
        allow_force_pushes: { enabled: false },
        allow_deletions: { enabled: false }
      });
    if (method === "GET" && path.includes("/git/ref/heads/")) {
      if (this.state.branchHead === null) return Promise.reject(new GitHubApiError(404, "missing"));
      return Promise.resolve({ object: { sha: this.state.branchHead } });
    }
    if (method === "GET" && path.includes("/pulls?"))
      return Promise.resolve(this.#replacement === null ? [] : [this.#replacement]);
    if (method === "GET" && path.endsWith("/pulls/99"))
      return this.#replacement === null
        ? Promise.reject(new GitHubApiError(404, "missing"))
        : Promise.resolve(this.#replacement);
    if (method === "POST" && path.endsWith("/pulls")) {
      this.createdBody = body;
      this.#replacement = replacementPullRequest(
        this.base,
        required(this.state),
        this.branch,
        body as { title: string; body: string },
        this.publisherUserId
      );
      return Promise.resolve(this.#replacement);
    }
    if (method === "PATCH" && path.endsWith("/pulls/99") && this.#replacement !== null) {
      this.closedPullRequests += 1;
      this.#replacement = { ...this.#replacement, state: "closed" };
      return Promise.resolve(this.#replacement);
    }
    return Promise.reject(new Error(`Unexpected fake request ${method} ${path}`));
  }
}
function replacementPullRequest(
  base: string,
  head: string,
  branch: string,
  body: { title: string; body: string },
  publisherUserId: number
) {
  return {
    number: 99,
    html_url: "https://github.com/riadmefti/agentlab/pull/99",
    title: body.title,
    body: body.body,
    state: "open" as "open" | "closed",
    draft: true,
    created_at: "2026-09-01T13:00:01Z",
    user: { id: publisherUserId, login: "agentlab-external-repair[bot]", type: "Bot" },
    base: { ref: "main", sha: base },
    head: { ref: branch, sha: head }
  };
}
function required(state: { branchHead: string | null }): string {
  if (state.branchHead === null) throw new Error("branch absent");
  return state.branchHead;
}
function digest(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}
function git(cwd: string, args: readonly string[]): string {
  return execFileSync(gitExecutable, [...args], {
    cwd,
    encoding: "utf8",
    env: {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
      PATH: process.env.PATH
    }
  });
}
