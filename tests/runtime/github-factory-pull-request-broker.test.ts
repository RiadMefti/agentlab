import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  factoryPullRequestProposalSchema,
  type FactoryPullRequestProposal
} from "@agentlab/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { NodeFactoryDocumentCodec } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import type {
  CommandRunner,
  RunOptions,
  RunResult
} from "../../packages/runtime/src/infrastructure/process/command-runner.js";
import { NodeCommandRunner } from "../../packages/runtime/src/infrastructure/process/command-runner.js";
import { GitHubFactoryPullRequestBroker } from "../../packages/runtime/src/infrastructure/github/github-factory-pull-request-broker.js";
import {
  GitHubApiError,
  type GitHubRestApi
} from "../../packages/runtime/src/infrastructure/github/github-rest-client.js";

const repositoryId = "riadmefti/agentlab";
const taskId = "11111111-1111-4111-8111-111111111111";
const branchName = `agentlab/${"4".repeat(64)}`;
const gitExecutable = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("GitHubFactoryPullRequestBroker", () => {
  it("rechecks governance and creates only the exact draft through a credentialless model boundary", async () => {
    const fixture = brokerFixture();
    const result = await fixture.broker.openDraft({
      proposal: fixture.proposal,
      patch: fixture.patch,
      repositoryRoot: fixture.repository
    });

    expect(result).toMatchObject({
      created: true,
      record: {
        repositoryId,
        branchName,
        baseRevision: fixture.baseRevision,
        draft: true,
        brokerId: "github-app/test",
        createdAt: "2026-08-30T12:00:01.000Z"
      }
    });
    expect(fixture.runner.pushes).toBe(1);
    expect(fixture.runner.pushArguments.join(" ")).not.toContain("test-token");
    expect(fixture.runner.authorizationHeader).toMatch(/^AUTHORIZATION: basic /u);
    expect(fixture.api.createdBody).toMatchObject({
      draft: true,
      maintainer_can_modify: false,
      head: branchName,
      base: "main"
    });
  });

  it("reuses the exact existing draft without another push or PR", async () => {
    const fixture = brokerFixture();
    const input = {
      proposal: fixture.proposal,
      patch: fixture.patch,
      repositoryRoot: fixture.repository
    };
    const first = await fixture.broker.openDraft(input);
    const second = await fixture.broker.openDraft(input);

    expect(first.created).toBe(true);
    expect(second).toMatchObject({ created: false, record: { number: first.record.number } });
    expect(fixture.runner.pushes).toBe(1);
    expect(fixture.api.createdPullRequests).toBe(1);
  });

  it("requires the exact branch and live draft before accepting durable remote evidence", async () => {
    const fixture = brokerFixture();
    const input = {
      proposal: fixture.proposal,
      patch: fixture.patch,
      repositoryRoot: fixture.repository
    };
    const opened = await fixture.broker.openDraft(input);

    await expect(
      fixture.broker.verifyDraft({ proposal: fixture.proposal, record: opened.record })
    ).resolves.toBeUndefined();
    fixture.api.mutatePullRequestTitle();
    await expect(
      fixture.broker.verifyDraft({ proposal: fixture.proposal, record: opened.record })
    ).rejects.toThrow(/no longer matches/u);
  });

  it("does not treat an open PR with a missing broker branch as an idempotent success", async () => {
    const fixture = brokerFixture();
    const input = {
      proposal: fixture.proposal,
      patch: fixture.patch,
      repositoryRoot: fixture.repository
    };
    await fixture.broker.openDraft(input);
    fixture.state.branchHead = null;

    await expect(fixture.broker.openDraft(input)).rejects.toThrow(/does not match/u);
    expect(fixture.runner.pushes).toBe(1);
    expect(fixture.api.createdPullRequests).toBe(1);
  });

  it("resumes an exact branch left by a crash before PR creation without pushing again", async () => {
    const fixture = brokerFixture({ failCreateBeforeRecordOnce: true });
    const input = {
      proposal: fixture.proposal,
      patch: fixture.patch,
      repositoryRoot: fixture.repository
    };

    await expect(fixture.broker.openDraft(input)).rejects.toThrow(/retained for recovery/u);
    await expect(fixture.broker.openDraft(input)).resolves.toMatchObject({
      created: true,
      record: { number: 42 }
    });
    expect(fixture.runner.pushes).toBe(1);
    expect(fixture.api.createdPullRequests).toBe(1);
  });

  it("invalidates the exact credential after a failed push and safely retries", async () => {
    const fixture = brokerFixture({ failPushOnce: true });
    const input = {
      proposal: fixture.proposal,
      patch: fixture.patch,
      repositoryRoot: fixture.repository
    };

    await expect(fixture.broker.openDraft(input)).rejects.toThrow(/Injected push failure/u);
    expect(fixture.tokenSource.invalidations).toEqual([{ repositoryId, token: "test-token" }]);
    expect(fixture.state.branchHead).toBeNull();

    await expect(fixture.broker.openDraft(input)).resolves.toMatchObject({
      created: true,
      record: { number: 42 }
    });
    expect(fixture.runner.pushes).toBe(2);
    expect(fixture.api.createdPullRequests).toBe(1);
  });

  it("reconciles the exact draft when GitHub accepted creation but its response was lost", async () => {
    const fixture = brokerFixture({ loseCreateResponseOnce: true });

    await expect(
      fixture.broker.openDraft({
        proposal: fixture.proposal,
        patch: fixture.patch,
        repositoryRoot: fixture.repository
      })
    ).resolves.toMatchObject({ created: false, record: { number: 42 } });
    expect(fixture.runner.pushes).toBe(1);
    expect(fixture.api.createdPullRequests).toBe(1);
    expect(fixture.api.closedPullRequests).toEqual([]);
    expect(fixture.api.deletedBranches).toEqual([]);
  });

  it("rejects different patch bytes before inspecting or writing the remote", async () => {
    const fixture = brokerFixture();

    await expect(
      fixture.broker.openDraft({
        proposal: fixture.proposal,
        patch: `${fixture.patch}\nunauthorized`,
        repositoryRoot: fixture.repository
      })
    ).rejects.toThrow(/patch bytes do not match/u);
    expect(fixture.api.calls).toHaveLength(0);
    expect(fixture.runner.pushes).toBe(0);
  });

  it("rejects a branch that is not derived from the immutable deduplication key", async () => {
    const fixture = brokerFixture();
    await expect(
      fixture.broker.openDraft({
        proposal: { ...fixture.proposal, branchName: `agentlab/${taskId}` },
        patch: fixture.patch,
        repositoryRoot: fixture.repository
      })
    ).rejects.toThrow(/deduplication key/u);
    expect(fixture.api.calls).toHaveLength(0);
    expect(fixture.runner.pushes).toBe(0);
  });

  it.each(["code-owner review", "factory sandbox", "status-check app binding"] as const)(
    "rejects live governance without required %s",
    async (missingGovernance) => {
      const fixture = brokerFixture({ missingGovernance });

      await expect(
        fixture.broker.openDraft({
          proposal: fixture.proposal,
          patch: fixture.patch,
          repositoryRoot: fixture.repository
        })
      ).rejects.toThrow(/governance weakened/u);
      expect(fixture.runner.pushes).toBe(0);
      expect(fixture.api.createdPullRequests).toBe(0);
    }
  );

  it("closes a mismatched created PR and deletes only its unchanged broker branch", async () => {
    const fixture = brokerFixture({ mismatchedCreatedHead: true });

    await expect(
      fixture.broker.openDraft({
        proposal: fixture.proposal,
        patch: fixture.patch,
        repositoryRoot: fixture.repository
      })
    ).rejects.toThrow(/does not match the exact broker proposal/u);
    expect(fixture.api.closedPullRequests).toEqual([42]);
    expect(fixture.api.deletedBranches).toEqual([branchName]);
  });

  it("reads back the exact broker record before compensating a draft", async () => {
    const fixture = brokerFixture();
    const opened = await fixture.broker.openDraft({
      proposal: fixture.proposal,
      patch: fixture.patch,
      repositoryRoot: fixture.repository
    });

    await expect(
      fixture.broker.closeDraft(
        { ...opened.record, url: "https://github.com/riadmefti/agentlab/pull/999" },
        "Test forged record"
      )
    ).rejects.toThrow(/does not match its broker record/u);
    expect(fixture.api.closedPullRequests).toEqual([]);

    await fixture.broker.closeDraft(opened.record, "Test exact compensation");
    expect(fixture.api.closedPullRequests).toEqual([42]);
    expect(fixture.api.deletedBranches).toEqual([branchName]);
  });

  it("compensates a created PR whose branch identity differs from the proposal", async () => {
    const fixture = brokerFixture({ mismatchedCreatedRef: true });

    await expect(
      fixture.broker.openDraft({
        proposal: fixture.proposal,
        patch: fixture.patch,
        repositoryRoot: fixture.repository
      })
    ).rejects.toThrow(/does not match the exact broker proposal/u);
    expect(fixture.api.closedPullRequests).toEqual([42]);
    expect(fixture.api.deletedBranches).toEqual([branchName]);
  });
});

function brokerFixture(
  options: {
    readonly mismatchedCreatedHead?: boolean;
    readonly mismatchedCreatedRef?: boolean;
    readonly failCreateBeforeRecordOnce?: boolean;
    readonly loseCreateResponseOnce?: boolean;
    readonly failPushOnce?: boolean;
    readonly missingGovernance?:
      "code-owner review" | "factory sandbox" | "status-check app binding";
  } = {}
) {
  const root = mkdtempSync(join(tmpdir(), "agentlab-github-broker-"));
  temporaryRoots.push(root);
  const repository = join(root, "repository");
  git(root, ["init", "--initial-branch=main", repository]);
  git(repository, ["config", "user.name", "AgentLab Test"]);
  git(repository, ["config", "user.email", "agentlab@example.invalid"]);
  writeFileSync(join(repository, "tracked.txt"), "original\n", "utf8");
  git(repository, ["add", "tracked.txt"]);
  git(repository, ["commit", "-m", "initial"]);
  const baseRevision = git(repository, ["rev-parse", "HEAD"]).trim();
  writeFileSync(join(repository, "tracked.txt"), "changed\n", "utf8");
  const patch = git(repository, ["diff", "--binary", "--full-index", "--no-ext-diff"]);
  const proposal = proposalFor(baseRevision, patch);
  const state: RemoteState = { branchHead: null };
  const runner = new RecordingPushRunner(state, options.failPushOnce === true);
  const api = new FakeGitHubApi(baseRevision, state, options);
  const documents = new NodeFactoryDocumentCodec();
  const tokenSource = new RecordingTokenSource();
  const broker = new GitHubFactoryPullRequestBroker(runner, {
    repositoryId,
    brokerId: "github-app/test",
    tokenSource,
    api,
    documents,
    gitExecutable,
    temporaryRoot: join(root, "broker"),
    trustedStatusChecks: [
      { context: "verify", appId: 15_368 },
      { context: "factory-sandbox", appId: 15_368 }
    ]
  });
  return { api, baseRevision, broker, patch, proposal, repository, runner, state, tokenSource };
}

function proposalFor(baseRevision: string, patch: string): FactoryPullRequestProposal {
  const patchDigest = `sha256:${createHash("sha256").update(patch, "utf8").digest("hex")}`;
  return factoryPullRequestProposalSchema.parse({
    schemaVersion: "agentlab.pull-request-proposal.v1",
    taskId,
    contractDigest: digest("1"),
    patchProposalDigest: digest("2"),
    patchArtifactDigest: patchDigest,
    changeSet: {
      baseRevision,
      headRevision: null,
      changedPaths: ["tracked.txt"],
      binaryPaths: [],
      changedFiles: 1,
      changedLines: 2
    },
    policyEvaluationDigest: digest("3"),
    deduplicationKey: digest("4"),
    repositoryId,
    baseRevision,
    baseBranch: "main",
    branchName,
    title: "test: brokered change",
    body: "Exact reviewed proposal.",
    draft: true,
    createdAt: "2026-08-30T12:00:00.000Z"
  });
}

interface RemoteState {
  branchHead: string | null;
}

class RecordingPushRunner implements CommandRunner {
  readonly #delegate = new NodeCommandRunner();
  public pushes = 0;
  public pushArguments: readonly string[] = [];
  public authorizationHeader: string | null = null;
  #failedPush = false;

  public constructor(
    private readonly state: RemoteState,
    private readonly failPushOnce: boolean
  ) {}

  public run(
    executable: string,
    args: readonly string[],
    options?: RunOptions
  ): Promise<RunResult> {
    if (args.includes("push")) {
      this.pushes += 1;
      this.pushArguments = args;
      this.authorizationHeader = options?.environment?.GIT_CONFIG_VALUE_0 ?? null;
      if (this.failPushOnce && !this.#failedPush) {
        this.#failedPush = true;
        return Promise.reject(new Error("Injected push failure."));
      }
      const root = args[args.indexOf("-C") + 1];
      if (root === undefined) throw new Error("Test broker push omitted its workspace.");
      this.state.branchHead = git(root, ["rev-parse", "HEAD"]).trim();
      return Promise.resolve({ stdout: "ok", stderr: "" });
    }
    return this.#delegate.run(executable, args, options);
  }
}

class RecordingTokenSource {
  public readonly invalidations: { readonly repositoryId: string; readonly token: string }[] = [];

  public token(): Promise<string> {
    return Promise.resolve("test-token");
  }

  public invalidate(repository: string, token: string): void {
    this.invalidations.push({ repositoryId: repository, token });
  }
}

class FakeGitHubApi implements GitHubRestApi {
  public readonly calls: string[] = [];
  public readonly closedPullRequests: number[] = [];
  public readonly deletedBranches: string[] = [];
  public createdBody: unknown = null;
  public createdPullRequests = 0;
  #pullRequest: ReturnType<typeof pullRequest> | null = null;

  public constructor(
    private readonly baseRevision: string,
    private readonly state: RemoteState,
    private readonly options: {
      readonly mismatchedCreatedHead?: boolean;
      readonly mismatchedCreatedRef?: boolean;
      readonly failCreateBeforeRecordOnce?: boolean;
      readonly loseCreateResponseOnce?: boolean;
      readonly missingGovernance?:
        "code-owner review" | "factory sandbox" | "status-check app binding";
    }
  ) {}

  #failedCreate = false;
  #lostCreateResponse = false;

  public mutatePullRequestTitle(): void {
    if (this.#pullRequest === null) throw new Error("Fake remote has no pull request to mutate.");
    this.#pullRequest = { ...this.#pullRequest, title: "mutated title" };
  }

  public request(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown
  ): Promise<unknown> {
    this.calls.push(`${method} ${path}`);
    if (method === "GET" && path === `/repos/${repositoryId}`) {
      return Promise.resolve({ default_branch: "main" });
    }
    if (method === "GET" && path.endsWith("/git/ref/heads/main")) {
      return Promise.resolve({ object: { sha: this.baseRevision } });
    }
    if (method === "GET" && path.endsWith("/branches/main/protection")) {
      return Promise.resolve({
        required_pull_request_reviews: {
          required_approving_review_count: 1,
          dismiss_stale_reviews: true,
          require_code_owner_reviews: this.options.missingGovernance !== "code-owner review",
          require_last_push_approval: true
        },
        required_status_checks: {
          checks: [
            {
              context: "verify",
              app_id: this.options.missingGovernance === "status-check app binding" ? 1 : 15_368
            },
            ...(this.options.missingGovernance === "factory sandbox"
              ? []
              : [{ context: "factory-sandbox", app_id: 15_368 }])
          ]
        },
        enforce_admins: { enabled: true },
        allow_force_pushes: { enabled: false },
        allow_deletions: { enabled: false }
      });
    }
    if (method === "GET" && path.includes("/pulls?")) {
      return Promise.resolve(this.#pullRequest === null ? [] : [this.#pullRequest]);
    }
    if (method === "GET" && path.endsWith("/pulls/42")) {
      if (this.#pullRequest === null) return Promise.reject(new GitHubApiError(404, "missing"));
      return Promise.resolve(this.#pullRequest);
    }
    if (method === "GET" && path.includes("/git/ref/heads/agentlab%2F")) {
      if (this.state.branchHead === null) return Promise.reject(new GitHubApiError(404, "missing"));
      return Promise.resolve({ object: { sha: this.state.branchHead } });
    }
    if (method === "POST" && path.endsWith("/pulls")) {
      this.createdBody = body;
      if (this.options.failCreateBeforeRecordOnce === true && !this.#failedCreate) {
        this.#failedCreate = true;
        return Promise.reject(new Error("Injected create request failure."));
      }
      this.createdPullRequests += 1;
      this.#pullRequest = pullRequest(
        this.options.mismatchedCreatedHead === true ? "f".repeat(40) : requiredHead(this.state),
        this.baseRevision,
        "open",
        this.options.mismatchedCreatedRef === true ? "agentlab/other" : branchName
      );
      if (this.options.loseCreateResponseOnce === true && !this.#lostCreateResponse) {
        this.#lostCreateResponse = true;
        return Promise.reject(new Error("Injected lost create response."));
      }
      return Promise.resolve(this.#pullRequest);
    }
    if (method === "PATCH" && path.endsWith("/pulls/42")) {
      this.closedPullRequests.push(42);
      this.#pullRequest = pullRequest(
        requiredHead(this.state),
        this.baseRevision,
        "closed",
        branchName
      );
      return Promise.resolve(this.#pullRequest);
    }
    if (method === "DELETE" && path.includes("/git/refs/heads/agentlab%2F")) {
      this.deletedBranches.push(branchName);
      this.state.branchHead = null;
      return Promise.resolve(null);
    }
    return Promise.reject(new Error(`Unexpected fake GitHub request: ${method} ${path}`));
  }
}

function pullRequest(
  headRevision: string,
  baseRevision: string,
  state: "open" | "closed",
  headRef: string
) {
  return {
    number: 42,
    html_url: "https://github.com/RiadMefti/agentlab/pull/42",
    title: "test: brokered change",
    body: "Exact reviewed proposal.",
    state,
    draft: true,
    created_at: "2026-08-30T12:00:01Z",
    base: { ref: "main", sha: baseRevision },
    head: { ref: headRef, sha: headRevision }
  };
}

function requiredHead(state: RemoteState): string {
  if (state.branchHead === null) throw new Error("Fake remote branch has no head.");
  return state.branchHead;
}

function digest(character: string): string {
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
