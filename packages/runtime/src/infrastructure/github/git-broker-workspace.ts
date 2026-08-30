import { chmod, lstat, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path";

import {
  factoryChangeSetSchema,
  repositoryRelativePathSchema,
  type FactoryChangeSet,
  type GitObjectId
} from "@agentlab/contracts";

import type { CommandRunner } from "../process/command-runner.js";

const inventoryLimitBytes = 64 * 1_024 * 1_024;

export interface GitBrokerWorkspaceOptions {
  readonly root: string;
  readonly gitExecutable: string;
  readonly authorName: string;
  readonly authorEmail: string;
}

export interface PrepareGitBrokerCommitInput {
  readonly repositoryRoot: string;
  readonly baseRevision: GitObjectId;
  readonly patch: string;
  readonly patchMaximumBytes: number;
  readonly expectedChangeSet: FactoryChangeSet;
  readonly title: string;
  readonly timestamp: string;
}

/** Fresh non-model Git repository used only to verify, commit, and publish one authorized patch. */
export class GitBrokerWorkspace {
  readonly #rootPath: string;
  #root: Promise<string> | null = null;

  public constructor(
    private readonly runner: CommandRunner,
    private readonly options: GitBrokerWorkspaceOptions
  ) {
    if (!isAbsolute(options.gitExecutable) || options.gitExecutable.includes("\0")) {
      throw new Error("Broker Git executable must be an absolute safe path.");
    }
    if (
      !isAbsolute(options.root) ||
      options.root.includes("\0") ||
      resolve(options.root) === parse(resolve(options.root)).root
    ) {
      throw new Error("Broker workspace parent must be a safe absolute non-root path.");
    }
    if (options.authorName.trim().length === 0 || /[\0\r\n]/u.test(options.authorName)) {
      throw new Error("Broker Git author name is invalid.");
    }
    if (options.authorEmail.trim().length === 0 || /[\0\r\n]/u.test(options.authorEmail)) {
      throw new Error("Broker Git author email is invalid.");
    }
    this.#rootPath = join(resolve(options.root), "broker-workspaces");
  }

  public async prepare(input: PrepareGitBrokerCommitInput): Promise<PreparedGitBrokerCommit> {
    const storageRoot = await this.#storageRoot();
    const sourceRoot = await canonicalDirectory(input.repositoryRoot);
    if (pathsOverlap(storageRoot, sourceRoot)) {
      throw new Error("Broker workspace storage and source repository must not overlap.");
    }
    if (
      !Number.isSafeInteger(input.patchMaximumBytes) ||
      input.patchMaximumBytes < 1 ||
      Buffer.byteLength(input.patch, "utf8") > input.patchMaximumBytes
    ) {
      throw new Error("Broker patch exceeds its authorized size.");
    }
    const root = await mkdtemp(join(storageRoot, "proposal-"));
    await chmod(root, 0o700);
    const prepared = new PreparedGitBrokerCommit(this.runner, this.options, root);
    try {
      await prepared.initialize(input, sourceRoot);
      return prepared;
    } catch (error: unknown) {
      try {
        await prepared.close();
      } catch (cleanupError: unknown) {
        throw new AggregateError([error, cleanupError], "Broker preparation and cleanup failed.");
      }
      throw error;
    }
  }

  async #storageRoot(): Promise<string> {
    this.#root ??= prepareStorageRoot(this.#rootPath);
    return this.#root;
  }
}

export class PreparedGitBrokerCommit {
  public headRevision: GitObjectId | null = null;
  #closed = false;

  public constructor(
    private readonly runner: CommandRunner,
    private readonly options: GitBrokerWorkspaceOptions,
    public readonly root: string
  ) {}

  public async initialize(input: PrepareGitBrokerCommitInput, sourceRoot: string): Promise<void> {
    await this.#git(["init", "--initial-branch=agentlab-broker", "."]);
    await this.#git(["fetch", "--no-tags", "--depth=1", sourceRoot, input.baseRevision]);
    const fetched = (
      await this.#git(["rev-parse", "--verify", "FETCH_HEAD^{commit}"])
    ).stdout.trim();
    if (fetched !== input.baseRevision) throw new Error("Broker fetched a different base commit.");
    await this.#git(["read-tree", "--reset", input.baseRevision]);
    await this.#rejectFilters(true);
    await this.#git(["checkout", "--force", "--detach", input.baseRevision]);
    await this.#verifyHead(input.baseRevision);
    await this.#git(
      ["apply", "--index", "--whitespace=error-all", "--"],
      input.patchMaximumBytes,
      input.patch
    );
    await this.#rejectFilters(false);
    await this.#rejectSubmodules();
    const observed = await this.#changeSet(input.baseRevision);
    if (!sameChangeSet(observed, input.expectedChangeSet)) {
      throw new Error("Broker-observed diff does not match the authorized change set.");
    }
    await this.#git(
      [
        "-c",
        `user.name=${this.options.authorName}`,
        "-c",
        `user.email=${this.options.authorEmail}`,
        "-c",
        "commit.gpgsign=false",
        "commit",
        "--no-gpg-sign",
        "-m",
        input.title,
        "--"
      ],
      4 * 1_024 * 1_024,
      undefined,
      {
        GIT_AUTHOR_DATE: input.timestamp,
        GIT_COMMITTER_DATE: input.timestamp
      }
    );
    const head = (await this.#git(["rev-parse", "--verify", "HEAD"])).stdout.trim();
    const parent = (await this.#git(["rev-parse", "--verify", "HEAD^"])).stdout.trim();
    if (parent !== input.baseRevision || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(head)) {
      throw new Error("Broker commit is not exactly one commit above the authorized base.");
    }
    this.headRevision = head;
  }

  public async push(input: {
    readonly repositoryUrl: string;
    readonly branchName: string;
    readonly authorizationHeader: string;
  }): Promise<void> {
    if (this.headRevision === null) throw new Error("Broker commit is not prepared.");
    if (!/^https:\/\/github\.com\/[a-z0-9-]+\/[a-z0-9._-]+\.git$/u.test(input.repositoryUrl)) {
      throw new Error("Broker push URL is outside GitHub.");
    }
    if (!/^[a-z0-9][a-z0-9._/-]*$/u.test(input.branchName)) {
      throw new Error("Broker branch name is invalid.");
    }
    if (!/^AUTHORIZATION: basic [A-Za-z0-9+/=]+$/u.test(input.authorizationHeader)) {
      throw new Error("Broker Git authorization header is invalid.");
    }
    await this.#git(
      ["push", "--porcelain", input.repositoryUrl, `HEAD:refs/heads/${input.branchName}`],
      4 * 1_024 * 1_024,
      undefined,
      {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
        GIT_CONFIG_VALUE_0: input.authorizationHeader
      }
    );
  }

  public async close(): Promise<void> {
    if (this.#closed) return;
    const canonical = await realpath(this.root);
    if (canonical !== this.root) throw new Error("Broker workspace path changed before cleanup.");
    const metadata = await lstat(this.root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("Broker workspace root is not an owned directory.");
    }
    await rm(this.root, { recursive: true, force: false, maxRetries: 2, retryDelay: 100 });
    this.#closed = true;
  }

  async #verifyHead(baseRevision: string): Promise<void> {
    const head = (await this.#git(["rev-parse", "--verify", "HEAD"])).stdout.trim();
    const branch = (await this.#git(["rev-parse", "--abbrev-ref", "HEAD"])).stdout.trim();
    if (head !== baseRevision || branch !== "HEAD") {
      throw new Error("Broker workspace is not detached at the exact base.");
    }
  }

  async #rejectFilters(cached: boolean): Promise<void> {
    const paths = parseNullList(
      (
        await this.#git(
          cached
            ? ["ls-files", "-z"]
            : ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
          inventoryLimitBytes
        )
      ).stdout
    );
    for (let index = 0; index < paths.length; index += 128) {
      const chunk = paths.slice(index, index + 128);
      const fields = parseNullList(
        (
          await this.#git(
            ["check-attr", "-z", ...(cached ? ["--cached"] : []), "filter", "--", ...chunk],
            inventoryLimitBytes
          )
        ).stdout
      );
      if (fields.length !== chunk.length * 3)
        throw new Error("Broker filter inventory is invalid.");
      for (let offset = 2; offset < fields.length; offset += 3) {
        const value = fields[offset];
        if (value !== "unspecified" && value !== "unset") {
          throw new Error("Broker rejects Git clean/smudge filters.");
        }
      }
    }
  }

  async #rejectSubmodules(): Promise<void> {
    const fields = parseNullList(
      (
        await this.#git(
          ["diff", "--cached", "--raw", "-z", "--no-renames", "HEAD", "--"],
          inventoryLimitBytes
        )
      ).stdout
    );
    if (fields.some((field) => field.startsWith(":160000 ") || field.includes(" 160000 "))) {
      throw new Error("Broker patches cannot add or modify Git submodules.");
    }
  }

  async #changeSet(baseRevision: GitObjectId): Promise<FactoryChangeSet> {
    const paths = parseNullList(
      (
        await this.#git(
          ["diff", "--cached", "--name-only", "-z", "--no-renames", "HEAD", "--"],
          inventoryLimitBytes
        )
      ).stdout
    ).map((path) => repositoryRelativePathSchema.parse(path));
    const statistics = parseNumstat(
      (
        await this.#git(
          ["diff", "--cached", "--numstat", "-z", "--no-renames", "HEAD", "--"],
          inventoryLimitBytes
        )
      ).stdout
    );
    if (
      !sameStringSet(
        paths,
        statistics.map(({ path }) => path)
      )
    ) {
      throw new Error("Broker path and numstat inventories disagree.");
    }
    return factoryChangeSetSchema.parse({
      baseRevision,
      headRevision: null,
      changedPaths: paths,
      binaryPaths: statistics.filter(({ binary }) => binary).map(({ path }) => path),
      changedFiles: paths.length,
      changedLines: statistics.reduce((total, entry) => total + entry.changedLines, 0)
    });
  }

  #git(
    args: readonly string[],
    maximumBytes = 4 * 1_024 * 1_024,
    stdin?: string,
    additionalEnvironment: Readonly<Record<string, string>> = {}
  ) {
    return this.runner.run(
      this.options.gitExecutable,
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        "-C",
        this.root,
        ...args
      ],
      {
        timeoutMs: 120_000,
        maxBufferBytes: maximumBytes,
        maxCombinedBufferBytes: maximumBytes,
        cleanupProcessTree: true,
        ...(stdin === undefined ? {} : { stdin, maxInputBytes: maximumBytes }),
        environment: {
          GIT_ATTR_NOSYSTEM: "1",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_LFS_SKIP_SMUDGE: "1",
          GIT_OPTIONAL_LOCKS: "0",
          GIT_PAGER: "cat",
          GIT_TERMINAL_PROMPT: "0",
          LC_ALL: "C",
          PATH: "/usr/local/bin:/usr/bin:/bin",
          ...additionalEnvironment
        }
      }
    );
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
    if (first < 1 || second < first + 2) throw new Error("Broker numstat output is malformed.");
    const additions = record.slice(0, first);
    const deletions = record.slice(first + 1, second);
    const path = repositoryRelativePathSchema.parse(record.slice(second + 1));
    if (additions === "-" && deletions === "-") return { path, changedLines: 0, binary: true };
    if (!/^[0-9]+$/u.test(additions) || !/^[0-9]+$/u.test(deletions)) {
      throw new Error("Broker numstat counts are malformed.");
    }
    const changedLines = Number(additions) + Number(deletions);
    if (!Number.isSafeInteger(changedLines)) throw new Error("Broker numstat count is unsafe.");
    return { path, changedLines, binary: false };
  });
}

function parseNullList(output: string): readonly string[] {
  if (output.length === 0) return [];
  if (!output.endsWith("\0")) throw new Error("Broker NUL-delimited Git output is truncated.");
  return output.slice(0, -1).split("\0");
}

function sameChangeSet(left: FactoryChangeSet, right: FactoryChangeSet): boolean {
  return (
    left.baseRevision === right.baseRevision &&
    right.headRevision === null &&
    left.changedFiles === right.changedFiles &&
    left.changedLines === right.changedLines &&
    sameStringSet(left.changedPaths, right.changedPaths) &&
    sameStringSet(left.binaryPaths, right.binaryPaths)
  );
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

async function prepareStorageRoot(path: string): Promise<string> {
  const absolute = resolve(path);
  await mkdir(absolute, { mode: 0o700, recursive: true });
  const canonical = await realpath(absolute);
  if (canonical !== absolute) throw new Error("Broker storage root must be canonical.");
  await chmod(canonical, 0o700);
  return canonical;
}

async function canonicalDirectory(path: string): Promise<string> {
  const canonical = await realpath(path);
  const metadata = await lstat(canonical);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Broker source repository must be a canonical directory.");
  }
  return canonical;
}

function pathsOverlap(left: string, right: string): boolean {
  return pathWithin(left, right) || pathWithin(right, left);
}

function pathWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path));
}
