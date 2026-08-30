import { describe, expect, it } from "vitest";

import type {
  CommandRunner,
  RunOptions,
  RunResult
} from "../../packages/runtime/src/infrastructure/process/command-runner.js";
import { TmuxTerminalHistoryReader } from "../../packages/runtime/src/infrastructure/terminal/terminal-history.js";
import { buildCaptainSessionName } from "../../packages/runtime/src/domain/agent-session-name.js";
import type { SessionAttachmentTarget } from "../../packages/runtime/src/domain/session-runtime.js";
import { guardedTmuxArguments } from "../../packages/runtime/src/infrastructure/tmux/owned-session-guard.js";
import { rejectedOwnedSessionGuardOutput } from "../../packages/runtime/src/infrastructure/tmux/owned-session-guard.js";
import { TEST_CONVERSATION_ID } from "../helpers/fakes.js";

describe("TmuxTerminalHistoryReader", () => {
  it("captures the managed pane's complete retained history", async () => {
    const calls: string[][] = [];
    const options: (RunOptions | undefined)[] = [];
    const runner: CommandRunner = {
      run(_executable, args, runOptions): Promise<RunResult> {
        calls.push([...args]);
        options.push(runOptions);
        return Promise.resolve({
          stdout: args.join(" ").includes("history_size") ? "12\n" : "old output\n",
          stderr: ""
        });
      }
    };
    const name = buildCaptainSessionName(TEST_CONVERSATION_ID, "codex");
    const target = attachmentTarget(name);
    const reader = new TmuxTerminalHistoryReader(runner);

    await expect(reader.read(target)).resolves.toBe("old output\n");
    expect(calls).toEqual([
      guardedTmuxArguments(target, ["display-message", "-p", "-t", "$42:", "#{history_size}"]),
      guardedTmuxArguments(target, [
        "capture-pane",
        "-p",
        "-e",
        "-J",
        "-S",
        "-20000",
        "-E",
        "-1",
        "-t",
        "$42:"
      ])
    ]);
    expect(options).toEqual([
      { maxBufferBytes: 1_024, timeoutMs: 2_000 },
      { maxBufferBytes: 8 * 1024 * 1024, timeoutMs: 2_000 }
    ]);
  });

  it("does not capture the visible pane when tmux reports empty history", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = {
      run(_executable, args): Promise<RunResult> {
        calls.push([...args]);
        return Promise.resolve({ stdout: "0\n", stderr: "" });
      }
    };
    const reader = new TmuxTerminalHistoryReader(runner);

    await expect(
      reader.read(attachmentTarget(buildCaptainSessionName(TEST_CONVERSATION_ID, "codex")))
    ).resolves.toBe("");
    expect(calls).toHaveLength(1);
  });

  it("does not prevent a live attachment when history is unavailable", async () => {
    const runner: CommandRunner = {
      run: () => Promise.reject(new Error("no history"))
    };
    const reader = new TmuxTerminalHistoryReader(runner);
    await expect(
      reader.read(attachmentTarget(buildCaptainSessionName(TEST_CONVERSATION_ID, "codex")))
    ).resolves.toBe("");
  });

  it("does not read a reused session ID after the tmux server restarts", async () => {
    let capturedForeignHistory = false;
    const runner: CommandRunner = {
      run(): Promise<RunResult> {
        // The old target's generation guard takes the false branch. The embedded display/capture
        // command is never executed against the foreign session that reused $42.
        capturedForeignHistory = false;
        return Promise.resolve({
          stdout: `${rejectedOwnedSessionGuardOutput}\n`,
          stderr: ""
        });
      }
    };

    await expect(
      new TmuxTerminalHistoryReader(runner).read(
        attachmentTarget(buildCaptainSessionName(TEST_CONVERSATION_ID, "codex"))
      )
    ).resolves.toBe("");
    expect(capturedForeignHistory).toBe(false);
  });
});

function attachmentTarget(sessionName: string): SessionAttachmentTarget {
  return {
    sessionName,
    runtimeId: "$42",
    serverPid: "100",
    serverStartedAt: "200",
    ownership: { mode: "legacy-name" }
  };
}
