import { Buffer } from "node:buffer";

import { factoryChangeSetSchema } from "@agentlab/contracts";

import type { FactoryArtifactStore } from "../../domain/factory-artifact-store.js";
import {
  FactoryExternalPullRequestRepairQualificationWorkspaceCleanupUnconfirmedError,
  type FactoryExternalPullRequestRepairQualificationWorkspaceManager
} from "../../domain/factory-external-pull-request-repair-qualification-workspace.js";
import type { FactoryWorkspaceManager } from "../../domain/factory-workspace.js";

/** Rebuilds one exact repaired patch in a detached local worktree without any remote access. */
export class GitExternalPullRequestRepairQualificationWorkspaceManager implements FactoryExternalPullRequestRepairQualificationWorkspaceManager {
  public constructor(
    private readonly workspaces: FactoryWorkspaceManager,
    private readonly artifacts: FactoryArtifactStore
  ) {}

  public async prepare(
    input: Parameters<FactoryExternalPullRequestRepairQualificationWorkspaceManager["prepare"]>[0]
  ) {
    const expectedChangeSet = factoryChangeSetSchema.parse(input.expectedChangeSet);
    const patchBytes = Buffer.byteLength(input.patch, "utf8");
    if (patchBytes < 1 || patchBytes > input.maximumPatchBytes) {
      throw new Error("Qualified external repair patch is empty or exceeds its byte ceiling.");
    }
    const storedPatch = await this.artifacts.putText(input.patch);
    if (storedPatch.digest !== input.expectedPatchDigest || storedPatch.sizeBytes !== patchBytes) {
      throw new Error("Qualified external repair patch changed after durable publication.");
    }
    const workspace = await this.workspaces.create({
      taskId: input.qualificationRunId,
      workspaceId: input.workspaceId,
      attempt: 1,
      repositoryRoot: input.repositoryRoot,
      baseRevision: input.expectedHeadRevision
    });
    try {
      await this.workspaces.apply(workspace, input.patch, input.maximumPatchBytes);
      const observed = await this.workspaces.collect(workspace, {
        maximumChangedFiles: expectedChangeSet.changedFiles,
        maximumChangedLines: expectedChangeSet.changedLines,
        maximumPatchBytes: input.maximumPatchBytes
      });
      await assertSamePatch(this.artifacts, observed.patch, input.expectedPatchDigest);
      if (!sameChangeSet(expectedChangeSet, observed.changeSet)) {
        throw new Error("Reconstructed external repair change set differs from its repair bundle.");
      }
      return {
        workspace,
        patch: observed.patch,
        patchDigest: input.expectedPatchDigest,
        patchArtifact: {
          digest: input.expectedPatchDigest,
          sizeBytes: patchBytes,
          mediaType: "application/vnd.git.patch"
        },
        changeSet: observed.changeSet,
        assertUnchanged: async () => {
          const current = await this.workspaces.collect(workspace, {
            maximumChangedFiles: expectedChangeSet.changedFiles,
            maximumChangedLines: expectedChangeSet.changedLines,
            maximumPatchBytes: input.maximumPatchBytes
          });
          await assertSamePatch(this.artifacts, current.patch, input.expectedPatchDigest);
          if (!sameChangeSet(expectedChangeSet, current.changeSet)) {
            throw new Error("External repair qualification workspace changed after preparation.");
          }
        },
        close: () => workspace.closeAndWait()
      };
    } catch (error: unknown) {
      try {
        await workspace.closeAndWait();
      } catch (cleanupError: unknown) {
        throw new FactoryExternalPullRequestRepairQualificationWorkspaceCleanupUnconfirmedError(
          "External repair qualification workspace cleanup was not confirmed.",
          new AggregateError(
            [error, cleanupError],
            "Qualification preparation and cleanup failed.",
            {
              cause: error
            }
          )
        );
      }
      throw error;
    }
  }
}

async function assertSamePatch(
  artifacts: FactoryArtifactStore,
  patch: string,
  expectedDigest: string
): Promise<void> {
  const stored = await artifacts.putText(patch);
  if (stored.digest !== expectedDigest) {
    throw new Error("External repair qualification patch digest changed in its worktree.");
  }
}

function sameChangeSet(
  left: ReturnType<typeof factoryChangeSetSchema.parse>,
  right: ReturnType<typeof factoryChangeSetSchema.parse>
): boolean {
  return (
    left.baseRevision === right.baseRevision &&
    left.headRevision === right.headRevision &&
    left.changedFiles === right.changedFiles &&
    left.changedLines === right.changedLines &&
    left.changedPaths.join("\0") === right.changedPaths.join("\0") &&
    left.binaryPaths.join("\0") === right.binaryPaths.join("\0")
  );
}
