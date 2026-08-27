import { sessionHistoryLimit } from "@agentlab/contracts";

import type { TerminalHistoryReader } from "../../domain/terminal.js";
import type { CommandRunner } from "../process/command-runner.js";

/** Seeds only durable scrollback; live attach remains authoritative for the viewport and VT state. */
export class TmuxTerminalHistoryReader implements TerminalHistoryReader {
  public constructor(private readonly runner: CommandRunner) {}

  public async read(sessionName: string): Promise<string> {
    try {
      const target = `${sessionName}:`;
      const { stdout: historySizeOutput } = await this.runner.run(
        "tmux",
        ["display-message", "-p", "-t", target, "#{history_size}"],
        { maxBufferBytes: 1_024, timeoutMs: 2_000 }
      );
      const historySize = Number(historySizeOutput.trim());
      if (!Number.isSafeInteger(historySize) || historySize <= 0) return "";
      const { stdout } = await this.runner.run(
        "tmux",
        [
          "capture-pane",
          "-p",
          "-e",
          "-J",
          "-S",
          `-${String(sessionHistoryLimit)}`,
          "-E",
          "-1",
          "-t",
          target
        ],
        { maxBufferBytes: 8 * 1024 * 1024, timeoutMs: 2_000 }
      );
      return stdout;
    } catch {
      // History is a convenience. A live attachment should still be attempted.
      return "";
    }
  }
}
