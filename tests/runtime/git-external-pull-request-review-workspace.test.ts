import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileFactoryArtifactStore } from "../../packages/runtime/src/infrastructure/filesystem/file-factory-artifact-store.js";
import { GitExternalPullRequestReviewWorkspaceManager } from "../../packages/runtime/src/infrastructure/filesystem/git-external-pull-request-review-workspace.js";
import { GitFactoryWorkspaceManager } from "../../packages/runtime/src/infrastructure/filesystem/git-factory-workspace.js";
import { NodeCommandRunner } from "../../packages/runtime/src/infrastructure/process/command-runner.js";
import { testExternalPullRequestCandidate } from "../helpers/factory-external-pull-request-discovery.js";

const gitExecutable = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
const flockExecutable = execFileSync("which", ["flock"], { encoding: "utf8" }).trim();
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("GitExternalPullRequestReviewWorkspaceManager", () => {
  it("materializes exact local heads, authenticates paths, emits a patch, and detects mutation", async () => {
    const root = temporaryRoot();
    const repositoryRoot = join(root, "repository");
    git(root, ["init", repositoryRoot]);
    git(repositoryRoot, ["config", "user.name", "AgentLab Test"]);
    git(repositoryRoot, ["config", "user.email", "agentlab@example.invalid"]);
    writeFileSync(join(repositoryRoot, "tracked.txt"), "base\n", "utf8");
    git(repositoryRoot, ["add", "tracked.txt"]);
    git(repositoryRoot, ["commit", "-m", "base"]);
    const baseRevision = git(repositoryRoot, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(repositoryRoot, "tracked.txt"), "review me\n", "utf8");
    git(repositoryRoot, ["commit", "-am", "external change"]);
    const headRevision = git(repositoryRoot, ["rev-parse", "HEAD"]).trim();
    const blobRevision = git(repositoryRoot, ["rev-parse", "HEAD:tracked.txt"]).trim();
    const runner = new NodeCommandRunner();
    const generic = new GitFactoryWorkspaceManager(runner, {
      root: join(root, "workspaces"),
      gitExecutable,
      flockExecutable,
      createId: () => "92000000-0000-4000-8000-000000000009"
    });
    const manager = new GitExternalPullRequestReviewWorkspaceManager(runner, {
      gitExecutable,
      flockExecutable,
      workspaces: generic,
      artifacts: new FileFactoryArtifactStore(join(root, "artifacts"))
    });
    const candidate = testExternalPullRequestCandidate({
      base: { branchName: "main", revision: baseRevision },
      head: {
        repositoryId: "contributor/agentlab",
        branchName: "change",
        revision: headRevision
      },
      changedFiles: [
        {
          path: "tracked.txt",
          previousPath: null,
          status: "modified",
          revision: blobRevision,
          additions: 1,
          deletions: 1,
          changes: 2
        }
      ],
      additions: 1,
      deletions: 1,
      changedLines: 2
    });

    const workspace = await manager.prepare({
      reviewRunId: "92000000-0000-4000-8000-000000000001",
      workspaceId: "92000000-0000-4000-8000-000000000002",
      repositoryRoot,
      candidate,
      maximumPatchBytes: 100_000
    });
    try {
      expect(workspace.patch).toContain("diff --git a/tracked.txt b/tracked.txt");
      await expect(workspace.assertUnchanged()).resolves.toBeUndefined();
      writeFileSync(join(workspace.workspace.root, "tracked.txt"), "mutated\n", "utf8");
      await expect(workspace.assertUnchanged()).rejects.toThrow(/changed-file budget/u);
    } finally {
      await workspace.close();
    }
  });

  it("rejects local object graphs whose path inventory differs from discovery", async () => {
    const root = temporaryRoot();
    const repositoryRoot = join(root, "repository");
    git(root, ["init", repositoryRoot]);
    git(repositoryRoot, ["config", "user.name", "AgentLab Test"]);
    git(repositoryRoot, ["config", "user.email", "agentlab@example.invalid"]);
    writeFileSync(join(repositoryRoot, "actual.txt"), "base\n", "utf8");
    git(repositoryRoot, ["add", "."]);
    git(repositoryRoot, ["commit", "-m", "base"]);
    const baseRevision = git(repositoryRoot, ["rev-parse", "HEAD"]).trim();
    writeFileSync(join(repositoryRoot, "actual.txt"), "changed\n", "utf8");
    git(repositoryRoot, ["commit", "-am", "change"]);
    const headRevision = git(repositoryRoot, ["rev-parse", "HEAD"]).trim();
    const runner = new NodeCommandRunner();
    const manager = new GitExternalPullRequestReviewWorkspaceManager(runner, {
      gitExecutable,
      flockExecutable,
      workspaces: new GitFactoryWorkspaceManager(runner, {
        root: join(root, "workspaces"),
        gitExecutable,
        flockExecutable,
        createId: () => "92000000-0000-4000-8000-000000000010"
      }),
      artifacts: new FileFactoryArtifactStore(join(root, "artifacts"))
    });
    await expect(
      manager.prepare({
        reviewRunId: "92000000-0000-4000-8000-000000000001",
        workspaceId: "92000000-0000-4000-8000-000000000002",
        repositoryRoot,
        candidate: testExternalPullRequestCandidate({
          base: { branchName: "main", revision: baseRevision },
          head: {
            repositoryId: "contributor/agentlab",
            branchName: "change",
            revision: headRevision
          }
        }),
        maximumPatchBytes: 100_000
      })
    ).rejects.toThrow(/path inventory/u);
  });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agentlab-external-pr-review-workspace-"));
  temporaryRoots.push(root);
  return root;
}

function git(cwd: string, args: readonly string[]): string {
  return execFileSync(gitExecutable, args, { cwd, encoding: "utf8" });
}
