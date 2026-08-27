import { describe, expect, it } from "vitest";

import type {
  CommandRunner,
  RunOptions,
  RunResult
} from "../../packages/runtime/src/infrastructure/process/command-runner.js";
import { TmuxTerminalHistoryReader } from "../../packages/runtime/src/infrastructure/terminal/terminal-history.js";
import { buildCaptainSessionName } from "../../packages/runtime/src/domain/agent-session-name.js";
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
          stdout: args[0] === "display-message" ? "12\n" : "old output\n",
          stderr: ""
        });
      }
    };
    const name = buildCaptainSessionName(TEST_CONVERSATION_ID, "codex");
    const reader = new TmuxTerminalHistoryReader(runner);

    await expect(reader.read(name)).resolves.toBe("old output\n");
    expect(calls).toEqual([
      ["display-message", "-p", "-t", `${name}:`, "#{history_size}"],
      ["capture-pane", "-p", "-e", "-J", "-S", "-20000", "-E", "-1", "-t", `${name}:`]
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

    await expect(reader.read("managed-session")).resolves.toBe("");
    expect(calls).toHaveLength(1);
  });

  it("does not prevent a live attachment when history is unavailable", async () => {
    const runner: CommandRunner = {
      run: () => Promise.reject(new Error("no history"))
    };
    const reader = new TmuxTerminalHistoryReader(runner);
    await expect(reader.read("managed-session")).resolves.toBe("");
  });
});
