import type { SessionAttachmentTarget } from "../../domain/session-runtime.js";
import { sessionOwnershipEnvironmentVariable } from "../../domain/session-runtime.js";
import { parseSessionName } from "../../domain/agent-session-name.js";
import { quotePosix } from "./shell-command.js";

export const rejectedOwnedSessionGuardOutput = "__AGENTLAB_OWNED_SESSION_GUARD_REJECTED__";

const TMUX_ID = /^\$\d+$/u;
const TMUX_GENERATION_VALUE = /^\d+$/u;
const SAFE_NONCE = /^[0-9a-fA-F-]{36}$/u;

/**
 * Runs proof and action inside one tmux server command. A restarted server may reuse `$0`, but its
 * pid/start-time generation cannot pass this guard. Nonce-owned sessions are checked in the same
 * target context immediately before the action is dispatched.
 */
export function guardedTmuxArguments(
  target: SessionAttachmentTarget,
  action: readonly string[]
): readonly string[] {
  assertSessionAttachmentTarget(target);
  if (action.length === 0 || action.some((value) => value.includes("\0"))) {
    throw new Error("A guarded tmux action must contain safe argument tokens.");
  }

  const generation = `#{&&:#{==:#{pid},${target.serverPid}},#{==:#{start_time},${target.serverStartedAt}}}`;
  const immutableIdentity = `#{&&:#{==:#{session_name},${target.sessionName}},${generation}}`;
  const condition =
    target.ownership.mode === "legacy-name"
      ? immutableIdentity
      : `#{&&:${immutableIdentity},#{==:#{E:${sessionOwnershipEnvironmentVariable}},${target.ownership.nonce}}}`;
  const actionCommand = action.map(quotePosix).join(" ");
  return [
    "if-shell",
    "-F",
    "-t",
    `${target.runtimeId}:`,
    condition,
    actionCommand,
    `display-message -p ${rejectedOwnedSessionGuardOutput}`
  ];
}

export function ownedSessionGuardRejected(stdout: string): boolean {
  return stdout.trim() === rejectedOwnedSessionGuardOutput;
}

export function assertSessionAttachmentTarget(target: SessionAttachmentTarget): void {
  if (parseSessionName(target.sessionName) === null) {
    throw new Error("Invalid managed tmux session name.");
  }
  if (!TMUX_ID.test(target.runtimeId)) {
    throw new Error("Invalid immutable tmux session identifier.");
  }
  if (
    !TMUX_GENERATION_VALUE.test(target.serverPid) ||
    !TMUX_GENERATION_VALUE.test(target.serverStartedAt)
  ) {
    throw new Error("Invalid tmux server generation.");
  }
  if (target.ownership.mode === "nonce" && !SAFE_NONCE.test(target.ownership.nonce)) {
    throw new Error("Invalid tmux ownership proof.");
  }
}
