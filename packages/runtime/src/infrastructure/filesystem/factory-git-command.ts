import { isAbsolute } from "node:path";

import type { CommandRunner } from "../process/command-runner.js";

const factoryGitEnvironment = Object.freeze({
  GIT_ATTR_NOSYSTEM: "1",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_LFS_SKIP_SMUDGE: "1",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_PAGER: "cat",
  GIT_TERMINAL_PROMPT: "0",
  LC_ALL: "C",
  PATH: "/usr/local/bin:/usr/bin:/bin"
});

export interface FactoryGitCommandOptions {
  readonly timeoutMs: number;
  readonly maxBufferBytes: number;
  readonly maxCombinedBufferBytes?: number;
  readonly stdin?: string;
  readonly maxInputBytes?: number;
  readonly lock?: {
    readonly directory: string;
    readonly mode: "blocking" | "non-blocking";
  };
}

export interface FactoryGitCommandRunnerOptions {
  readonly gitExecutable: string;
  readonly flockExecutable: string;
}

/** Runs hardened Git argument vectors, optionally under one kernel-owned workspace lock. */
export class FactoryGitCommandRunner {
  readonly #gitExecutable: string;
  readonly #flockExecutable: string;

  public constructor(
    private readonly runner: CommandRunner,
    options: FactoryGitCommandRunnerOptions
  ) {
    this.#gitExecutable = absoluteExecutable(options.gitExecutable, "Git");
    this.#flockExecutable = absoluteExecutable(options.flockExecutable, "flock");
  }

  public run(root: string, args: readonly string[], options: FactoryGitCommandOptions) {
    if (args.length > 512 || args.some((argument) => !safeArgument(argument))) {
      throw new Error("Factory Git arguments exceed their process-boundary limits.");
    }
    const gitArguments = [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.untrackedCache=false",
      "-C",
      safeAbsolutePath(root, "Factory Git working root"),
      ...args
    ];
    const executable = options.lock === undefined ? this.#gitExecutable : this.#flockExecutable;
    const commandArguments =
      options.lock === undefined
        ? gitArguments
        : [
            "--exclusive",
            ...(options.lock.mode === "non-blocking" ? ["--nonblock"] : []),
            "--",
            safeAbsolutePath(options.lock.directory, "Factory Git lock directory"),
            this.#gitExecutable,
            ...gitArguments
          ];
    return this.runner.run(executable, commandArguments, {
      timeoutMs: options.timeoutMs,
      maxBufferBytes: options.maxBufferBytes,
      ...(options.maxCombinedBufferBytes === undefined
        ? {}
        : { maxCombinedBufferBytes: options.maxCombinedBufferBytes }),
      cleanupProcessTree: true,
      ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
      ...(options.maxInputBytes === undefined ? {} : { maxInputBytes: options.maxInputBytes }),
      environment: factoryGitEnvironment
    });
  }
}

export function parseFactoryGitNullList(output: string): readonly string[] {
  if (output.length === 0) return [];
  if (!output.endsWith("\0")) throw new Error("Git NUL-delimited output is truncated.");
  return output.slice(0, -1).split("\0");
}

function absoluteExecutable(value: string, label: string): string {
  return safeAbsolutePath(value, `Factory ${label} executable`);
}

function safeAbsolutePath(value: string, label: string): string {
  if (!isAbsolute(value) || !safeArgument(value)) {
    throw new Error(`${label} must be an absolute safe path.`);
  }
  return value;
}

function safeArgument(value: string): boolean {
  return value.length <= 4_096 && !value.includes("\0");
}
