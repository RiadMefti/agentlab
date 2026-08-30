import { sessionHistoryLimit } from "../tmux/tmux-policy.js";
import type { ManagedTerminalHistoryReader } from "../../domain/terminal.js";
import type { SessionAttachmentTarget } from "../../domain/session-runtime.js";
import type { CommandRunner } from "../process/command-runner.js";
import { guardedTmuxArguments, ownedSessionGuardRejected } from "../tmux/owned-session-guard.js";

/** Seeds only durable scrollback; live attach remains authoritative for the viewport and VT state. */
export class TmuxTerminalHistoryReader implements ManagedTerminalHistoryReader {
  public constructor(private readonly runner: CommandRunner) {}

  public async read(target: SessionAttachmentTarget): Promise<string> {
    try {
      const windowTarget = `${target.runtimeId}:`;
      const { stdout: historySizeOutput } = await this.runner.run(
        "tmux",
        guardedTmuxArguments(target, [
          "display-message",
          "-p",
          "-t",
          windowTarget,
          "#{history_size}"
        ]),
        { maxBufferBytes: 1_024, timeoutMs: 2_000 }
      );
      if (ownedSessionGuardRejected(historySizeOutput)) return "";
      const historySize = Number(historySizeOutput.trim());
      if (!Number.isSafeInteger(historySize) || historySize <= 0) return "";
      const { stdout } = await this.runner.run(
        "tmux",
        guardedTmuxArguments(target, [
          "capture-pane",
          "-p",
          "-e",
          "-J",
          "-S",
          `-${String(sessionHistoryLimit)}`,
          "-E",
          "-1",
          "-t",
          windowTarget
        ]),
        { maxBufferBytes: 8 * 1024 * 1024, timeoutMs: 2_000 }
      );
      return ownedSessionGuardRejected(stdout) ? "" : stdout;
    } catch {
      // History is a convenience. A live attachment should still be attempted.
      return "";
    }
  }
}
