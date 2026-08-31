import { lstat, realpath, rm } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { factoryPreparationPhaseSchema, gitObjectIdSchema } from "@agentlab/contracts";
import { z } from "zod";

import type {
  FactoryPreparationRecoveryInput,
  FactoryPreparationRecoveryReconciler,
  FactoryPreparationRecoveryResult
} from "../../domain/factory-preparation-recovery.js";
import {
  FactoryGitCommandRunner,
  parseFactoryGitNullList
} from "../filesystem/factory-git-command.js";
import {
  factoryPathsOverlap,
  factoryWorkspaceTarget,
  prepareFactoryWorkspaceRoot,
  prepareFactoryWorkspaceTaskDirectory,
  resolveFactoryWorkspaceRoot
} from "../filesystem/factory-workspace-paths.js";
import type { CommandRunner } from "../process/command-runner.js";
import {
  factorySystemdScopeName,
  systemdUserManagerEnvironment
} from "../process/systemd-user-manager.js";

const recoveryInputSchema = z
  .object({
    taskId: z.uuid(),
    executionId: z.uuid(),
    phase: factoryPreparationPhaseSchema,
    attempt: z.number().int().min(1).max(5),
    repositoryRoot: z
      .string()
      .min(1)
      .max(4_096)
      .refine((value) => !value.includes("\0")),
    baseRevision: gitObjectIdSchema
  })
  .strict();

const maximumGitOutputBytes = 4 * 1_024 * 1_024;
const maximumSystemdOutputBytes = 4_096;

export interface LocalFactoryPreparationRecoveryOptions {
  readonly root: string;
  readonly gitExecutable: string;
  readonly flockExecutable: string;
  readonly systemctlExecutable: string;
  readonly hostEnvironment?: NodeJS.ProcessEnv;
}

/** Reconciles only the exact execution-ID workspace after systemd proves its scope inactive. */
export class LocalFactoryPreparationRecovery implements FactoryPreparationRecoveryReconciler {
  readonly #rootPath: string;
  readonly #git: FactoryGitCommandRunner;
  readonly #systemctlExecutable: string;
  readonly #systemdEnvironment: Readonly<Record<string, string>>;
  #root: Promise<string> | null = null;

  public constructor(
    private readonly runner: CommandRunner,
    options: LocalFactoryPreparationRecoveryOptions
  ) {
    this.#rootPath = resolveFactoryWorkspaceRoot(options.root);
    this.#git = new FactoryGitCommandRunner(runner, options);
    this.#systemctlExecutable = absoluteExecutable(options.systemctlExecutable, "systemctl");
    this.#systemdEnvironment = systemdUserManagerEnvironment(
      options.hostEnvironment ?? process.env
    );
  }

  public async reconcile(
    inputValue: FactoryPreparationRecoveryInput
  ): Promise<FactoryPreparationRecoveryResult> {
    const input = recoveryInputSchema.parse(inputValue);
    const initialScope = await this.#scopeState(input.executionId);
    if (initialScope !== "inactive") return processUncertain(initialScope);

    const coordinates = await this.#coordinates(input);
    if (coordinates === null) {
      return uncertain("preparation-repository-identity-uncertain");
    }
    if (!(await this.#workspaceOperationsInactive(coordinates))) {
      return uncertain("preparation-workspace-operation-uncertain");
    }
    if (!(await this.#repositoryIdentityMatches(coordinates, input.baseRevision))) {
      return uncertain("preparation-repository-identity-uncertain");
    }
    const initialWorkspace = await workspaceState(coordinates.target);
    if (initialWorkspace === "uncertain") {
      return uncertain("preparation-workspace-identity-uncertain");
    }
    const listed = await this.#listedWorktrees(coordinates);
    if (listed === null) return uncertain("preparation-repository-identity-uncertain");

    if (initialWorkspace === "present" || listed.includes(coordinates.target)) {
      const cleanupScope = await this.#scopeState(input.executionId);
      if (cleanupScope !== "inactive") return processUncertain(cleanupScope);
      if (!(await this.#workspaceOperationsInactive(coordinates))) {
        return uncertain("preparation-workspace-operation-uncertain");
      }
      const cleaned = await this.#cleanupWorkspace(
        coordinates,
        listed.includes(coordinates.target)
      );
      if (!cleaned) return uncertain("preparation-workspace-cleanup-unconfirmed");
    }

    const [remainingWorkspace, remainingWorktrees, finalScope] = await Promise.all([
      workspaceState(coordinates.target),
      this.#listedWorktrees(coordinates),
      this.#scopeState(input.executionId)
    ]);
    if (
      remainingWorkspace !== "absent" ||
      remainingWorktrees === null ||
      remainingWorktrees.includes(coordinates.target)
    ) {
      return uncertain("preparation-workspace-cleanup-unconfirmed");
    }
    if (finalScope !== "inactive") return processUncertain(finalScope);
    return { status: "inactive" };
  }

  async #coordinates(
    input: z.infer<typeof recoveryInputSchema>
  ): Promise<RecoveryCoordinates | null> {
    try {
      this.#root ??= prepareFactoryWorkspaceRoot(this.#rootPath);
      const factoryRoot = await this.#root;
      const repositoryRoot = await canonicalDirectory(input.repositoryRoot);
      if (factoryPathsOverlap(factoryRoot, repositoryRoot)) return null;
      const lockDirectory = await prepareFactoryWorkspaceTaskDirectory(factoryRoot, input.taskId);
      return {
        repositoryRoot,
        lockDirectory,
        target: factoryWorkspaceTarget(factoryRoot, {
          taskId: input.taskId,
          attempt: input.attempt,
          workspaceId: input.executionId
        })
      };
    } catch {
      return null;
    }
  }

  async #repositoryIdentityMatches(
    coordinates: RecoveryCoordinates,
    baseRevision: string
  ): Promise<boolean> {
    try {
      const topLevel = (
        await this.#runGit(coordinates, ["rev-parse", "--path-format=absolute", "--show-toplevel"])
      ).stdout.trim();
      if ((await realpath(topLevel)) !== coordinates.repositoryRoot) return false;
      const resolvedBaseRevision = (
        await this.#runGit(coordinates, ["rev-parse", "--verify", `${baseRevision}^{commit}`])
      ).stdout.trim();
      return resolvedBaseRevision === baseRevision;
    } catch {
      return false;
    }
  }

  async #cleanupWorkspace(coordinates: RecoveryCoordinates, registered: boolean): Promise<boolean> {
    const { target } = coordinates;
    try {
      if (registered) {
        const state = await workspaceState(target);
        if (state === "uncertain") return false;
        if (state === "present" && (await realpath(target)) !== target) return false;
        try {
          await this.#runGit(coordinates, ["worktree", "remove", "--force", target]);
        } catch {
          // Exact postconditions below remain authoritative if Git partially completed cleanup.
        }
      } else {
        const state = await workspaceState(target);
        if (state !== "present") return state === "absent";
        if ((await realpath(target)) !== target) return false;
        await rm(target, { force: false, recursive: true, maxRetries: 2, retryDelay: 10 });
      }
      const [remaining, worktrees] = await Promise.all([
        workspaceState(target),
        this.#listedWorktrees(coordinates)
      ]);
      return remaining === "absent" && worktrees !== null && !worktrees.includes(target);
    } catch {
      return false;
    }
  }

  async #listedWorktrees(coordinates: RecoveryCoordinates): Promise<readonly string[] | null> {
    try {
      const output = (await this.#runGit(coordinates, ["worktree", "list", "--porcelain", "-z"]))
        .stdout;
      return parseFactoryGitNullList(output).flatMap((field) =>
        field.startsWith("worktree ") ? [field.slice("worktree ".length)] : []
      );
    } catch {
      return null;
    }
  }

  async #workspaceOperationsInactive(coordinates: RecoveryCoordinates): Promise<boolean> {
    try {
      await this.#runGit(coordinates, ["--version"]);
      return true;
    } catch {
      return false;
    }
  }

  async #scopeState(executionId: string): Promise<ScopeState> {
    try {
      const scopeName = factorySystemdScopeName(executionId);
      const result = await this.runner.run(
        this.#systemctlExecutable,
        [
          "--user",
          "show",
          scopeName,
          "--property=LoadState",
          "--property=ActiveState",
          "--property=SubState",
          "--no-pager"
        ],
        {
          timeoutMs: 10_000,
          maxBufferBytes: maximumSystemdOutputBytes,
          maxCombinedBufferBytes: maximumSystemdOutputBytes,
          cleanupProcessTree: true,
          environment: this.#systemdEnvironment
        }
      );
      const properties = parseSystemdProperties(result.stdout);
      if (properties === null) return "uncertain";
      if (properties.LoadState !== "loaded" && properties.LoadState !== "not-found") {
        return "uncertain";
      }
      return properties.ActiveState === "inactive" && properties.SubState === "dead"
        ? "inactive"
        : "active";
    } catch {
      return "uncertain";
    }
  }

  #runGit(coordinates: RecoveryCoordinates, args: readonly string[]) {
    return this.#git.run(coordinates.repositoryRoot, args, {
      timeoutMs: 60_000,
      maxBufferBytes: maximumGitOutputBytes,
      maxCombinedBufferBytes: maximumGitOutputBytes,
      lock: { directory: coordinates.lockDirectory, mode: "non-blocking" }
    });
  }
}

type ScopeState = "active" | "inactive" | "uncertain";
type WorkspaceState = "absent" | "present" | "uncertain";

interface RecoveryCoordinates {
  readonly repositoryRoot: string;
  readonly target: string;
  readonly lockDirectory: string;
}

async function workspaceState(target: string): Promise<WorkspaceState> {
  try {
    const metadata = await lstat(target);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return "uncertain";
    return "present";
  } catch (error: unknown) {
    return hasErrorCode(error, "ENOENT") ? "absent" : "uncertain";
  }
}

async function canonicalDirectory(path: string): Promise<string> {
  const canonical = await realpath(path);
  const metadata = await lstat(canonical);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || canonical !== resolve(path)) {
    throw new Error(`${path} is not a canonical directory.`);
  }
  return canonical;
}

function parseSystemdProperties(output: string): {
  readonly LoadState: string;
  readonly ActiveState: string;
  readonly SubState: string;
} | null {
  const entries = new Map<string, string>();
  for (const line of output.split("\n")) {
    if (line.length === 0) continue;
    const separator = line.indexOf("=");
    if (separator < 1) return null;
    const key = line.slice(0, separator);
    const value = line.slice(separator + 1);
    if (entries.has(key)) return null;
    entries.set(key, value);
  }
  const loadState = entries.get("LoadState");
  const activeState = entries.get("ActiveState");
  const subState = entries.get("SubState");
  if (
    entries.size !== 3 ||
    loadState === undefined ||
    activeState === undefined ||
    subState === undefined
  ) {
    return null;
  }
  return { LoadState: loadState, ActiveState: activeState, SubState: subState };
}

function absoluteExecutable(value: string, label: string): string {
  if (!isAbsolute(value) || value.includes("\0")) {
    throw new Error(`${label} recovery executable must be an absolute safe path.`);
  }
  return value;
}

function processUncertain(state: ScopeState): FactoryPreparationRecoveryResult {
  return uncertain(
    state === "active" ? "preparation-process-not-inactive" : "preparation-process-state-uncertain"
  );
}

function uncertain(
  reasonCode: Extract<
    FactoryPreparationRecoveryResult,
    { readonly status: "uncertain" }
  >["reasonCode"]
): FactoryPreparationRecoveryResult {
  return { status: "uncertain", reasonCode };
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
