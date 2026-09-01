import {
  FactoryExternalPullRequestRepairWorkspaceCleanupUnconfirmedError,
  type FactoryExternalPullRequestRepairWorkspaceManager
} from "../../domain/factory-external-pull-request-repair-workspace.js";
import type { FactoryWorkspaceManager } from "../../domain/factory-workspace.js";
import type { GitExternalPullRequestReviewWorkspaceManager } from "./git-external-pull-request-review-workspace.js";

/** Reuses exact local-object authentication, then exposes only the isolated worktree for repair. */
export class GitExternalPullRequestRepairWorkspaceManager implements FactoryExternalPullRequestRepairWorkspaceManager {
  public constructor(
    private readonly source: GitExternalPullRequestReviewWorkspaceManager,
    private readonly workspaces: FactoryWorkspaceManager
  ) {}

  public async prepare(
    input: Parameters<FactoryExternalPullRequestRepairWorkspaceManager["prepare"]>[0]
  ) {
    let prepared: Awaited<ReturnType<GitExternalPullRequestReviewWorkspaceManager["prepare"]>>;
    try {
      prepared = await this.source.prepare({
        reviewRunId: input.repairRunId,
        workspaceId: input.workspaceId,
        repositoryRoot: input.repositoryRoot,
        candidate: input.candidate,
        maximumPatchBytes: input.maximumPatchBytes
      });
    } catch (error: unknown) {
      if (error instanceof AggregateError) {
        throw new FactoryExternalPullRequestRepairWorkspaceCleanupUnconfirmedError(
          "External repair workspace preparation cleanup was not confirmed.",
          error
        );
      }
      throw error;
    }
    if (prepared.patchDigest !== input.expectedPatchDigest) {
      try {
        await prepared.close();
      } catch (error: unknown) {
        throw new FactoryExternalPullRequestRepairWorkspaceCleanupUnconfirmedError(
          "Mismatched external repair workspace cleanup was not confirmed.",
          error
        );
      }
      throw new Error("Local external PR patch does not match the admitted review evidence.");
    }
    return {
      workspace: prepared.workspace,
      sourcePatch: prepared.patch,
      sourcePatchDigest: prepared.patchDigest,
      sourcePatchArtifact: prepared.patchArtifact,
      close: () => prepared.close()
    };
  }

  public collect(...input: Parameters<FactoryWorkspaceManager["collect"]>) {
    return this.workspaces.collect(...input);
  }
}
