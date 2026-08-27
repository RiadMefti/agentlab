import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import type {
  CommandRunner,
  RunOptions,
  RunResult
} from "../../packages/runtime/src/infrastructure/process/command-runner.js";
import { NodeCommandRunner } from "../../packages/runtime/src/infrastructure/process/command-runner.js";
import { TmuxTerminalHistoryReader } from "../../packages/runtime/src/infrastructure/terminal/terminal-history.js";
import { renderShellCommand } from "../../packages/runtime/src/infrastructure/tmux/shell-command.js";

describe.runIf(process.env.AGENTLAB_RUN_TMUX_INTEGRATION === "1")(
  "TmuxTerminalHistoryReader integration",
  () => {
    const runner = new NodeCommandRunner();
    const socketPath = `/tmp/agentlab-history-${randomUUID()}.sock`;
    const socketRunner: CommandRunner = {
      run(executable: string, args: readonly string[], options?: RunOptions): Promise<RunResult> {
        return runner.run(executable, ["-S", socketPath, ...args], options);
      }
    };

    afterEach(async () => {
      try {
        await runner.run("tmux", ["-S", socketPath, "kill-server"]);
      } catch {
        // A failed setup may not have created the private server.
      } finally {
        rmSync(socketPath, { force: true });
      }
    });

    it("captures joined history rows without replaying the current viewport", async () => {
      const name = `agentlab-history-${randomUUID()}`;
      const logicalLine = "wrapped-logical-line";
      const script = [
        `process.stdout.write("\\u001b[38;2;12;34;56mwide-界-${logicalLine}\\u001b[0m\\n");`,
        `process.stdout.write(Array.from({length: 8}, (_, i) => "history-" + i + "\\n").join(""));`,
        `process.stdout.write("viewport-a\\nviewport-b\\nviewport-c");`,
        "setInterval(() => undefined, 1000);"
      ].join("");
      await runner.run("tmux", [
        "-S",
        socketPath,
        "new-session",
        "-d",
        "-x",
        "12",
        "-y",
        "3",
        "-s",
        name,
        renderShellCommand({ executable: process.execPath, args: ["-e", script] })
      ]);
      const reader = new TmuxTerminalHistoryReader(socketRunner);

      await expect.poll(() => reader.read(name)).toContain(logicalLine);
      const history = await reader.read(name);
      expect(history).toContain("wide-界-");
      expect(history).toContain("\x1b[38;2;12;34;56m");
      expect(history).not.toContain("viewport-c");
    });

    it("returns no seed when the pane has no history rows", async () => {
      const name = `agentlab-empty-history-${randomUUID()}`;
      await runner.run("tmux", [
        "-S",
        socketPath,
        "new-session",
        "-d",
        "-x",
        "20",
        "-y",
        "4",
        "-s",
        name,
        renderShellCommand({
          executable: process.execPath,
          args: ["-e", "setInterval(() => undefined, 1000)"]
        })
      ]);

      const reader = new TmuxTerminalHistoryReader(socketRunner);
      await expect(reader.read(name)).resolves.toBe("");
    });
  }
);
