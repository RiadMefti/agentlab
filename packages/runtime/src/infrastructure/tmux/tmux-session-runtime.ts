import { sessionHistoryLimit, type AgentSession } from "@agentlab/contracts";

import { parseSessionName, sessionLabel } from "../../domain/agent-session-name.js";
import { preservePrimaryFailure } from "../../domain/compensation.js";
import { ConflictError } from "../../domain/errors.js";
import type {
  CreateCaptainSessionInput,
  CreateWorkerSessionInput,
  SessionRuntime
} from "../../domain/session-runtime.js";
import { type CommandRunner, errorOutput } from "../process/command-runner.js";
import { withTimeout } from "../../domain/promise-timeout.js";
import { renderShellCommand } from "./shell-command.js";

// tmux 3.4 escapes control characters in format output, so keep this printable.
// Managed session names and the remaining numeric fields cannot contain a pipe.
const FIELD_SEPARATOR = "|";
const TMUX_COMMAND_TIMEOUT_MS = 3_000;
const TMUX_CLEANUP_ALLOWANCE_MS = 3_000;
const SESSION_FORMAT = [
  "#{session_name}",
  "#{session_created}",
  "#{session_attached}",
  "#{pane_dead}"
].join(FIELD_SEPARATOR);

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
    if (await this.exists(input.name)) {
      throw new ConflictError("That session already exists.");
    }

    try {
      await this.runTmux([
        "new-session",
        "-d",
        "-s",
        input.name,
        "-c",
        input.cwd,
        "-x",
        "120",
        "-y",
        "40"
      ]);
      await this.runTmux([
        "set-window-option",
        "-t",
        windowTarget(input.name),
        "remain-on-exit",
        "on"
      ]);
      await this.runTmux([
        "set-window-option",
        "-t",
        windowTarget(input.name),
        "history-limit",
        String(sessionHistoryLimit)
      ]);
      await this.runTmux(["set-option", "-t", input.name, "status", "off"]);
      await this.runTmux([
        "respawn-pane",
        "-k",
        "-t",
        windowTarget(input.name),
        "-c",
        input.cwd,
        renderShellCommand(input.command)
      ]);
    } catch (error: unknown) {
      try {
        await this.kill(input.name);
      } catch (compensationError: unknown) {
        throw preservePrimaryFailure(error, compensationError);
      }
      throw error;
    }
  }

  public async kill(name: string): Promise<void> {
    assertManagedName(name);
    try {
      await this.runTmux(["kill-session", "-t", exactTarget(name)]);
    } catch (error: unknown) {
      if (!isMissingSessionError(error)) throw error;
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
    let stdout: string;
    try {
      ({ stdout } = await this.runTmux(["list-sessions", "-F", SESSION_FORMAT]));
    } catch (error: unknown) {
      if (isMissingSessionError(error)) return [];
      throw error;
    }

    return stdout
      .split(/\r?\n/u)
      .filter(Boolean)
      .map(parseTmuxLine)
      .filter((session): session is AgentSession => session !== null)
      .filter((session) => session.conversationId === conversationId);
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
}

export interface TmuxSessionRuntimeOptions {
  readonly commandTimeoutMs?: number;
  readonly cleanupAllowanceMs?: number;
}

function parseTmuxLine(line: string): AgentSession | null {
  const [name, created, attached, paneDead] = line.split(FIELD_SEPARATOR);
  if (name === undefined) return null;
  const parsed = parseSessionName(name);
  if (parsed === null) return null;

  const epochSeconds =
    created === undefined || created.trim() === "" ? Number.NaN : Number(created);
  const startedAtDate = new Date(epochSeconds * 1_000);
  const startedAt =
    Number.isFinite(epochSeconds) && !Number.isNaN(startedAtDate.getTime())
      ? startedAtDate.toISOString()
      : null;

  return {
    name,
    conversationId: parsed.conversationId,
    role: parsed.role,
    provider: parsed.provider,
    label: sessionLabel(parsed),
    // Keep a managed session visible when optional tmux status fields are malformed. The exact
    // name remains the ownership boundary; conservative status defaults are safer than hiding it.
    status: paneDead === "1" ? "stopped" : "running",
    attached: Number(attached) > 0,
    startedAt
  };
}

function exactTarget(name: string): string {
  return `=${name}`;
}

function windowTarget(name: string): string {
  return `${name}:`;
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
