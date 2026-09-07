import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, parse, relative, sep } from "node:path";

import type { CommandSpec } from "../../domain/command.js";
import type { FactoryEvalSandbox } from "../../domain/factory-eval-harness.js";

export interface BubblewrapFactoryEvalSandboxOptions {
  readonly executable: string;
  readonly runtimeRoots: readonly string[];
}

/** Empty-home, no-network eval sandbox with only one ephemeral writable directory. */
export class BubblewrapFactoryEvalSandbox implements FactoryEvalSandbox {
  readonly #executable: string;
  readonly #runtimeRoots: readonly string[];

  public constructor(options: BubblewrapFactoryEvalSandboxOptions) {
    if (!isAbsolute(options.executable) || options.executable.includes("\0")) {
      throw new Error("Eval bubblewrap executable must be an absolute safe path.");
    }
    if (
      options.runtimeRoots.length > 8 ||
      new Set(options.runtimeRoots).size !== options.runtimeRoots.length ||
      options.runtimeRoots.some(
        (root) => !isAbsolute(root) || root.includes("\0") || root === parse(root).root
      )
    ) {
      throw new Error("Eval sandbox runtime roots must be a bounded list of absolute paths.");
    }
    this.#executable = options.executable;
    this.#runtimeRoots = [...options.runtimeRoots];
  }

  public async wrap(command: CommandSpec, workspaceInput: string): Promise<CommandSpec> {
    const workspace = await realpath(workspaceInput);
    if (workspace !== workspaceInput) throw new Error("Eval sandbox workspace is not canonical.");
    const metadata = await lstat(workspace);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error("Eval sandbox workspace must be a real directory.");
    }
    const roots = await Promise.all(this.#runtimeRoots.map((path) => realpath(path)));
    if (roots.some((root) => pathsOverlap(root, workspace))) {
      throw new Error("Eval sandbox runtime roots must not contain its writable workspace.");
    }
    const executable = rewriteExecutable(command.executable, roots);
    const runtimeBinds = roots.flatMap((path, index) => [
      "--ro-bind",
      path,
      `/runtime/${String(index)}`
    ]);
    const runtimePaths = roots.map((_path, index) => `/runtime/${String(index)}/bin`);
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
        workspace,
        "/workspace",
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
        "PATH",
        [...runtimePaths, "/usr/bin", "/bin"].join(":"),
        "--chdir",
        "/workspace",
        "--",
        executable,
        ...command.args
      ]
    };
  }
}

function pathsOverlap(left: string, right: string): boolean {
  const child = relative(left, right);
  if (child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child))) {
    return true;
  }
  const reverse = relative(right, left);
  return (
    reverse === "" || (reverse !== ".." && !reverse.startsWith(`..${sep}`) && !isAbsolute(reverse))
  );
}

function rewriteExecutable(executable: string, runtimeRoots: readonly string[]): string {
  if (!isAbsolute(executable) || executable.includes("\0")) {
    throw new Error("Eval harness commands require absolute executable paths.");
  }
  for (const [index, root] of runtimeRoots.entries()) {
    const child = relative(root, executable);
    if (child === "") return `/runtime/${String(index)}`;
    if (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child)) {
      return join(`/runtime/${String(index)}`, child);
    }
  }
  if (executable.startsWith("/usr/")) return executable;
  throw new Error("Eval harness executable is outside trusted sandbox mounts.");
}
