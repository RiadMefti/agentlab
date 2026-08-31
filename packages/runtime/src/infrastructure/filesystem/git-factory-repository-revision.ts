import { lstat, realpath } from "node:fs/promises";

import { gitObjectIdSchema } from "@agentlab/contracts";
import { z } from "zod";

import type { FactoryRepositoryRevisionReader } from "../../domain/factory-repository-revision.js";
import type { CommandRunner } from "../process/command-runner.js";
import {
  FactoryGitCommandRunner,
  type FactoryGitCommandRunnerOptions
} from "./factory-git-command.js";

const repositoryRootSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => !value.includes("\0"));
const maximumGitOutputBytes = 4_096;

/** Resolves HEAD from a canonical Git root through the hardened argument-vector runner. */
export class GitFactoryRepositoryRevisionReader implements FactoryRepositoryRevisionReader {
  readonly #git: FactoryGitCommandRunner;

  public constructor(runner: CommandRunner, options: FactoryGitCommandRunnerOptions) {
    this.#git = new FactoryGitCommandRunner(runner, options);
  }

  public async currentRevision(repositoryRootInput: string) {
    const repositoryRoot = repositoryRootSchema.parse(repositoryRootInput);
    const canonicalRoot = await realpath(repositoryRoot);
    if (canonicalRoot !== repositoryRoot) {
      throw new Error("Factory repository root must be canonical and symlink-free.");
    }
    const metadata = await lstat(canonicalRoot);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("Factory repository root must be a real directory.");
    }
    const topLevel = (
      await this.#git.run(
        canonicalRoot,
        ["rev-parse", "--path-format=absolute", "--show-toplevel"],
        { timeoutMs: 5_000, maxBufferBytes: maximumGitOutputBytes }
      )
    ).stdout.trim();
    if (topLevel !== canonicalRoot) {
      throw new Error("Factory repository root does not match the Git top level.");
    }
    const head = (
      await this.#git.run(canonicalRoot, ["rev-parse", "--verify", "HEAD^{commit}"], {
        timeoutMs: 5_000,
        maxBufferBytes: maximumGitOutputBytes
      })
    ).stdout.trim();
    return gitObjectIdSchema.parse(head);
  }
}
