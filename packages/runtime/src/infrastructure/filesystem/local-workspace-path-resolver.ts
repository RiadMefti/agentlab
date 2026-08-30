import { realpath, stat } from "node:fs/promises";
import type { Stats } from "node:fs";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";

import type {
  ResolvedWorkspacePath,
  WorkspacePathResolver
} from "../../domain/workspace-path-resolver.js";
import type { AsyncOperationOwner } from "../../domain/async-operation-owner.js";
import { withTimeout } from "../process/promise-timeout.js";

const FILESYSTEM_TIMEOUT_MS = 2_000;

export interface WorkspaceFilesystem {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<Stats>;
}

export interface LocalWorkspacePathResolverOptions {
  readonly timeoutMs?: number;
  readonly filesystem?: WorkspaceFilesystem;
  readonly operationOwner?: AsyncOperationOwner;
}

/** Expands and canonicalizes an existing local directory selected by the user. */
export class LocalWorkspacePathResolver implements WorkspacePathResolver {
  public constructor(
    private readonly cwd: string = process.cwd(),
    private readonly homeDirectory: string = homedir(),
    private readonly options: LocalWorkspacePathResolverOptions = {}
  ) {}

  public async resolve(input: string): Promise<ResolvedWorkspacePath> {
    const expanded = expandHome(input, this.homeDirectory);
    const absolute = resolve(this.cwd, expanded);
    let canonical: string;

    try {
      const filesystem = this.options.filesystem ?? { realpath, stat };
      const timeoutMs = this.options.timeoutMs ?? FILESYSTEM_TIMEOUT_MS;
      canonical = await awaitFilesystemOperation(
        filesystem.realpath(absolute),
        this.options.operationOwner,
        timeoutMs,
        "Folder path resolution timed out. Check that the filesystem is responsive."
      );
      const metadata = await awaitFilesystemOperation(
        filesystem.stat(canonical),
        this.options.operationOwner,
        timeoutMs,
        "Folder metadata lookup timed out. Check that the filesystem is responsive."
      );
      if (!metadata.isDirectory()) {
        throw new Error("The selected path is not a folder.");
      }
    } catch (error: unknown) {
      if (error instanceof Error && error.message === "The selected path is not a folder.") {
        throw error;
      }
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") {
        throw new Error("Choose an existing folder.");
      }
      if (code === "EACCES") {
        throw new Error("That folder cannot be accessed with your current permissions.");
      }
      if (error instanceof Error && error.message.includes("timed out")) throw error;
      throw new Error("That folder could not be opened.", { cause: error });
    }

    return {
      path: canonical,
      suggestedName: basename(canonical) || canonical
    };
  }
}

function awaitFilesystemOperation<Output>(
  operation: Promise<Output>,
  owner: AsyncOperationOwner | undefined,
  timeoutMs: number,
  message: string
): Promise<Output> {
  if (owner === undefined) return operation;
  return withTimeout(owner.own(operation), { timeoutMs, message });
}

function expandHome(input: string, homeDirectory: string): string {
  if (input === "~") return homeDirectory;
  if (input.startsWith("~/")) return resolve(homeDirectory, input.slice(2));
  return input;
}
