import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";

import type {
  ResolvedWorkspacePath,
  WorkspacePathResolver
} from "../../domain/workspace-path-resolver.js";

/** Expands and canonicalizes an existing local directory selected by the user. */
export class LocalWorkspacePathResolver implements WorkspacePathResolver {
  public constructor(
    private readonly cwd: string = process.cwd(),
    private readonly homeDirectory: string = homedir()
  ) {}

  public async resolve(input: string): Promise<ResolvedWorkspacePath> {
    const expanded = expandHome(input, this.homeDirectory);
    const absolute = resolve(this.cwd, expanded);
    let canonical: string;

    try {
      canonical = await realpath(absolute);
      if (!(await stat(canonical)).isDirectory()) {
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
      throw new Error("That folder could not be opened.", { cause: error });
    }

    return {
      path: canonical,
      suggestedName: basename(canonical) || canonical
    };
  }
}

function expandHome(input: string, homeDirectory: string): string {
  if (input === "~") return homeDirectory;
  if (input.startsWith("~/")) return resolve(homeDirectory, input.slice(2));
  return input;
}
