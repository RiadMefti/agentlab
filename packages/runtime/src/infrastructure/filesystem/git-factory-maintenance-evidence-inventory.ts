import {
  gitObjectIdSchema,
  repositoryRelativePathSchema,
  type GitObjectId
} from "@agentlab/contracts";

import type { FactoryMaintenanceEvidenceInventory } from "../../domain/factory-maintenance-evidence-inventory.js";
import type { CommandRunner } from "../process/command-runner.js";
import {
  FactoryGitCommandRunner,
  parseFactoryGitNullList,
  type FactoryGitCommandRunnerOptions
} from "./factory-git-command.js";

const maximumInventoryBytes = 64 * 1_024 * 1_024;

/** Lists only files tracked by the exact discovery base; no working-tree text is trusted. */
export class GitFactoryMaintenanceEvidenceInventory implements FactoryMaintenanceEvidenceInventory {
  readonly #git: FactoryGitCommandRunner;

  public constructor(runner: CommandRunner, options: FactoryGitCommandRunnerOptions) {
    this.#git = new FactoryGitCommandRunner(runner, options);
  }

  public async trackedPaths(repositoryRoot: string, baseRevision: GitObjectId) {
    const revision = gitObjectIdSchema.parse(baseRevision);
    const output = await this.#git.run(
      repositoryRoot,
      ["ls-tree", "-r", "--name-only", "-z", revision, "--"],
      {
        timeoutMs: 60_000,
        maxBufferBytes: maximumInventoryBytes,
        maxCombinedBufferBytes: maximumInventoryBytes
      }
    );
    const paths = parseFactoryGitNullList(output.stdout).map((path) =>
      repositoryRelativePathSchema.parse(path)
    );
    if (new Set(paths).size !== paths.length) {
      throw new Error("Exact Git revision returned duplicate tracked maintenance paths.");
    }
    return new Set(paths);
  }
}
