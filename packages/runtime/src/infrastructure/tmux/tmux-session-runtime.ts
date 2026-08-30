import type { AgentSession } from "@agentlab/contracts";

import { parseSessionName, sessionLabel } from "../../domain/agent-session-name.js";
import { preservePrimaryFailure } from "../../domain/compensation.js";
import { ConflictError } from "../../domain/errors.js";
import type {
  CreateCaptainSessionInput,
  CreateWorkerSessionInput,
  OwnedSessionKillResult,
  OwnedSessionResolution,
  SessionCreationCleanup,
  SessionAttachmentTarget,
  SessionInventoryEntry,
  SessionOwnership,
  SessionOwnershipInspection,
  SessionRuntime
} from "../../domain/session-runtime.js";
import {
  maximumManagedSessionInventory,
  SessionCreationError,
  sessionOwnershipEnvironmentVariable
} from "../../domain/session-runtime.js";
import { type CommandRunner, errorOutput } from "../process/command-runner.js";
import { withTimeout } from "../process/promise-timeout.js";
import { guardedTmuxArguments, ownedSessionGuardRejected } from "./owned-session-guard.js";
import { renderShellCommand } from "./shell-command.js";
import { sessionHistoryLimit } from "./tmux-policy.js";

// tmux 3.4 escapes control characters in format output, so keep this printable.
// Managed session names and the remaining numeric fields cannot contain a pipe.
const FIELD_SEPARATOR = "|";
const TMUX_COMMAND_TIMEOUT_MS = 3_000;
const TMUX_CLEANUP_ALLOWANCE_MS = 3_000;
const SESSION_FORMAT = [
  "#{session_name}",
  "#{session_created}",
  "#{session_attached}",
  "#{pane_dead}",
  "#{session_id}",
  "#{pid}",
  "#{start_time}",
  `#{E:${sessionOwnershipEnvironmentVariable}}`
].join(FIELD_SEPARATOR);
const SESSION_TARGET_FORMAT = ["#{session_id}", "#{pid}", "#{start_time}"].join(FIELD_SEPARATOR);

/** Durable SessionRuntime adapter backed by exact, app-owned tmux names. */
export class TmuxSessionRuntime implements SessionRuntime {
  public constructor(
    private readonly runner: CommandRunner,
    private readonly socketPath?: string,
    private readonly options: TmuxSessionRuntimeOptions = {}
  ) {}

  public async createCaptain(input: CreateCaptainSessionInput): Promise<void> {
    await this.createManagedSession(input, "captain");
  }

  public async createWorker(input: CreateWorkerSessionInput): Promise<void> {
    await this.createManagedSession(input, "worker");
  }

  private async createManagedSession(
    input: CreateCaptainSessionInput | CreateWorkerSessionInput,
    expectedRole: "captain" | "worker"
  ): Promise<void> {
    const identity = parseSessionName(input.name);
    if (identity?.role !== expectedRole) {
      throw new Error(`The app may create only a managed ${expectedRole} session.`);
    }
    let createdHere = false;
    let createdTarget: SessionAttachmentTarget | null = null;
    try {
      const ownershipArguments =
        input.ownership.mode === "nonce"
          ? ["-e", `${sessionOwnershipEnvironmentVariable}=${input.ownership.nonce}`]
          : [];
      const { stdout } = await this.runTmux([
        "new-session",
        "-d",
        "-P",
        "-F",
        SESSION_TARGET_FORMAT,
        "-s",
        input.name,
        ...ownershipArguments,
        "-c",
        input.cwd,
        "-x",
        "120",
        "-y",
        "40"
      ]);
      createdHere = true;
      createdTarget = parseSessionTarget(input.name, input.ownership, stdout);
      if (createdTarget === null) {
        throw new Error("tmux did not return a valid identity for the newly created session.");
      }
      const createdOwnership = await this.inspectOwnershipByTarget(createdTarget);
      if (
        createdOwnership.status === "absent" ||
        (input.ownership.mode === "nonce" && createdOwnership.nonce !== input.ownership.nonce)
      ) {
        throw new ConflictError("The newly created session does not have its ownership proof.");
      }
      await this.runOwnedTmux(createdTarget, [
        "set-window-option",
        "-t",
        sessionWindowTarget(createdTarget.runtimeId),
        "remain-on-exit",
        "on"
      ]);
      await this.runOwnedTmux(createdTarget, [
        "set-window-option",
        "-t",
        sessionWindowTarget(createdTarget.runtimeId),
        "history-limit",
        String(sessionHistoryLimit)
      ]);
      await this.runOwnedTmux(createdTarget, [
        "set-option",
        "-t",
        createdTarget.runtimeId,
        "status",
        "off"
      ]);
      await this.runOwnedTmux(createdTarget, [
        "respawn-pane",
        "-k",
        "-t",
        sessionWindowTarget(createdTarget.runtimeId),
        "-c",
        input.cwd,
        renderShellCommand(input.command)
      ]);
    } catch (error: unknown) {
      let cleanup: SessionCreationCleanup = "unconfirmed";
      let cause = error;
      if (createdHere && createdTarget !== null) {
        try {
          const result = await this.killResolvedSession(createdTarget);
          if (result === "ownership-mismatch") {
            throw new ConflictError(
              "The created session no longer has the expected ownership proof."
            );
          }
          cleanup = "confirmed-absent";
        } catch (compensationError: unknown) {
          cause = preservePrimaryFailure(error, compensationError);
        }
      }
      throw new SessionCreationError(error, cleanup, cause);
    }
  }

  public async inspectOwnership(name: string): Promise<SessionOwnershipInspection> {
    assertManagedName(name);
    const target = await this.resolveSessionTarget(name, { mode: "legacy-name" });
    if (target === null) return { status: "absent" };
    return this.inspectOwnershipByTarget(target);
  }

  private async resolveSessionTarget(
    name: string,
    ownership: SessionOwnership
  ): Promise<SessionAttachmentTarget | null> {
    try {
      const { stdout } = await this.runTmux([
        "display-message",
        "-p",
        "-t",
        windowTarget(name),
        SESSION_TARGET_FORMAT
      ]);
      const target = parseSessionTarget(name, ownership, stdout);
      if (target === null) throw new Error("tmux returned an invalid managed-session identity.");
      return target;
    } catch (error: unknown) {
      if (isMissingSessionError(error)) return null;
      throw error;
    }
  }

  private async inspectOwnershipByTarget(
    target: SessionAttachmentTarget
  ): Promise<SessionOwnershipInspection> {
    const generationOnlyTarget: SessionAttachmentTarget = {
      ...target,
      ownership: { mode: "legacy-name" }
    };
    try {
      const { stdout } = await this.runTmux(
        guardedTmuxArguments(generationOnlyTarget, [
          "show-environment",
          "-t",
          target.runtimeId,
          sessionOwnershipEnvironmentVariable
        ])
      );
      if (ownedSessionGuardRejected(stdout)) {
        throw new ConflictError(
          "The managed session generation changed while ownership was inspected."
        );
      }
      const prefix = `${sessionOwnershipEnvironmentVariable}=`;
      const line = stdout
        .split(/\r?\n/u)
        .map((value) => value.trim())
        .find((value) => value.startsWith(prefix));
      return {
        status: "present",
        nonce: line === undefined ? null : line.slice(prefix.length)
      };
    } catch (error: unknown) {
      if (isMissingSessionError(error)) return { status: "absent" };
      if (isMissingEnvironmentError(error)) return { status: "present", nonce: null };
      throw error;
    }
  }

  public async resolveOwnedTarget(
    name: string,
    ownership: SessionOwnership
  ): Promise<OwnedSessionResolution> {
    assertManagedName(name);
    const target = await this.resolveSessionTarget(name, ownership);
    if (target === null) return { status: "absent" };
    if (ownership.mode === "nonce") {
      const inspection = await this.inspectOwnershipByTarget(target);
      if (inspection.status === "absent") return { status: "absent" };
      if (inspection.nonce !== ownership.nonce) return { status: "ownership-mismatch" };
    }
    return {
      status: "owned",
      target
    };
  }

  public async killOwned(
    name: string,
    ownership: SessionOwnership
  ): Promise<OwnedSessionKillResult> {
    assertManagedName(name);
    const target = await this.resolveSessionTarget(name, ownership);
    if (target === null) return "absent";
    return this.killResolvedSession(target);
  }

  private async killResolvedSession(
    target: SessionAttachmentTarget
  ): Promise<OwnedSessionKillResult> {
    try {
      const { stdout } = await this.runTmux(
        guardedTmuxArguments(target, ["kill-session", "-t", target.runtimeId])
      );
      if (ownedSessionGuardRejected(stdout)) return "ownership-mismatch";
      return "killed";
    } catch (error: unknown) {
      if (isMissingSessionError(error)) return "absent";
      throw error;
    }
  }

  public async exists(name: string): Promise<boolean> {
    assertManagedName(name);
    try {
      await this.runTmux(["has-session", "-t", exactTarget(name)]);
      return true;
    } catch (error: unknown) {
      if (isMissingSessionError(error)) return false;
      throw error;
    }
  }

  public async list(conversationId: string): Promise<readonly AgentSession[]> {
    return (await this.listInventory(conversationId)).map(({ session }) => session);
  }

  public async listInventory(conversationId: string): Promise<readonly SessionInventoryEntry[]> {
    let stdout: string;
    try {
      ({ stdout } = await this.runTmux(["list-sessions", "-F", SESSION_FORMAT]));
    } catch (error: unknown) {
      if (isMissingSessionError(error)) return [];
      throw error;
    }

    const inventory: SessionInventoryEntry[] = [];
    let generation: string | null = null;
    for (const line of stdout.split(/\r?\n/u).filter(Boolean)) {
      const name = line.split(FIELD_SEPARATOR, 1)[0];
      if (name === undefined || parseSessionName(name) === null) continue;
      const entry = parseTmuxLine(line);
      if (entry === null) {
        throw new Error("tmux returned malformed identity data for a managed session.");
      }
      const entryGeneration = `${entry.serverPid}\0${entry.serverStartedAt}`;
      if (generation !== null && generation !== entryGeneration) {
        throw new ConflictError("tmux returned a mixed-generation managed-session inventory.");
      }
      generation = entryGeneration;
      if (entry.inventory.session.conversationId !== conversationId) continue;
      inventory.push(entry.inventory);
      if (inventory.length > maximumManagedSessionInventory) {
        throw new ConflictError(
          `Managed-session inventory exceeds the safe limit of ${String(maximumManagedSessionInventory)}.`
        );
      }
    }
    return inventory;
  }

  private tmuxArgs(args: readonly string[]): readonly string[] {
    return this.socketPath === undefined ? args : ["-S", this.socketPath, ...args];
  }

  private runTmux(args: readonly string[]) {
    const commandTimeoutMs = this.options.commandTimeoutMs ?? TMUX_COMMAND_TIMEOUT_MS;
    return withTimeout(
      this.runner.run("tmux", this.tmuxArgs(args), {
        timeoutMs: commandTimeoutMs,
        cleanupProcessTree: true
      }),
      {
        timeoutMs:
          commandTimeoutMs + (this.options.cleanupAllowanceMs ?? TMUX_CLEANUP_ALLOWANCE_MS),
        message: `tmux ${args[0] ?? "command"} did not finish within its cleanup deadline.`
      }
    );
  }

  private async runOwnedTmux(
    target: SessionAttachmentTarget,
    action: readonly string[]
  ): Promise<void> {
    const { stdout } = await this.runTmux(guardedTmuxArguments(target, action));
    if (ownedSessionGuardRejected(stdout)) {
      throw new ConflictError("The managed session changed before its tmux action completed.");
    }
  }
}

export interface TmuxSessionRuntimeOptions {
  readonly commandTimeoutMs?: number;
  readonly cleanupAllowanceMs?: number;
}

interface ParsedTmuxInventoryLine {
  readonly inventory: SessionInventoryEntry;
  readonly serverPid: string;
  readonly serverStartedAt: string;
}

function parseTmuxLine(line: string): ParsedTmuxInventoryLine | null {
  const [
    name,
    created,
    attached,
    paneDead,
    runtimeId,
    serverPid,
    serverStartedAt,
    ownershipNonce,
    ...extra
  ] = line.split(FIELD_SEPARATOR);
  if (name === undefined || extra.length > 0) return null;
  const parsed = parseSessionName(name);
  if (parsed === null) return null;
  if (
    runtimeId === undefined ||
    serverPid === undefined ||
    serverStartedAt === undefined ||
    ownershipNonce === undefined ||
    !/^\$\d+$/u.test(runtimeId) ||
    !/^\d+$/u.test(serverPid) ||
    !/^\d+$/u.test(serverStartedAt)
  ) {
    return null;
  }

  const epochSeconds =
    created === undefined || created.trim() === "" ? Number.NaN : Number(created);
  const startedAtDate = new Date(epochSeconds * 1_000);
  const startedAt =
    Number.isFinite(epochSeconds) && !Number.isNaN(startedAtDate.getTime())
      ? startedAtDate.toISOString()
      : null;

  return {
    inventory: {
      session: {
        name,
        conversationId: parsed.conversationId,
        role: parsed.role,
        provider: parsed.provider,
        label: sessionLabel(parsed),
        // Keep a managed session visible when optional tmux status fields are malformed. Exact
        // identity fields remain mandatory; conservative display status is safer than hiding it.
        status: paneDead === "1" ? "stopped" : "running",
        attached: Number(attached) > 0,
        startedAt
      },
      ownershipNonce: ownershipNonce === "" ? null : ownershipNonce
    },
    serverPid,
    serverStartedAt
  };
}

function exactTarget(name: string): string {
  return `=${name}`;
}

function windowTarget(name: string): string {
  return `=${name}:`;
}

function sessionWindowTarget(sessionId: string): string {
  return `${sessionId}:`;
}

function parseSessionTarget(
  sessionName: string,
  ownership: SessionOwnership,
  output: string
): SessionAttachmentTarget | null {
  const lines = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 1) return null;
  const [runtimeId, serverPid, serverStartedAt, ...extra] = lines[0]?.split(FIELD_SEPARATOR) ?? [];
  if (
    extra.length > 0 ||
    runtimeId === undefined ||
    serverPid === undefined ||
    serverStartedAt === undefined ||
    !/^\$\d+$/u.test(runtimeId) ||
    !/^\d+$/u.test(serverPid) ||
    !/^\d+$/u.test(serverStartedAt)
  ) {
    return null;
  }
  return { sessionName, runtimeId, serverPid, serverStartedAt, ownership };
}

function assertManagedName(name: string): void {
  if (parseSessionName(name) === null) {
    throw new Error("Refusing to target an unmanaged tmux session.");
  }
}

function isMissingSessionError(error: unknown): boolean {
  const output = errorOutput(error).toLowerCase();
  return (
    output.includes("no server running") ||
    output.includes("server exited unexpectedly") ||
    output.includes("can't find session") ||
    output.includes("no sessions") ||
    (output.includes("error connecting to") && output.includes("no such file or directory"))
  );
}

function isMissingEnvironmentError(error: unknown): boolean {
  const output = errorOutput(error).toLowerCase();
  return output.includes("unknown variable") || output.includes("unknown environment variable");
}
