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
import type { SessionAttachmentTarget } from "../../packages/runtime/src/domain/session-runtime.js";
import { buildCaptainSessionName } from "../../packages/runtime/src/domain/agent-session-name.js";

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
      const name = buildCaptainSessionName(randomUUID(), "codex");
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
      const target = await attachmentTarget(socketRunner, name);

      await expect.poll(() => reader.read(target)).toContain(logicalLine);
      const history = await reader.read(target);
      expect(history).toContain("wide-界-");
      expect(history).toContain("\x1b[38;2;12;34;56m");
      expect(history).not.toContain("viewport-c");
    });

    it("returns no seed when the pane has no history rows", async () => {
      const name = buildCaptainSessionName(randomUUID(), "codex");
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
      await expect(reader.read(await attachmentTarget(socketRunner, name))).resolves.toBe("");
    });

    it("does not capture a foreign pane after server restart and session-ID reuse", async () => {
      const name = buildCaptainSessionName(randomUUID(), "codex");
      await runner.run("tmux", [
        "-S",
        socketPath,
        "new-session",
        "-d",
        "-s",
        name,
        renderShellCommand({
          executable: process.execPath,
          args: ["-e", 'console.log("old history"); setInterval(() => undefined, 1000)']
        })
      ]);
      const staleTarget = await attachmentTarget(socketRunner, name);

      await runner.run("tmux", ["-S", socketPath, "kill-server"]);
      await runner.run("tmux", [
        "-S",
        socketPath,
        "new-session",
        "-d",
        "-s",
        name,
        renderShellCommand({
          executable: process.execPath,
          args: ["-e", 'console.log("foreign history"); setInterval(() => undefined, 1000)']
        })
      ]);

      await expect
        .poll(async () => {
          const { stdout } = await runner.run("tmux", [
            "-S",
            socketPath,
            "capture-pane",
            "-p",
            "-t",
            `=${name}:`
          ]);
          return stdout;
        })
        .toContain("foreign history");
      await expect(new TmuxTerminalHistoryReader(socketRunner).read(staleTarget)).resolves.toBe("");
    });

    it("does not capture a session renamed underneath an immutable target", async () => {
      const originalName = buildCaptainSessionName(randomUUID(), "codex");
      const renamed = buildCaptainSessionName(randomUUID(), "claude");
      await runner.run("tmux", [
        "-S",
        socketPath,
        "new-session",
        "-d",
        "-x",
        "20",
        "-y",
        "2",
        "-s",
        originalName,
        renderShellCommand({
          executable: process.execPath,
          args: ["-e", 'console.log("renamed history"); setInterval(() => undefined, 1000)']
        })
      ]);
      const staleTarget = await attachmentTarget(socketRunner, originalName);
      await runner.run("tmux", [
        "-S",
        socketPath,
        "rename-session",
        "-t",
        `=${originalName}`,
        renamed
      ]);

      await expect(new TmuxTerminalHistoryReader(socketRunner).read(staleTarget)).resolves.toBe("");
      await expect
        .poll(async () => {
          const { stdout } = await runner.run("tmux", [
            "-S",
            socketPath,
            "capture-pane",
            "-p",
            "-t",
            `=${renamed}:`
          ]);
          return stdout;
        })
        .toContain("renamed history");
    });
  }
);

async function attachmentTarget(
  runner: CommandRunner,
  sessionName: string
): Promise<SessionAttachmentTarget> {
  const { stdout } = await runner.run("tmux", [
    "display-message",
    "-p",
    "-t",
    `=${sessionName}:`,
    "#{session_id}|#{pid}|#{start_time}"
  ]);
  const [runtimeId, serverPid, serverStartedAt] = stdout.trim().split("|");
  if (runtimeId === undefined || serverPid === undefined || serverStartedAt === undefined) {
    throw new Error("tmux did not return a complete attachment target");
  }
  return {
    sessionName,
    runtimeId,
    serverPid,
    serverStartedAt,
    ownership: { mode: "legacy-name" }
  };
}
