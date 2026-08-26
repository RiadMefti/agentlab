import { sessionHistoryLimit } from "@orchestrator/contracts";

import type { TerminalHistoryReader } from "../../domain/terminal.js";
import type { CommandRunner } from "../process/command-runner.js";

/** Seeds a new attachment with the durable tmux pane history. */
export class TmuxTerminalHistoryReader implements TerminalHistoryReader {
  public constructor(private readonly runner: CommandRunner) {}

  public async read(sessionName: string): Promise<string> {
    try {
      const { stdout } = await this.runner.run(
        "tmux",
        [
          "capture-pane",
          "-p",
          "-e",
          "-S",
          `-${String(sessionHistoryLimit)}`,
          "-t",
          `${sessionName}:`
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
