import { describe, expect, it } from "vitest";

import type {
  CommandRunner,
  RunResult
} from "../../apps/server/src/infrastructure/process/command-runner.js";
import {
  buildCaptainSessionName,
  buildWorkerSessionName
} from "../../apps/server/src/domain/agent-session-name.js";
import { TmuxSessionRuntime } from "../../apps/server/src/infrastructure/tmux/tmux-session-runtime.js";
import { TEST_CONVERSATION_ID } from "../helpers/fakes.js";

interface RecordedCall {
  readonly executable: string;
  readonly args: readonly string[];
}

class RecordingRunner implements CommandRunner {
  public readonly calls: RecordedCall[] = [];

  public run(executable: string, args: readonly string[]): Promise<RunResult> {
    this.calls.push({ executable, args });
    const subcommand = args[0];
    if (subcommand === "has-session") {
      const error = Object.assign(new Error("can't find session"), {
        stderr: "can't find session"
      });
      return Promise.reject(error);
    }
    if (subcommand === "list-sessions") {
      const name = buildCaptainSessionName(TEST_CONVERSATION_ID, "codex");
      return Promise.resolve({
        stdout: `${name}\u001f1787313600\u001f1\u001f0\nignored-session\u001f0\u001f0\u001f0\n`,
        stderr: ""
      });
    }
    return Promise.resolve({ stdout: "", stderr: "" });
  }
}

describe("TmuxSessionRuntime", () => {
  it("creates only a strictly named session with safely rendered arguments", async () => {
    const runner = new RecordingRunner();
    const runtime = new TmuxSessionRuntime(runner);
    const name = buildCaptainSessionName(TEST_CONVERSATION_ID, "codex");

    await runtime.createCaptain({
      name,
      cwd: "/work/project",
      command: {
        executable: "/opt/provider cli",
        args: ["--prompt", "hello; exit 1"]
      }
    });

    expect(runner.calls[1]).toEqual({
      executable: "tmux",
      args: ["new-session", "-d", "-s", name, "-c", "/work/project", "-x", "120", "-y", "40"]
    });
    expect(runner.calls.slice(2)).toEqual([
      {
        executable: "tmux",
        args: ["set-window-option", "-t", `${name}:`, "remain-on-exit", "on"]
      },
      {
        executable: "tmux",
        args: ["set-window-option", "-t", `${name}:`, "history-limit", "20000"]
      },
      {
        executable: "tmux",
        args: ["set-option", "-t", name, "status", "off"]
      },
      {
        executable: "tmux",
        args: [
          "respawn-pane",
          "-k",
          "-t",
          `${name}:`,
          "-c",
          "/work/project",
          "'/opt/provider cli' --prompt 'hello; exit 1'"
        ]
      }
    ]);
  });

  it("parses managed sessions and ignores unrelated tmux state", async () => {
    const runtime = new TmuxSessionRuntime(new RecordingRunner());
    const sessions = await runtime.list(TEST_CONVERSATION_ID);

    expect(sessions).toEqual([
      {
        name: buildCaptainSessionName(TEST_CONVERSATION_ID, "codex"),
        conversationId: TEST_CONVERSATION_ID,
        role: "captain",
        provider: "codex",
        label: "Captain",
        status: "running",
        attached: true,
        startedAt: "2026-08-21T12:00:00.000Z"
      }
    ]);
  });

  it("refuses to target sessions the app does not own", async () => {
    const runtime = new TmuxSessionRuntime(new RecordingRunner());
    await expect(runtime.kill("personal-session")).rejects.toThrow(/unmanaged tmux session/u);
  });

  it("refuses to launch workers on the captain's behalf", async () => {
    const runner = new RecordingRunner();
    const runtime = new TmuxSessionRuntime(runner);

    await expect(
      runtime.createCaptain({
        name: buildWorkerSessionName(TEST_CONVERSATION_ID, "claude", "worker"),
        cwd: "/work/project",
        command: { executable: "claude", args: [] }
      })
    ).rejects.toThrow(/only a managed captain/u);
    expect(runner.calls).toHaveLength(0);
  });
});
