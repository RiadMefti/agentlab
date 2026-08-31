import { lstat, mkdir, realpath } from "node:fs/promises";
import { isAbsolute, join, parse, relative, sep } from "node:path";

import type { CommandSpec } from "../../domain/command.js";
import type { FactoryGateSandbox } from "../../domain/factory-gate.js";
import type { FactoryWorkspace } from "../../domain/factory-workspace.js";

export interface BubblewrapFactoryGateSandboxOptions {
  readonly executable: string;
  /** Trusted runtime installations needed by gate commands, mounted read-only. */
  readonly runtimeRoots: readonly string[];
}

/** Linux gate sandbox: empty root, no network, hidden home, read-only tools/dependencies. */
export class BubblewrapFactoryGateSandbox implements FactoryGateSandbox {
  readonly #executable: string;
  readonly #runtimeRoots: readonly string[];

  public constructor(options: BubblewrapFactoryGateSandboxOptions) {
    if (!isAbsolute(options.executable) || options.executable.includes("\0")) {
      throw new Error("Bubblewrap executable must be an absolute safe path.");
    }
    if (
      options.runtimeRoots.length > 8 ||
      options.runtimeRoots.some(
        (root) => !isAbsolute(root) || root.includes("\0") || root === parse(root).root
      )
    ) {
      throw new Error("Factory gate runtime roots must be a bounded list of absolute paths.");
    }
    this.#executable = options.executable;
    this.#runtimeRoots = [...new Set(options.runtimeRoots)];
  }

  public async wrap(command: CommandSpec, workspace: FactoryWorkspace): Promise<CommandSpec> {
    const root = await realpath(workspace.root);
    if (root !== workspace.root) throw new Error("Gate workspace path is not canonical.");
    await assertDirectory(root, "Factory gate workspace");
    const dependencySource = await realpath(join(workspace.repositoryRoot, "node_modules"));
    await assertDirectory(dependencySource, "Factory gate dependency source");
    const dependencyTarget = join(root, "node_modules");
    await ensureDirectory(dependencyTarget);
    await assertDirectory(dependencyTarget, "Factory gate dependency target");

    const runtimeRoots = await Promise.all(this.#runtimeRoots.map((path) => realpath(path)));
    const rewrittenExecutable = rewriteExecutable(command.executable, runtimeRoots);
    const runtimeBinds = runtimeRoots.flatMap((path, index) => [
      "--ro-bind",
      path,
      `/runtime/${String(index)}`
    ]);
    const runtimePaths = runtimeRoots.map((_path, index) => `/runtime/${String(index)}/bin`);
    return {
      executable: this.#executable,
      args: [
        "--unshare-all",
        "--die-with-parent",
        "--new-session",
        "--clearenv",
        "--ro-bind",
        "/usr",
        "/usr",
        "--symlink",
        "usr/bin",
        "/bin",
        "--symlink",
        "usr/lib",
        "/lib",
        "--symlink",
        "usr/lib64",
        "/lib64",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
        "--tmpfs",
        "/tmp",
        "--dir",
        "/tmp/home",
        "--bind",
        root,
        "/workspace",
        "--ro-bind",
        dependencySource,
        "/workspace/node_modules",
        ...runtimeBinds,
        "--setenv",
        "HOME",
        "/tmp/home",
        "--setenv",
        "CI",
        "true",
        "--setenv",
        "LC_ALL",
        "C",
        "--setenv",
        "NPM_CONFIG_CACHE",
        "/tmp/npm-cache",
        "--setenv",
        "NPM_CONFIG_UPDATE_NOTIFIER",
        "false",
        "--setenv",
        "PATH",
        [...runtimePaths, "/workspace/node_modules/.bin", "/usr/bin", "/bin"].join(":"),
        "--chdir",
        "/workspace",
        "--",
        rewrittenExecutable,
        ...command.args
      ]
    };
  }
}

async function assertDirectory(path: string, label: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory.`);
  }
}

async function ensureDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error: unknown) {
    if (!hasErrorCode(error, "EEXIST")) throw error;
  }
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function rewriteExecutable(executable: string, runtimeRoots: readonly string[]): string {
  if (!isAbsolute(executable) || executable.includes("\0")) {
    throw new Error("Factory gate commands require absolute executable paths.");
  }
  for (const [index, root] of runtimeRoots.entries()) {
    const child = relative(root, executable);
    if (child === "") return `/runtime/${String(index)}`;
    if (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child)) {
      return join(`/runtime/${String(index)}`, child);
    }
  }
  if (executable.startsWith("/usr/")) return executable;
  throw new Error("Factory gate executable is outside trusted sandbox mounts.");
}
