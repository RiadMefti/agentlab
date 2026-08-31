import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";

import {
  factoryChangeSetSchema,
  gitObjectIdSchema,
  repositoryRelativePathSchema
} from "@agentlab/contracts";
import { z } from "zod";

import type { ManagedRuntimeResourceOwner } from "../../domain/runtime-resource.js";
import type {
  CollectFactoryWorkspaceInput,
  CreateFactoryWorkspaceInput,
  FactoryWorkspace,
  FactoryWorkspaceManager,
  FactoryWorkspacePatch
} from "../../domain/factory-workspace.js";
import type { CommandRunner } from "../process/command-runner.js";
import { FactoryGitCommandRunner, parseFactoryGitNullList } from "./factory-git-command.js";
import {
  factoryPathWithin,
  factoryPathsOverlap,
  factoryWorkspaceTarget,
  prepareFactoryWorkspaceRoot,
  prepareFactoryWorkspaceTaskDirectory,
  resolveFactoryWorkspaceRoot
} from "./factory-workspace-paths.js";

const createInputSchema = z
  .object({
    taskId: z.uuid(),
    attempt: z.number().int().min(1).max(20),
    repositoryRoot: z
      .string()
      .min(1)
      .max(4_096)
      .refine((value) => !value.includes("\0")),
    baseRevision: gitObjectIdSchema,
    workspaceId: z.uuid().optional()
  })
  .strict();

const collectInputSchema = z
  .object({
    maximumChangedFiles: z.number().int().min(0).max(10_000),
    maximumChangedLines: z.number().int().min(0).max(1_000_000),
    maximumPatchBytes: z.number().int().min(1).max(1_073_741_824)
  })
  .strict();

const maximumGitInventoryBytes = 64 * 1_024 * 1_024;
const maximumAttributeArgumentCount = 128;

interface OwnedWorkspace {
  readonly handle: ManagedGitFactoryWorkspace;
  readonly commonGitDirectory: string;
  readonly lockDirectory: string;
}

export interface GitFactoryWorkspaceManagerOptions {
  readonly root: string;
  readonly gitExecutable: string;
  readonly flockExecutable: string;
  readonly createId: () => string;
  readonly resourceOwner?: ManagedRuntimeResourceOwner;
}

/** Exact-base detached Git worktrees with bounded patch capture and owned cleanup. */
export class GitFactoryWorkspaceManager implements FactoryWorkspaceManager {
  readonly #git: FactoryGitCommandRunner;
  readonly #createId: () => string;
  readonly #resourceOwner: ManagedRuntimeResourceOwner | undefined;
  readonly #rootPath: string;
  #root: Promise<string> | null = null;
  readonly #owned = new Map<string, OwnedWorkspace>();

  public constructor(runner: CommandRunner, options: GitFactoryWorkspaceManagerOptions) {
    this.#git = new FactoryGitCommandRunner(runner, options);
    this.#createId = options.createId;
    this.#resourceOwner = options.resourceOwner;
    this.#rootPath = resolveFactoryWorkspaceRoot(options.root);
  }

  public async create(input: CreateFactoryWorkspaceInput): Promise<FactoryWorkspace> {
    const parsed = createInputSchema.parse(input);
    const factoryRoot = await this.#factoryRoot();
    const repositoryRoot = await canonicalDirectory(parsed.repositoryRoot);
    if (factoryPathsOverlap(factoryRoot, repositoryRoot)) {
      throw new Error(
        "Factory worktree storage and source repository must not contain each other."
      );
    }
    const topLevel = (
      await this.#runGit(repositoryRoot, ["rev-parse", "--path-format=absolute", "--show-toplevel"])
    ).stdout.trim();
    if ((await realpath(topLevel)) !== repositoryRoot) {
      throw new Error("Factory workspace source must be the canonical Git repository root.");
    }
    const resolvedBase = (
      await this.#runGit(repositoryRoot, [
        "rev-parse",
        "--verify",
        `${parsed.baseRevision}^{commit}`
      ])
    ).stdout.trim();
    if (resolvedBase !== parsed.baseRevision) {
      throw new Error("Factory workspace base revision did not resolve exactly.");
    }

    const id = parsed.workspaceId ?? z.uuid().parse(this.#createId());
    const taskDirectory = await prepareFactoryWorkspaceTaskDirectory(factoryRoot, parsed.taskId);
    const target = factoryWorkspaceTarget(factoryRoot, {
      taskId: parsed.taskId,
      attempt: parsed.attempt,
      workspaceId: id
    });
    await assertAbsent(target);
    let created = false;
    try {
      await this.#runGit(
        repositoryRoot,
        ["worktree", "add", "--detach", "--no-checkout", target, parsed.baseRevision],
        { lockDirectory: taskDirectory }
      );
      created = true;
      const canonicalTarget = await canonicalDirectory(target);
      if (canonicalTarget !== target) throw new Error("Git worktree path is not canonical.");
      await this.#runGit(canonicalTarget, ["read-tree", "--reset", parsed.baseRevision], {
        lockDirectory: taskDirectory
      });
      await this.#rejectCheckoutFilters(canonicalTarget, taskDirectory);
      await this.#runGit(
        canonicalTarget,
        ["checkout", "--force", "--detach", parsed.baseRevision],
        { lockDirectory: taskDirectory }
      );
      const commonGitDirectory = await this.#commonGitDirectory(canonicalTarget, taskDirectory);
      await this.#verifyWorkspace(
        canonicalTarget,
        repositoryRoot,
        parsed.baseRevision,
        commonGitDirectory,
        taskDirectory
      );
      const handle = new ManagedGitFactoryWorkspace(
        {
          id,
          taskId: parsed.taskId,
          attempt: parsed.attempt,
          repositoryRoot,
          root: canonicalTarget,
          baseRevision: parsed.baseRevision
        },
        () => this.#close(id)
      );
      this.#owned.set(id, { handle, commonGitDirectory, lockDirectory: taskDirectory });
      this.#resourceOwner?.track(handle);
      return handle;
    } catch (error: unknown) {
      if (!created) throw error;
      try {
        await this.#removeWorktree(repositoryRoot, target, taskDirectory);
      } catch (cleanupError: unknown) {
        throw new AggregateError([error, cleanupError], "Worktree creation and cleanup failed.", {
          cause: error
        });
      }
      throw error;
    }
  }

  public async collect(
    workspace: FactoryWorkspace,
    limits: CollectFactoryWorkspaceInput
  ): Promise<FactoryWorkspacePatch> {
    const parsedLimits = collectInputSchema.parse(limits);
    const owned = this.#owned.get(workspace.id);
    if (owned?.handle !== workspace || owned.handle.closed) {
      throw new Error("Factory workspace is not live and owned by this manager.");
    }
    await this.#verifyWorkspace(
      workspace.root,
      workspace.repositoryRoot,
      workspace.baseRevision,
      owned.commonGitDirectory,
      owned.lockDirectory
    );
    await this.#rejectWorkingTreeFilters(workspace.root, owned.lockDirectory);
    await this.#runGit(workspace.root, ["add", "--all", "--", "."], {
      lockDirectory: owned.lockDirectory
    });
    await this.#verifyWorkspace(
      workspace.root,
      workspace.repositoryRoot,
      workspace.baseRevision,
      owned.commonGitDirectory,
      owned.lockDirectory
    );

    const paths = parseFactoryGitNullList(
      (
        await this.#runGit(
          workspace.root,
          ["diff", "--cached", "--name-only", "-z", "--no-renames", "HEAD", "--"],
          { lockDirectory: owned.lockDirectory, maxBufferBytes: maximumGitInventoryBytes }
        )
      ).stdout
    ).map((path) => repositoryRelativePathSchema.parse(path));
    if (new Set(paths).size !== paths.length)
      throw new Error("Git returned duplicate changed paths.");
    if (paths.length > parsedLimits.maximumChangedFiles) {
      throw new Error("Factory patch exceeds its changed-file budget.");
    }

    const statistics = parseNumstat(
      (
        await this.#runGit(
          workspace.root,
          ["diff", "--cached", "--numstat", "-z", "--no-renames", "HEAD", "--"],
          { lockDirectory: owned.lockDirectory, maxBufferBytes: maximumGitInventoryBytes }
        )
      ).stdout
    );
    if (
      !samePaths(
        paths,
        statistics.map(({ path }) => path)
      )
    ) {
      throw new Error("Git changed-path and numstat inventories disagree.");
    }
    const changedLines = statistics.reduce((total, item) => total + item.changedLines, 0);
    if (!Number.isSafeInteger(changedLines) || changedLines > parsedLimits.maximumChangedLines) {
      throw new Error("Factory patch exceeds its changed-line budget.");
    }
    const patch = (
      await this.#runGit(
        workspace.root,
        [
          "diff",
          "--cached",
          "--binary",
          "--full-index",
          "--no-ext-diff",
          "--no-renames",
          "HEAD",
          "--"
        ],
        {
          lockDirectory: owned.lockDirectory,
          maxBufferBytes: parsedLimits.maximumPatchBytes
        }
      )
    ).stdout;
    return {
      patch,
      changeSet: factoryChangeSetSchema.parse({
        baseRevision: workspace.baseRevision,
        headRevision: null,
        changedPaths: paths,
        binaryPaths: statistics.filter(({ binary }) => binary).map(({ path }) => path),
        changedFiles: paths.length,
        changedLines
      })
    };
  }

  public async apply(
    workspace: FactoryWorkspace,
    patch: string,
    maximumPatchBytes: number
  ): Promise<void> {
    const owned = this.#owned.get(workspace.id);
    if (owned?.handle !== workspace || owned.handle.closed) {
      throw new Error("Factory workspace is not live and owned by this manager.");
    }
    if (
      !Number.isSafeInteger(maximumPatchBytes) ||
      maximumPatchBytes < 1 ||
      Buffer.byteLength(patch, "utf8") > maximumPatchBytes
    ) {
      throw new Error("Factory patch exceeds its apply budget.");
    }
    await this.#verifyWorkspace(
      workspace.root,
      workspace.repositoryRoot,
      workspace.baseRevision,
      owned.commonGitDirectory,
      owned.lockDirectory
    );
    await this.#runGit(workspace.root, ["apply", "--index", "--whitespace=error-all", "--"], {
      lockDirectory: owned.lockDirectory,
      stdin: patch,
      maxInputBytes: maximumPatchBytes
    });
    await this.#verifyWorkspace(
      workspace.root,
      workspace.repositoryRoot,
      workspace.baseRevision,
      owned.commonGitDirectory,
      owned.lockDirectory
    );
  }

  async #factoryRoot(): Promise<string> {
    this.#root ??= prepareFactoryWorkspaceRoot(this.#rootPath);
    return this.#root;
  }

  async #close(id: string): Promise<void> {
    const owned = this.#owned.get(id);
    if (owned === undefined || owned.handle.closed) return;
    await this.#removeWorktree(owned.handle.repositoryRoot, owned.handle.root, owned.lockDirectory);
    owned.handle.markClosed();
    this.#owned.delete(id);
    this.#resourceOwner?.release(owned.handle);
  }

  async #removeWorktree(
    repositoryRoot: string,
    target: string,
    lockDirectory: string
  ): Promise<void> {
    const factoryRoot = await this.#factoryRoot();
    if (!factoryPathWithin(factoryRoot, target)) {
      throw new Error("Refusing to clean a worktree outside factory-owned storage.");
    }
    const metadata = await lstat(target).catch((error: unknown) => {
      if (hasErrorCode(error, "ENOENT")) return null;
      throw error;
    });
    if (metadata?.isSymbolicLink() === true) {
      throw new Error("Refusing to clean a symbolic-link worktree path.");
    }
    let removalError: unknown = null;
    try {
      await this.#runGit(repositoryRoot, ["worktree", "remove", "--force", target], {
        lockDirectory
      });
    } catch (error: unknown) {
      removalError = error;
    }
    const listed = await this.#listedWorktreePaths(repositoryRoot, lockDirectory);
    const remaining = await lstat(target).catch((error: unknown) => {
      if (hasErrorCode(error, "ENOENT")) return null;
      throw error;
    });
    if (listed.includes(target) || remaining !== null) {
      throw new Error("Factory worktree cleanup could not be confirmed.", { cause: removalError });
    }
  }

  async #verifyWorkspace(
    root: string,
    repositoryRoot: string,
    baseRevision: string,
    expectedCommonDirectory: string,
    lockDirectory: string
  ): Promise<void> {
    const metadata = await lstat(join(root, ".git"));
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("Factory worktree Git pointer is not a regular owned file.");
    }
    const topLevel = (
      await this.#runGit(root, ["rev-parse", "--path-format=absolute", "--show-toplevel"], {
        lockDirectory
      })
    ).stdout.trim();
    if (topLevel !== root) throw new Error("Factory worktree top-level path changed.");
    const commonDirectory = await this.#commonGitDirectory(root, lockDirectory);
    if (commonDirectory !== expectedCommonDirectory) {
      throw new Error("Factory worktree common Git directory changed.");
    }
    const sourceCommon = await this.#commonGitDirectory(repositoryRoot, lockDirectory);
    if (sourceCommon !== expectedCommonDirectory) {
      throw new Error("Factory worktree no longer belongs to its source repository.");
    }
    const head = (
      await this.#runGit(root, ["rev-parse", "--verify", "HEAD"], { lockDirectory })
    ).stdout.trim();
    if (head !== baseRevision) {
      throw new Error("Factory workers may propose a patch but may not commit or move HEAD.");
    }
    const branch = (
      await this.#runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"], { lockDirectory })
    ).stdout.trim();
    if (branch !== "HEAD") throw new Error("Factory worktree must remain detached.");
  }

  async #commonGitDirectory(root: string, lockDirectory: string): Promise<string> {
    const path = (
      await this.#runGit(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
        lockDirectory
      })
    ).stdout.trim();
    return realpath(path);
  }

  async #rejectCheckoutFilters(root: string, lockDirectory: string): Promise<void> {
    const files = parseFactoryGitNullList(
      (
        await this.#runGit(root, ["ls-files", "-z"], {
          lockDirectory,
          maxBufferBytes: maximumGitInventoryBytes
        })
      ).stdout
    );
    await this.#rejectFiltersForPaths(root, files, true, lockDirectory);
  }

  async #rejectWorkingTreeFilters(root: string, lockDirectory: string): Promise<void> {
    const files = parseFactoryGitNullList(
      (
        await this.#runGit(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
          lockDirectory,
          maxBufferBytes: maximumGitInventoryBytes
        })
      ).stdout
    );
    await this.#rejectFiltersForPaths(root, files, false, lockDirectory);
  }

  async #rejectFiltersForPaths(
    root: string,
    paths: readonly string[],
    cached: boolean,
    lockDirectory: string
  ): Promise<void> {
    for (let index = 0; index < paths.length; index += maximumAttributeArgumentCount) {
      const chunk = paths.slice(index, index + maximumAttributeArgumentCount);
      if (chunk.length === 0) continue;
      const result = await this.#runGit(
        root,
        ["check-attr", "-z", ...(cached ? ["--cached"] : []), "filter", "--", ...chunk],
        { lockDirectory, maxBufferBytes: maximumGitInventoryBytes }
      );
      const fields = parseFactoryGitNullList(result.stdout);
      if (fields.length !== chunk.length * 3) {
        throw new Error("Git filter-attribute inventory is malformed.");
      }
      for (let field = 0; field < fields.length; field += 3) {
        const value = fields[field + 2];
        if (value !== "unspecified" && value !== "unset") {
          throw new Error(
            `Factory worktrees reject Git clean/smudge filters (${value ?? "unknown"}).`
          );
        }
      }
    }
  }

  async #listedWorktreePaths(
    repositoryRoot: string,
    lockDirectory: string
  ): Promise<readonly string[]> {
    const output = (
      await this.#runGit(repositoryRoot, ["worktree", "list", "--porcelain", "-z"], {
        lockDirectory
      })
    ).stdout;
    return parseFactoryGitNullList(output).flatMap((field) =>
      field.startsWith("worktree ") ? [field.slice("worktree ".length)] : []
    );
  }

  #runGit(
    root: string,
    args: readonly string[],
    options: {
      readonly lockDirectory?: string;
      readonly maxBufferBytes?: number;
      readonly stdin?: string;
      readonly maxInputBytes?: number;
    } = {}
  ) {
    return this.#git.run(root, args, {
      timeoutMs: 60_000,
      maxBufferBytes: options.maxBufferBytes ?? 4 * 1_024 * 1_024,
      ...(options.lockDirectory === undefined
        ? {}
        : { lock: { directory: options.lockDirectory, mode: "blocking" } as const }),
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      ...(options.maxInputBytes === undefined ? {} : { maxInputBytes: options.maxInputBytes })
    });
  }
}

class ManagedGitFactoryWorkspace implements FactoryWorkspace {
  public closed = false;
  public readonly id: string;
  public readonly taskId: string;
  public readonly attempt: number;
  public readonly repositoryRoot: string;
  public readonly root: string;
  public readonly baseRevision: string;
  readonly #close: () => Promise<void>;
  #closing: Promise<void> | null = null;

  public constructor(fields: Omit<FactoryWorkspace, "closeAndWait">, close: () => Promise<void>) {
    this.id = fields.id;
    this.taskId = fields.taskId;
    this.attempt = fields.attempt;
    this.repositoryRoot = fields.repositoryRoot;
    this.root = fields.root;
    this.baseRevision = fields.baseRevision;
    this.#close = close;
  }

  public closeAndWait(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.#closing ??= this.#close().finally(() => {
      if (!this.closed) this.#closing = null;
    });
    return this.#closing;
  }

  public markClosed(): void {
    this.closed = true;
  }
}

interface NumstatEntry {
  readonly path: string;
  readonly changedLines: number;
  readonly binary: boolean;
}

function parseNumstat(output: string): readonly NumstatEntry[] {
  return parseFactoryGitNullList(output).map((record) => {
    const first = record.indexOf("\t");
    const second = record.indexOf("\t", first + 1);
    if (first < 1 || second < first + 2) throw new Error("Git numstat output is malformed.");
    const additions = record.slice(0, first);
    const deletions = record.slice(first + 1, second);
    const path = repositoryRelativePathSchema.parse(record.slice(second + 1));
    const binary = additions === "-" && deletions === "-";
    if (binary) return { path, changedLines: 0, binary: true };
    if (!/^[0-9]+$/u.test(additions) || !/^[0-9]+$/u.test(deletions)) {
      throw new Error("Git numstat counts are malformed.");
    }
    const changedLines = Number(additions) + Number(deletions);
    if (!Number.isSafeInteger(changedLines)) throw new Error("Git numstat count is unsafe.");
    return { path, changedLines, binary: false };
  });
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return rightSet.size === right.length && left.every((path) => rightSet.has(path));
}

async function canonicalDirectory(path: string): Promise<string> {
  const canonical = await realpath(path);
  const metadata = await lstat(canonical);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${path} is not a canonical directory.`);
  }
  return canonical;
}

async function assertAbsent(path: string): Promise<void> {
  const metadata = await lstat(path).catch((error: unknown) => {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  });
  if (metadata !== null) throw new Error("Factory worktree target already exists.");
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
