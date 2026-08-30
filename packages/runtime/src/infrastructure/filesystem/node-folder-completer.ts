import { opendir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

import type { FolderCompletionInput, FolderSuggestion } from "@agentlab/contracts";

import type { FolderCompleter } from "../../domain/folder-completer.js";
import type { AsyncOperationOwner } from "../../domain/async-operation-owner.js";
import { withTimeout } from "../process/promise-timeout.js";

const MAX_DIRECTORY_ENTRIES = 4_096;
const PROCESSING_BUDGET_MS = 25;
const MAX_SYMLINK_CHECKS = 64;
const CACHE_ENTRIES = 32;
const CACHE_DURATION_MS = 2_000;
const FILESYSTEM_OPERATION_TIMEOUT_MS = 100;

interface CachedDirectory {
  readonly expiresAt: number;
  readonly entries: readonly Entry[];
}

interface Entry {
  readonly name: string;
  readonly symlink: boolean;
}

interface DirectoryEntry {
  readonly name: string;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

interface DirectoryHandle extends AsyncIterable<DirectoryEntry> {
  close(): Promise<void>;
}

export interface FolderCompleterFilesystem {
  opendir(path: string): Promise<DirectoryHandle>;
  stat(path: string): Promise<{ isDirectory(): boolean }>;
}

export interface NodeFolderCompleterOptions {
  readonly filesystem?: FolderCompleterFilesystem;
  readonly operationTimeoutMs?: number;
  readonly operationOwner?: AsyncOperationOwner;
}

/** Non-recursive, bounded directory completion. Errors degrade to no suggestions. */
export class NodeFolderCompleter implements FolderCompleter {
  readonly #cache = new Map<string, CachedDirectory>();

  public constructor(
    private readonly cwd: string = process.cwd(),
    private readonly homeDirectory: string = homedir(),
    private readonly now: () => number = Date.now,
    private readonly options: NodeFolderCompleterOptions = {}
  ) {}

  public async complete(input: FolderCompletionInput): Promise<readonly FolderSuggestion[]> {
    if (input.path === "") return [];
    const parsed = completionParts(input.path, this.cwd, this.homeDirectory);
    const entries = await this.readDirectory(parsed.directory);
    const prefix = parsed.prefix.toLowerCase();
    return entries
      .filter(({ name }) => name.toLowerCase().startsWith(prefix))
      .sort((left, right) => compareNames(left.name, right.name))
      .map((entry) => {
        const value = `${parsed.displayDirectory}${entry.name}${sep}`;
        return {
          value,
          label: entry.symlink ? `${value} →` : value,
          symlink: entry.symlink
        };
      })
      .filter(({ value, label }) => value.length <= 4_096 && label.length <= 4_100)
      .slice(0, input.limit);
  }

  private async readDirectory(directory: string): Promise<readonly Entry[]> {
    const cached = this.#cache.get(directory);
    if (cached !== undefined && cached.expiresAt > this.now()) {
      this.#cache.delete(directory);
      this.#cache.set(directory, cached);
      return cached.entries;
    }
    if (cached !== undefined) this.#cache.delete(directory);

    const filesystem = this.options.filesystem ?? { opendir, stat };
    const operationTimeoutMs = this.options.operationTimeoutMs ?? FILESYSTEM_OPERATION_TIMEOUT_MS;
    let handle: DirectoryHandle | null = null;
    const pendingOpen = ownOperation(
      Promise.resolve().then(() => filesystem.opendir(directory)),
      this.options.operationOwner
    );
    try {
      handle = await withOptionalTimeout(
        pendingOpen,
        this.options.operationOwner,
        operationTimeoutMs,
        "Folder completion timed out while opening the directory."
      );
      const scan = await collectFolderEntries(
        handle,
        directory,
        this.now,
        filesystem.stat.bind(filesystem),
        operationTimeoutMs,
        this.options.operationOwner
      );
      if (!scan.complete) return scan.entries;
      this.store(directory, scan.entries);
      return scan.entries;
    } catch {
      if (handle === null) {
        void pendingOpen.then(
          (lateHandle) =>
            closeDirectory(lateHandle, operationTimeoutMs, this.options.operationOwner),
          () => undefined
        );
      }
      return [];
    } finally {
      if (handle !== null) {
        await closeDirectory(handle, operationTimeoutMs, this.options.operationOwner);
      }
    }
  }

  private store(directory: string, entries: readonly Entry[]): void {
    this.#cache.set(directory, { entries, expiresAt: this.now() + CACHE_DURATION_MS });
    while (this.#cache.size > CACHE_ENTRIES) {
      const oldest = this.#cache.keys().next().value;
      if (oldest === undefined) break;
      this.#cache.delete(oldest);
    }
  }
}

export async function collectFolderEntries(
  directoryEntries: AsyncIterable<DirectoryEntry>,
  directory: string,
  now: () => number,
  statPath: (path: string) => Promise<{ isDirectory(): boolean }>,
  operationTimeoutMs: number = FILESYSTEM_OPERATION_TIMEOUT_MS,
  operationOwner?: AsyncOperationOwner
): Promise<{ readonly entries: readonly Entry[]; readonly complete: boolean }> {
  const entries: Entry[] = [];
  const symlinks: string[] = [];
  let complete = true;
  let scanned = 0;
  const startedAt = now();
  const iterator = directoryEntries[Symbol.asyncIterator]();
  while (scanned < MAX_DIRECTORY_ENTRIES) {
    const remainingMs = PROCESSING_BUDGET_MS - (now() - startedAt);
    if (remainingMs <= 0) {
      complete = false;
      break;
    }
    let result: IteratorResult<DirectoryEntry>;
    try {
      result = await withOptionalTimeout(
        ownOperation(iterator.next(), operationOwner),
        operationOwner,
        Math.max(1, Math.min(operationTimeoutMs, Math.ceil(remainingMs))),
        "Folder completion timed out while reading the directory."
      );
    } catch {
      complete = false;
      break;
    }
    if (result.done) break;
    const entry = result.value;
    scanned += 1;
    if (entry.isDirectory()) entries.push({ name: entry.name, symlink: false });
    else if (entry.isSymbolicLink() && symlinks.length < MAX_SYMLINK_CHECKS) {
      symlinks.push(entry.name);
    } else if (entry.isSymbolicLink()) {
      complete = false;
    }
  }
  if (scanned >= MAX_DIRECTORY_ENTRIES) complete = false;
  for (const name of symlinks) {
    const remainingMs = PROCESSING_BUDGET_MS - (now() - startedAt);
    if (remainingMs <= 0) {
      complete = false;
      break;
    }
    try {
      const metadata = await withOptionalTimeout(
        ownOperation(statPath(join(directory, name)), operationOwner),
        operationOwner,
        Math.max(1, Math.min(operationTimeoutMs, Math.ceil(remainingMs))),
        "Folder completion timed out while checking a symlink."
      );
      if (metadata.isDirectory()) {
        entries.push({ name, symlink: true });
      }
    } catch {
      // Broken, inaccessible, and file-targeting symlinks are not folder suggestions.
    }
  }
  return { entries, complete };
}

async function closeDirectory(
  handle: DirectoryHandle,
  timeoutMs: number,
  operationOwner?: AsyncOperationOwner
): Promise<void> {
  try {
    await withOptionalTimeout(
      ownOperation(handle.close(), operationOwner),
      operationOwner,
      timeoutMs,
      "Folder completion timed out while closing the directory."
    );
  } catch {
    // Completion is best effort and cannot leave the modal waiting on close diagnostics.
  }
}

function ownOperation<Output>(
  operation: Promise<Output>,
  owner: AsyncOperationOwner | undefined
): Promise<Output> {
  return owner?.own(operation) ?? operation;
}

function withOptionalTimeout<Output>(
  operation: Promise<Output>,
  owner: AsyncOperationOwner | undefined,
  timeoutMs: number,
  message: string
): Promise<Output> {
  return owner === undefined ? operation : withTimeout(operation, { timeoutMs, message });
}

function completionParts(
  input: string,
  cwd: string,
  homeDirectory: string
): { readonly directory: string; readonly displayDirectory: string; readonly prefix: string } {
  const endsWithSeparator = input.endsWith(sep);
  const displayDirectory = endsWithSeparator ? input : directoryPrefix(input);
  const prefix = endsWithSeparator ? "" : basename(input);
  const lookupDirectory = displayDirectory === "" ? "." : displayDirectory;
  const expanded = expandHome(lookupDirectory, homeDirectory);
  return {
    directory: isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded),
    displayDirectory,
    prefix
  };
}

function directoryPrefix(input: string): string {
  const parent = dirname(input);
  if (parent === ".") return "";
  return parent.endsWith(sep) ? parent : `${parent}${sep}`;
}

function expandHome(input: string, homeDirectory: string): string {
  if (input === "~") return homeDirectory;
  if (input.startsWith(`~${sep}`)) return join(homeDirectory, input.slice(2));
  return input;
}

function compareNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
