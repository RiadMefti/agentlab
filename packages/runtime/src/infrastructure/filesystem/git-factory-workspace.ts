import { chmod, lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

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

const createInputSchema = z
  .object({
    taskId: z.uuid(),
    attempt: z.number().int().min(1).max(20),
    repositoryRoot: z
      .string()
      .min(1)
      .max(4_096)
      .refine((value) => !value.includes("\0")),
    baseRevision: gitObjectIdSchema
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
}

export interface GitFactoryWorkspaceManagerOptions {
  readonly root: string;
  readonly gitExecutable: string;
  readonly createId: () => string;
  readonly resourceOwner?: ManagedRuntimeResourceOwner;
}

/** Exact-base detached Git worktrees with bounded patch capture and owned cleanup. */
export class GitFactoryWorkspaceManager implements FactoryWorkspaceManager {
  readonly #runner: CommandRunner;
  readonly #gitExecutable: string;
  readonly #createId: () => string;
  readonly #resourceOwner: ManagedRuntimeResourceOwner | undefined;
  readonly #rootPath: string;
  #root: Promise<string> | null = null;
  readonly #owned = new Map<string, OwnedWorkspace>();

  public constructor(runner: CommandRunner, options: GitFactoryWorkspaceManagerOptions) {
    this.#runner = runner;
    if (!isAbsolute(options.gitExecutable) || options.gitExecutable.includes("\0")) {
      throw new Error("Factory Git executable must be an absolute safe path.");
    }
    this.#gitExecutable = options.gitExecutable;
    this.#createId = options.createId;
    this.#resourceOwner = options.resourceOwner;
    this.#rootPath = safeWorktreeRoot(options.root);
  }

  public async create(input: CreateFactoryWorkspaceInput): Promise<FactoryWorkspace> {
    const parsed = createInputSchema.parse(input);
    const factoryRoot = await this.#factoryRoot();
    const repositoryRoot = await canonicalDirectory(parsed.repositoryRoot);
    if (pathsOverlap(factoryRoot, repositoryRoot)) {
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

    const id = z.uuid().parse(this.#createId());
    const taskDirectory = join(factoryRoot, parsed.taskId);
    await mkdir(taskDirectory, { mode: 0o700, recursive: true });
    await assertCanonicalOwnedDirectory(taskDirectory);
    const target = join(taskDirectory, `${String(parsed.attempt)}-${id}`);
    await assertAbsent(target);
    let created = false;
    try {
      await this.#runGit(repositoryRoot, [
        "worktree",
        "add",
        "--detach",
        "--no-checkout",
        target,
        parsed.baseRevision
      ]);
      created = true;
      const canonicalTarget = await canonicalDirectory(target);
      if (canonicalTarget !== target) throw new Error("Git worktree path is not canonical.");
      await this.#runGit(canonicalTarget, ["read-tree", "--reset", parsed.baseRevision]);
      await this.#rejectCheckoutFilters(canonicalTarget);
      await this.#runGit(canonicalTarget, ["checkout", "--force", "--detach", parsed.baseRevision]);
      const commonGitDirectory = await this.#commonGitDirectory(canonicalTarget);
      await this.#verifyWorkspace(
        canonicalTarget,
        repositoryRoot,
        parsed.baseRevision,
        commonGitDirectory
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
      this.#owned.set(id, { handle, commonGitDirectory });
      this.#resourceOwner?.track(handle);
      return handle;
    } catch (error: unknown) {
      if (!created) throw error;
      try {
        await this.#removeWorktree(repositoryRoot, target);
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
      owned.commonGitDirectory
    );
    await this.#rejectWorkingTreeFilters(workspace.root);
    await this.#runGit(workspace.root, ["add", "--all", "--", "."]);
    await this.#verifyWorkspace(
      workspace.root,
      workspace.repositoryRoot,
      workspace.baseRevision,
      owned.commonGitDirectory
    );

    const paths = parseNullList(
      (
        await this.#runGit(
          workspace.root,
          ["diff", "--cached", "--name-only", "-z", "--no-renames", "HEAD", "--"],
          maximumGitInventoryBytes
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
          maximumGitInventoryBytes
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
        parsedLimits.maximumPatchBytes
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
      owned.commonGitDirectory
    );
    await this.#runGit(
      workspace.root,
      ["apply", "--index", "--whitespace=error-all", "--"],
      4 * 1_024 * 1_024,
      patch,
      maximumPatchBytes
    );
    await this.#verifyWorkspace(
      workspace.root,
      workspace.repositoryRoot,
      workspace.baseRevision,
      owned.commonGitDirectory
    );
  }

  async #factoryRoot(): Promise<string> {
    this.#root ??= prepareFactoryRoot(this.#rootPath);
    return this.#root;
  }

  async #close(id: string): Promise<void> {
    const owned = this.#owned.get(id);
    if (owned === undefined || owned.handle.closed) return;
    await this.#removeWorktree(owned.handle.repositoryRoot, owned.handle.root);
    owned.handle.markClosed();
    this.#owned.delete(id);
    this.#resourceOwner?.release(owned.handle);
  }

  async #removeWorktree(repositoryRoot: string, target: string): Promise<void> {
    const factoryRoot = await this.#factoryRoot();
    if (!pathWithin(factoryRoot, target)) {
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
      await this.#runGit(repositoryRoot, ["worktree", "remove", "--force", target]);
    } catch (error: unknown) {
      removalError = error;
    }
    const listed = await this.#listedWorktreePaths(repositoryRoot);
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
    expectedCommonDirectory: string
  ): Promise<void> {
    const metadata = await lstat(join(root, ".git"));
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("Factory worktree Git pointer is not a regular owned file.");
    }
    const topLevel = (
      await this.#runGit(root, ["rev-parse", "--path-format=absolute", "--show-toplevel"])
    ).stdout.trim();
    if (topLevel !== root) throw new Error("Factory worktree top-level path changed.");
    const commonDirectory = await this.#commonGitDirectory(root);
    if (commonDirectory !== expectedCommonDirectory) {
      throw new Error("Factory worktree common Git directory changed.");
    }
    const sourceCommon = await this.#commonGitDirectory(repositoryRoot);
    if (sourceCommon !== expectedCommonDirectory) {
      throw new Error("Factory worktree no longer belongs to its source repository.");
    }
    const head = (await this.#runGit(root, ["rev-parse", "--verify", "HEAD"])).stdout.trim();
    if (head !== baseRevision) {
      throw new Error("Factory workers may propose a patch but may not commit or move HEAD.");
    }
    const branch = (await this.#runGit(root, ["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
    if (branch !== "HEAD") throw new Error("Factory worktree must remain detached.");
  }

  async #commonGitDirectory(root: string): Promise<string> {
    const path = (
      await this.#runGit(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"])
    ).stdout.trim();
    return realpath(path);
  }

  async #rejectCheckoutFilters(root: string): Promise<void> {
    const files = parseNullList(
      (await this.#runGit(root, ["ls-files", "-z"], maximumGitInventoryBytes)).stdout
    );
    await this.#rejectFiltersForPaths(root, files, true);
  }

  async #rejectWorkingTreeFilters(root: string): Promise<void> {
    const files = parseNullList(
      (
        await this.#runGit(
          root,
          ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
          maximumGitInventoryBytes
        )
      ).stdout
    );
    await this.#rejectFiltersForPaths(root, files, false);
  }

  async #rejectFiltersForPaths(
    root: string,
    paths: readonly string[],
    cached: boolean
  ): Promise<void> {
    for (let index = 0; index < paths.length; index += maximumAttributeArgumentCount) {
      const chunk = paths.slice(index, index + maximumAttributeArgumentCount);
      if (chunk.length === 0) continue;
      const result = await this.#runGit(
        root,
        ["check-attr", "-z", ...(cached ? ["--cached"] : []), "filter", "--", ...chunk],
        maximumGitInventoryBytes
      );
      const fields = parseNullList(result.stdout);
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

  async #listedWorktreePaths(repositoryRoot: string): Promise<readonly string[]> {
    const output = (await this.#runGit(repositoryRoot, ["worktree", "list", "--porcelain", "-z"]))
      .stdout;
    return parseNullList(output).flatMap((field) =>
      field.startsWith("worktree ") ? [field.slice("worktree ".length)] : []
    );
  }

  #runGit(
    root: string,
    args: readonly string[],
    maxBufferBytes = 4 * 1_024 * 1_024,
    stdin?: string,
    maxInputBytes?: number
  ) {
    return this.#runner.run(
      this.#gitExecutable,
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        "-C",
        root,
        ...args
      ],
      {
        timeoutMs: 60_000,
        maxBufferBytes,
        cleanupProcessTree: true,
        ...(stdin === undefined ? {} : { stdin }),
        ...(maxInputBytes === undefined ? {} : { maxInputBytes }),
        environment: {
          GIT_ATTR_NOSYSTEM: "1",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_LFS_SKIP_SMUDGE: "1",
          GIT_OPTIONAL_LOCKS: "0",
          GIT_PAGER: "cat",
          GIT_TERMINAL_PROMPT: "0",
          LC_ALL: "C",
          PATH: "/usr/local/bin:/usr/bin:/bin"
        }
      }
    );
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
  return parseNullList(output).map((record) => {
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

function parseNullList(output: string): readonly string[] {
  if (output.length === 0) return [];
  if (!output.endsWith("\0")) throw new Error("Git NUL-delimited output is truncated.");
  return output.slice(0, -1).split("\0");
}

function samePaths(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const rightSet = new Set(right);
  return rightSet.size === right.length && left.every((path) => rightSet.has(path));
}

async function prepareFactoryRoot(path: string): Promise<string> {
  const absolute = safeWorktreeRoot(path);
  await mkdir(absolute, { mode: 0o700, recursive: true });
  const canonical = await realpath(absolute);
  if (canonical !== absolute)
    throw new Error("Factory worktree root must not be a symbolic-link alias.");
  await chmod(canonical, 0o700);
  return canonical;
}

function safeWorktreeRoot(path: string): string {
  if (path.length === 0 || path.includes("\0")) {
    throw new Error("Factory worktree root is invalid.");
  }
  const absolute = resolve(path);
  if (absolute === parse(absolute).root) {
    throw new Error("Factory worktree root must be a dedicated non-root path.");
  }
  return absolute;
}

async function canonicalDirectory(path: string): Promise<string> {
  const canonical = await realpath(path);
  const metadata = await lstat(canonical);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${path} is not a canonical directory.`);
  }
  return canonical;
}

async function assertCanonicalOwnedDirectory(path: string): Promise<void> {
  const canonical = await canonicalDirectory(path);
  if (canonical !== resolve(path))
    throw new Error("Factory task worktree directory is not canonical.");
  await chmod(canonical, 0o700);
}

async function assertAbsent(path: string): Promise<void> {
  const metadata = await lstat(path).catch((error: unknown) => {
    if (hasErrorCode(error, "ENOENT")) return null;
    throw error;
  });
  if (metadata !== null) throw new Error("Factory worktree target already exists.");
}

function pathsOverlap(left: string, right: string): boolean {
  return pathWithin(left, right) || pathWithin(right, left);
}

function pathWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
