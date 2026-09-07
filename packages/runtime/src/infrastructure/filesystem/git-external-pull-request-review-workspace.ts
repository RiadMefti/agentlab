import { Buffer } from "node:buffer";

import {
  factoryExternalPullRequestCandidateSchema,
  gitObjectIdSchema,
  repositoryRelativePathSchema
} from "@agentlab/contracts";
import { z } from "zod";

import type { FactoryArtifactStore } from "../../domain/factory-artifact-store.js";
import type {
  FactoryExternalPullRequestReviewWorkspace,
  FactoryExternalPullRequestReviewWorkspaceManager
} from "../../domain/factory-external-pull-request-review-workspace.js";
import type { FactoryWorkspaceManager } from "../../domain/factory-workspace.js";
import type { CommandRunner } from "../process/command-runner.js";
import { FactoryGitCommandRunner, parseFactoryGitNullList } from "./factory-git-command.js";

const inputSchema = z
  .object({
    reviewRunId: z.uuid(),
    workspaceId: z.uuid(),
    repositoryRoot: z
      .string()
      .min(1)
      .max(4_096)
      .refine((value) => !value.includes("\0")),
    candidate: factoryExternalPullRequestCandidateSchema,
    maximumPatchBytes: z
      .number()
      .int()
      .min(1)
      .max(8 * 1_024 * 1_024)
  })
  .strict();

export interface GitExternalPullRequestReviewWorkspaceManagerOptions {
  readonly gitExecutable: string;
  readonly flockExecutable: string;
  readonly workspaces: FactoryWorkspaceManager;
  readonly artifacts: FactoryArtifactStore;
}

/** Exact local-object PR materialization. This adapter has no remote or credential capability. */
export class GitExternalPullRequestReviewWorkspaceManager implements FactoryExternalPullRequestReviewWorkspaceManager {
  readonly #git: FactoryGitCommandRunner;
  readonly #workspaces: FactoryWorkspaceManager;
  readonly #artifacts: FactoryArtifactStore;

  public constructor(
    runner: CommandRunner,
    options: GitExternalPullRequestReviewWorkspaceManagerOptions
  ) {
    this.#git = new FactoryGitCommandRunner(runner, options);
    this.#workspaces = options.workspaces;
    this.#artifacts = options.artifacts;
  }

  public async prepare(inputValue: unknown): Promise<FactoryExternalPullRequestReviewWorkspace> {
    const input = inputSchema.parse(inputValue);
    const workspace = await this.#workspaces.create({
      taskId: input.reviewRunId,
      workspaceId: input.workspaceId,
      attempt: 1,
      repositoryRoot: input.repositoryRoot,
      baseRevision: input.candidate.head.revision
    });
    try {
      const mergeBase = gitObjectIdSchema.parse(
        (
          await this.#run(workspace.root, [
            "merge-base",
            input.candidate.base.revision,
            input.candidate.head.revision
          ])
        ).stdout.trim()
      );
      const paths = parseFactoryGitNullList(
        (
          await this.#run(
            workspace.root,
            [
              "diff",
              "--name-only",
              "-z",
              "--find-renames=50%",
              mergeBase,
              input.candidate.head.revision,
              "--"
            ],
            4 * 1_024 * 1_024
          )
        ).stdout
      ).map((path) => repositoryRelativePathSchema.parse(path));
      const expectedPaths = input.candidate.changedFiles.map(({ path }) => path);
      if (!sameSet(paths, expectedPaths)) {
        throw new Error("Local Git objects disagree with the authenticated PR path inventory.");
      }
      const patch = (
        await this.#run(
          workspace.root,
          [
            "diff",
            "--binary",
            "--full-index",
            "--find-renames=50%",
            "--no-ext-diff",
            mergeBase,
            input.candidate.head.revision,
            "--"
          ],
          input.maximumPatchBytes
        )
      ).stdout;
      const patchBytes = Buffer.byteLength(patch, "utf8");
      if (patchBytes < 1 || patchBytes > input.maximumPatchBytes) {
        throw new Error("External PR patch is empty or exceeds its reviewed byte ceiling.");
      }
      const stored = await this.#artifacts.putText(patch);
      if (stored.sizeBytes !== patchBytes) {
        throw new Error("External PR patch artifact changed during publication.");
      }
      const assertUnchanged = async (): Promise<void> => {
        const observed = await this.#workspaces.collect(workspace, {
          maximumChangedFiles: 0,
          maximumChangedLines: 0,
          maximumPatchBytes: 1
        });
        if (observed.patch !== "" || observed.changeSet.changedFiles !== 0) {
          throw new Error("External PR reviewer changed its read-only workspace.");
        }
      };
      return {
        workspace,
        patch,
        patchDigest: stored.digest,
        patchArtifact: {
          digest: stored.digest,
          sizeBytes: stored.sizeBytes,
          mediaType: "application/vnd.git.patch"
        },
        assertUnchanged,
        close: () => workspace.closeAndWait()
      };
    } catch (error: unknown) {
      try {
        await workspace.closeAndWait();
      } catch (cleanupError: unknown) {
        throw new AggregateError(
          [error, cleanupError],
          "External PR workspace preparation and cleanup failed.",
          { cause: error }
        );
      }
      throw error;
    }
  }

  #run(root: string, args: readonly string[], maxBufferBytes = 64 * 1_024) {
    return this.#git.run(root, args, {
      timeoutMs: 60_000,
      maxBufferBytes,
      maxCombinedBufferBytes: maxBufferBytes
    });
  }
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return (
    left.length === right.length &&
    new Set(left).size === left.length &&
    left.every((path) => right.includes(path))
  );
}
