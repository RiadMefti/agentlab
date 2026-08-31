import { lstat, realpath, rm } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

import { gitObjectIdSchema } from "@agentlab/contracts";
import { z } from "zod";

import type {
  FactoryWorkspaceRecoveryInput,
  FactoryWorkspaceRecoveryReason,
  FactoryWorkspaceRecoveryReconciler,
  FactoryWorkspaceRecoveryResult
} from "../../domain/factory-workspace-recovery.js";
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
    workspaceId: z.uuid(),
    attempt: z.number().int().min(1).max(20),
    repositoryRoot: z
      .string()
      .min(1)
      .max(4_096)
      .refine((value) => !value.includes("\0")),
    baseRevision: gitObjectIdSchema,
    processExecutionIds: z.array(z.uuid()).max(64)
  })
  .strict()
  .superRefine((input, context) => {
    if (new Set(input.processExecutionIds).size !== input.processExecutionIds.length) {
      context.addIssue({
        code: "custom",
        path: ["processExecutionIds"],
        message: "Recovery process identities must be unique."
      });
    }
  });

const maximumGitOutputBytes = 4 * 1_024 * 1_024;
const maximumSystemdOutputBytes = 4_096;

export interface LocalFactoryWorkspaceRecoveryOptions {
  readonly root: string;
  readonly gitExecutable: string;
  readonly flockExecutable: string;
  readonly systemctlExecutable: string;
  readonly hostEnvironment?: NodeJS.ProcessEnv;
}

/** Shared local reconciler for exact journal-bound systemd scopes and Git worktrees. */
export class LocalFactoryWorkspaceRecovery implements FactoryWorkspaceRecoveryReconciler {
  readonly #rootPath: string;
  readonly #git: FactoryGitCommandRunner;
  readonly #systemctlExecutable: string;
  readonly #systemdEnvironment: Readonly<Record<string, string>>;
  #root: Promise<string> | null = null;

  public constructor(
    private readonly runner: CommandRunner,
    options: LocalFactoryWorkspaceRecoveryOptions
  ) {
    this.#rootPath = resolveFactoryWorkspaceRoot(options.root);
    this.#git = new FactoryGitCommandRunner(runner, options);
    this.#systemctlExecutable = absoluteExecutable(options.systemctlExecutable, "systemctl");
    this.#systemdEnvironment = systemdUserManagerEnvironment(
      options.hostEnvironment ?? process.env
    );
  }

  public async reconcile(
    inputValue: FactoryWorkspaceRecoveryInput
  ): Promise<FactoryWorkspaceRecoveryResult> {
    const input = recoveryInputSchema.parse(inputValue);
    const initialScopes = await this.#scopeState(input.processExecutionIds);
    if (initialScopes !== "inactive") return processUncertain(initialScopes);

    const coordinates = await this.#coordinates(input);
    if (coordinates === null) return uncertain("repository-identity-uncertain");
    if (!(await this.#workspaceOperationsInactive(coordinates))) {
      return uncertain("workspace-operation-uncertain");
    }
    if (!(await this.#repositoryIdentityMatches(coordinates, input.baseRevision))) {
      return uncertain("repository-identity-uncertain");
    }
    const initialWorkspace = await workspaceState(coordinates.target);
    if (initialWorkspace === "uncertain") return uncertain("workspace-identity-uncertain");
    const listed = await this.#listedWorktrees(coordinates);
    if (listed === null) return uncertain("repository-identity-uncertain");

    if (initialWorkspace === "present" || listed.includes(coordinates.target)) {
      const cleanupScopes = await this.#scopeState(input.processExecutionIds);
      if (cleanupScopes !== "inactive") return processUncertain(cleanupScopes);
      if (!(await this.#workspaceOperationsInactive(coordinates))) {
        return uncertain("workspace-operation-uncertain");
      }
      if (!(await this.#cleanupWorkspace(coordinates, listed.includes(coordinates.target)))) {
        return uncertain("workspace-cleanup-unconfirmed");
      }
    }

    const [remainingWorkspace, remainingWorktrees, finalScopes] = await Promise.all([
      workspaceState(coordinates.target),
      this.#listedWorktrees(coordinates),
      this.#scopeState(input.processExecutionIds)
    ]);
    if (
      remainingWorkspace !== "absent" ||
      remainingWorktrees === null ||
      remainingWorktrees.includes(coordinates.target)
    ) {
      return uncertain("workspace-cleanup-unconfirmed");
    }
    if (finalScopes !== "inactive") return processUncertain(finalScopes);
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
          workspaceId: input.workspaceId
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
          // Exact postconditions below remain authoritative after partial Git cleanup.
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

  async #scopeState(executionIds: readonly string[]): Promise<ScopeState> {
    const states = await Promise.all(
      executionIds.map((executionId) => this.#oneScope(executionId))
    );
    if (states.includes("active")) return "active";
    return states.includes("uncertain") ? "uncertain" : "inactive";
  }

  async #oneScope(executionId: string): Promise<ScopeState> {
    try {
      const result = await this.runner.run(
        this.#systemctlExecutable,
        [
          "--user",
          "show",
          factorySystemdScopeName(executionId),
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
      if (
        properties === null ||
        (properties.LoadState !== "loaded" && properties.LoadState !== "not-found")
      ) {
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
    if (entries.has(key)) return null;
    entries.set(key, line.slice(separator + 1));
  }
  const LoadState = entries.get("LoadState");
  const ActiveState = entries.get("ActiveState");
  const SubState = entries.get("SubState");
  return entries.size === 3 &&
    LoadState !== undefined &&
    ActiveState !== undefined &&
    SubState !== undefined
    ? { LoadState, ActiveState, SubState }
    : null;
}

function absoluteExecutable(value: string, label: string): string {
  if (!isAbsolute(value) || value.includes("\0")) {
    throw new Error(`${label} recovery executable must be an absolute safe path.`);
  }
  return value;
}

function processUncertain(state: ScopeState): FactoryWorkspaceRecoveryResult {
  return uncertain(state === "active" ? "process-not-inactive" : "process-state-uncertain");
}

function uncertain(reasonCode: FactoryWorkspaceRecoveryReason): FactoryWorkspaceRecoveryResult {
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
