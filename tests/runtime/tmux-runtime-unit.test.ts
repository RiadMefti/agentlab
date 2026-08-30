import { describe, expect, it } from "vitest";

import {
  buildCaptainSessionName,
  buildWorkerSessionName
} from "../../packages/runtime/src/domain/agent-session-name.js";
import type {
  CommandRunner,
  RunOptions,
  RunResult
} from "../../packages/runtime/src/infrastructure/process/command-runner.js";
import { TmuxSessionRuntime } from "../../packages/runtime/src/infrastructure/tmux/tmux-session-runtime.js";
import {
  guardedTmuxArguments,
  rejectedOwnedSessionGuardOutput
} from "../../packages/runtime/src/infrastructure/tmux/owned-session-guard.js";
import { TEST_CONVERSATION_ID } from "../helpers/fakes.js";

const TEST_NONCE = "22222222-2222-4222-8222-222222222222";
const NONCE_OWNERSHIP = { mode: "nonce", nonce: TEST_NONCE } as const;
const LEGACY_OWNERSHIP = { mode: "legacy-name" } as const;

interface RecordedCall {
  readonly executable: string;
  readonly args: readonly string[];
}

class RecordingRunner implements CommandRunner {
  public readonly calls: RecordedCall[] = [];
  private created = false;
  private currentNonce: string | null;

  public constructor(
    private readonly sessionExists = false,
    private readonly nonce: string | null = null,
    private readonly listedSessions?: string,
    private readonly duplicateNewSession = false
  ) {
    this.currentNonce = nonce;
  }

  public run(executable: string, args: readonly string[]): Promise<RunResult> {
    this.calls.push({ executable, args });
    const subcommand = args[0];
    if (subcommand === "new-session" && this.duplicateNewSession) {
      return Promise.reject(tmuxError("duplicate session"));
    }
    if (subcommand === "new-session") {
      this.created = true;
      const environmentIndex = args.indexOf("-e");
      const ownership = environmentIndex < 0 ? undefined : args[environmentIndex + 1];
      if (ownership?.startsWith("AGENTLAB_SESSION_OWNERSHIP=") === true) {
        this.currentNonce = ownership.slice("AGENTLAB_SESSION_OWNERSHIP=".length);
      }
      return Promise.resolve({ stdout: "$42|100|200\n", stderr: "" });
    }
    if (subcommand === "has-session") {
      return this.sessionExists || this.created
        ? Promise.resolve({ stdout: "", stderr: "" })
        : Promise.reject(tmuxError("can't find session"));
    }
    if (subcommand === "display-message") {
      return this.sessionExists || this.created
        ? Promise.resolve({ stdout: "$42|100|200\n", stderr: "" })
        : Promise.reject(tmuxError("can't find session"));
    }
    if (subcommand === "if-shell") {
      const condition = args[4] ?? "";
      const action = args[5] ?? "";
      if (
        condition.includes("AGENTLAB_SESSION_OWNERSHIP") &&
        !condition.includes(this.currentNonce ?? "__missing__")
      ) {
        return Promise.resolve({ stdout: `${rejectedOwnedSessionGuardOutput}\n`, stderr: "" });
      }
      if (action.startsWith("show-environment")) {
        return this.currentNonce === null
          ? Promise.reject(tmuxError("unknown variable"))
          : Promise.resolve({
              stdout: `AGENTLAB_SESSION_OWNERSHIP=${this.currentNonce}\n`,
              stderr: ""
            });
      }
      return Promise.resolve({ stdout: "", stderr: "" });
    }
    if (subcommand === "show-environment") {
      return this.currentNonce === null
        ? Promise.reject(tmuxError("unknown variable"))
        : Promise.resolve({
            stdout: `AGENTLAB_SESSION_OWNERSHIP=${this.currentNonce}\n`,
            stderr: ""
          });
    }
    if (subcommand === "list-sessions") {
      const name = buildCaptainSessionName(TEST_CONVERSATION_ID, "codex");
      return Promise.resolve({
        stdout:
          this.listedSessions ??
          `${name}|1787313600|1|0|$42|100|200|${this.currentNonce ?? ""}\nignored-session|0|0|0||||\n`,
        stderr: ""
      });
    }
    return Promise.resolve({ stdout: "", stderr: "" });
  }
}

describe("TmuxSessionRuntime", () => {
  it("bounds every tmux call and requests descendant cleanup", async () => {
    const options: RunOptions[] = [];
    const runner: CommandRunner = {
      run(_executable, _args, callOptions = {}): Promise<RunResult> {
        options.push(callOptions);
        return Promise.reject(tmuxError("can't find session"));
      }
    };
    const runtime = new TmuxSessionRuntime(runner);
    const name = buildCaptainSessionName(TEST_CONVERSATION_ID, "codex");

    await expect(runtime.exists(name)).resolves.toBe(false);
    await expect(runtime.list(TEST_CONVERSATION_ID)).resolves.toEqual([]);
    await expect(runtime.killOwned(name, LEGACY_OWNERSHIP)).resolves.toBe("absent");
    expect(options).toEqual([
      { timeoutMs: 3_000, cleanupProcessTree: true },
      { timeoutMs: 3_000, cleanupProcessTree: true },
      { timeoutMs: 3_000, cleanupProcessTree: true }
    ]);
  });

  it("returns from a never-resolving runner at the cleanup deadline", async () => {
    const runner: CommandRunner = { run: () => new Promise<RunResult>(() => undefined) };
    const runtime = new TmuxSessionRuntime(runner, undefined, {
      commandTimeoutMs: 10,
      cleanupAllowanceMs: 10
    });

    await expect(runtime.list(TEST_CONVERSATION_ID)).rejects.toThrow(
      "tmux list-sessions did not finish within its cleanup deadline"
    );
  });

  it("never compensates a duplicate new-session result it did not create", async () => {
    const runner = new RecordingRunner(false, null, undefined, true);
    const runtime = new TmuxSessionRuntime(runner);
    const name = buildCaptainSessionName(TEST_CONVERSATION_ID, "codex");

    await expect(
      runtime.createCaptain({
        name,
        cwd: "/work/project",
        command: { executable: "codex", args: [] },
        ownership: NONCE_OWNERSHIP
      })
    ).rejects.toThrow("duplicate session");
    expect(runner.calls).toEqual([
      {
        executable: "tmux",
        args: [
          "new-session",
          "-d",
          "-P",
          "-F",
          "#{session_id}|#{pid}|#{start_time}",
          "-s",
          name,
          "-e",
          `AGENTLAB_SESSION_OWNERSHIP=${TEST_NONCE}`,
          "-c",
          "/work/project",
          "-x",
          "120",
          "-y",
          "40"
        ]
      }
    ]);
  });

  it("leaves an ambiguous journal when new-session returns no atomic identity", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = {
      run(_executable, args): Promise<RunResult> {
        calls.push([...args]);
        return Promise.resolve({ stdout: "", stderr: "" });
      }
    };
    const runtime = new TmuxSessionRuntime(runner);

    await expect(
      runtime.createCaptain({
        name: buildCaptainSessionName(TEST_CONVERSATION_ID, "codex"),
        cwd: "/work/project",
        command: { executable: "codex", args: [] },
        ownership: NONCE_OWNERSHIP
      })
    ).rejects.toThrow("did not return a valid identity");
    expect(calls).toHaveLength(1);
  });

  it("cannot redirect post-creation configuration into a replacement session", async () => {
    const executedActions: string[] = [];
    const runner: CommandRunner = {
      run(_executable, args): Promise<RunResult> {
        if (args[0] === "new-session") {
          return Promise.resolve({ stdout: "$0|100|200\n", stderr: "" });
        }
        if (args[0] === "if-shell") {
          // The original target disappeared before the first guarded action. tmux evaluates the
          // false branch without executing the embedded show/configuration/kill command.
          return Promise.resolve({
            stdout: `${rejectedOwnedSessionGuardOutput}\n`,
            stderr: ""
          });
        }
        executedActions.push(args[0] ?? "");
        return Promise.resolve({ stdout: "", stderr: "" });
      }
    };
    const runtime = new TmuxSessionRuntime(runner);

    await expect(
      runtime.createCaptain({
        name: buildCaptainSessionName(TEST_CONVERSATION_ID, "codex"),
        cwd: "/work/project",
        command: { executable: "codex", args: [] },
        ownership: NONCE_OWNERSHIP
      })
    ).rejects.toThrow("generation changed while ownership was inspected");
    expect(executedActions).toEqual([]);
  });

  it("keeps configuration failure primary when owned compensation also fails", async () => {
    const primary = new Error("remain-on-exit failed");
    const compensation = new Error("kill-session failed");
    const calls: string[] = [];
    const runner: CommandRunner = {
      run(_executable, args): Promise<RunResult> {
        const command = args[0] ?? "";
        calls.push(command);
        if (command === "new-session") {
          return Promise.resolve({ stdout: "$42|100|200\n", stderr: "" });
        }
        if (command === "set-window-option") return Promise.reject(primary);
        if (command === "if-shell" && (args[5] ?? "").startsWith("show-environment")) {
          return Promise.resolve({
            stdout: `AGENTLAB_SESSION_OWNERSHIP=${TEST_NONCE}\n`,
            stderr: ""
          });
        }
        if (command === "if-shell" && (args[5] ?? "").startsWith("set-window-option")) {
          return Promise.reject(primary);
        }
        return Promise.reject(compensation);
      }
    };
    const runtime = new TmuxSessionRuntime(runner);

    const failure = await runtime
      .createCaptain({
        name: buildCaptainSessionName(TEST_CONVERSATION_ID, "codex"),
        cwd: "/work/project",
        command: { executable: "codex", args: [] },
        ownership: NONCE_OWNERSHIP
      })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      name: "SessionCreationError",
      message: primary.message,
      cleanup: "unconfirmed",
      cause: primary
    });
    expect(primary.cause).toBeInstanceOf(AggregateError);
    expect((primary.cause as AggregateError).errors).toContain(compensation);
    expect(calls).toEqual(["new-session", "if-shell", "if-shell", "if-shell"]);
  });

  it("reports positive absence when failed configuration is successfully compensated", async () => {
    const primary = new Error("remain-on-exit failed");
    const runner: CommandRunner = {
      run(_executable, args): Promise<RunResult> {
        if (args[0] === "new-session") {
          return Promise.resolve({ stdout: "$42|100|200\n", stderr: "" });
        }
        const action = args[5] ?? "";
        if (action.startsWith("show-environment")) {
          return Promise.resolve({
            stdout: `AGENTLAB_SESSION_OWNERSHIP=${TEST_NONCE}\n`,
            stderr: ""
          });
        }
        if (action.startsWith("set-window-option")) return Promise.reject(primary);
        if (action.startsWith("kill-session")) {
          return Promise.resolve({ stdout: "", stderr: "" });
        }
        return Promise.resolve({ stdout: "", stderr: "" });
      }
    };

    const failure = await new TmuxSessionRuntime(runner)
      .createCaptain({
        name: buildCaptainSessionName(TEST_CONVERSATION_ID, "codex"),
        cwd: "/work/project",
        command: { executable: "codex", args: [] },
        ownership: NONCE_OWNERSHIP
      })
      .catch((error: unknown) => error);

    expect(failure).toMatchObject({
      name: "SessionCreationError",
      message: primary.message,
      cleanup: "confirmed-absent",
      cause: primary
    });
  });

  it("atomically stamps ownership and uses exact targets with safely rendered arguments", async () => {
    const runner = new RecordingRunner();
    const runtime = new TmuxSessionRuntime(runner);
    const name = buildCaptainSessionName(TEST_CONVERSATION_ID, "codex");

    await runtime.createCaptain({
      name,
      cwd: "/work/project",
      command: {
        executable: "/opt/provider cli",
        args: ["--prompt", "hello; exit 1"]
      },
      ownership: NONCE_OWNERSHIP
    });

    expect(runner.calls[0]?.args).toEqual([
      "new-session",
      "-d",
      "-P",
      "-F",
      "#{session_id}|#{pid}|#{start_time}",
      "-s",
      name,
      "-e",
      `AGENTLAB_SESSION_OWNERSHIP=${TEST_NONCE}`,
      "-c",
      "/work/project",
      "-x",
      "120",
      "-y",
      "40"
    ]);
    const target = attachmentTarget(name);
    expect(runner.calls.slice(1).map(({ args }) => args)).toEqual([
      guardedTmuxArguments({ ...target, ownership: LEGACY_OWNERSHIP }, [
        "show-environment",
        "-t",
        "$42",
        "AGENTLAB_SESSION_OWNERSHIP"
      ]),
      guardedTmuxArguments(target, ["set-window-option", "-t", "$42:", "remain-on-exit", "on"]),
      guardedTmuxArguments(target, ["set-window-option", "-t", "$42:", "history-limit", "20000"]),
      guardedTmuxArguments(target, ["set-option", "-t", "$42", "status", "off"]),
      guardedTmuxArguments(target, [
        "respawn-pane",
        "-k",
        "-t",
        "$42:",
        "-c",
        "/work/project",
        "'/opt/provider cli' --prompt 'hello; exit 1'"
      ])
    ]);
  });

  it("inspects ownership and refuses to kill a nonce conflict", async () => {
    const runner = new RecordingRunner(true, "different-nonce");
    const runtime = new TmuxSessionRuntime(runner);
    const name = buildCaptainSessionName(TEST_CONVERSATION_ID, "codex");

    await expect(runtime.inspectOwnership(name)).resolves.toEqual({
      status: "present",
      nonce: "different-nonce"
    });
    await expect(runtime.killOwned(name, NONCE_OWNERSHIP)).resolves.toBe("ownership-mismatch");
    expect(runner.calls.some(({ args }) => args[0] === "kill-session")).toBe(false);
  });

  it("kills the immutable session ID that supplied the matching nonce", async () => {
    const runner = new RecordingRunner(true, TEST_NONCE);
    const runtime = new TmuxSessionRuntime(runner);
    const name = buildCaptainSessionName(TEST_CONVERSATION_ID, "codex");

    await expect(runtime.killOwned(name, NONCE_OWNERSHIP)).resolves.toBe("killed");
    expect(runner.calls.map(({ args }) => args)).toEqual([
      ["display-message", "-p", "-t", `=${name}:`, "#{session_id}|#{pid}|#{start_time}"],
      guardedTmuxArguments(attachmentTarget(name), ["kill-session", "-t", "$42"])
    ]);
  });

  it("refuses a reused session ID after the tmux server generation changes", async () => {
    let foreignKilled = false;
    const name = buildCaptainSessionName(TEST_CONVERSATION_ID, "codex");
    const runner: CommandRunner = {
      run(_executable, args): Promise<RunResult> {
        if (args[0] === "display-message") {
          return Promise.resolve({ stdout: "$0|100|200\n", stderr: "" });
        }
        if (args[0] === "if-shell") {
          // The server restarted as generation 101/201 before the guarded kill was evaluated.
          foreignKilled = false;
          return Promise.resolve({
            stdout: `${rejectedOwnedSessionGuardOutput}\n`,
            stderr: ""
          });
        }
        throw new Error("unexpected tmux command");
      }
    };

    await expect(new TmuxSessionRuntime(runner).killOwned(name, NONCE_OWNERSHIP)).resolves.toBe(
      "ownership-mismatch"
    );
    expect(foreignKilled).toBe(false);
  });

  it("resolves an immutable attachment target only after ownership proof", async () => {
    const runner = new RecordingRunner(true, TEST_NONCE);
    const runtime = new TmuxSessionRuntime(runner);
    const name = buildCaptainSessionName(TEST_CONVERSATION_ID, "codex");

    await expect(runtime.resolveOwnedTarget(name, NONCE_OWNERSHIP)).resolves.toEqual({
      status: "owned",
      target: attachmentTarget(name)
    });
    await expect(
      new TmuxSessionRuntime(new RecordingRunner(true, "foreign")).resolveOwnedTarget(
        name,
        NONCE_OWNERSHIP
      )
    ).resolves.toEqual({ status: "ownership-mismatch" });
  });

  it("reports an existing pre-nonce session with a missing ownership value", async () => {
    const runtime = new TmuxSessionRuntime(new RecordingRunner(true));
    const name = buildCaptainSessionName(TEST_CONVERSATION_ID, "codex");

    await expect(runtime.inspectOwnership(name)).resolves.toEqual({
      status: "present",
      nonce: null
    });
  });

  it("reports a rejected generation guard as ambiguity rather than session absence", async () => {
    const runner: CommandRunner = {
      run(_executable, args): Promise<RunResult> {
        if (args[0] === "display-message") {
          return Promise.resolve({ stdout: "$42|100|200\n", stderr: "" });
        }
        return Promise.resolve({
          stdout: `${rejectedOwnedSessionGuardOutput}\n`,
          stderr: ""
        });
      }
    };

    await expect(
      new TmuxSessionRuntime(runner).inspectOwnership(
        buildCaptainSessionName(TEST_CONVERSATION_ID, "codex")
      )
    ).rejects.toThrow("generation changed");
  });

  it("parses managed sessions and ignores unrelated tmux state", async () => {
    const runtime = new TmuxSessionRuntime(new RecordingRunner());

    await expect(runtime.list(TEST_CONVERSATION_ID)).resolves.toEqual([
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

  it("keeps malformed optional status fields conservative", async () => {
    const name = buildCaptainSessionName(TEST_CONVERSATION_ID, "codex");
    const missing = new TmuxSessionRuntime(
      new RecordingRunner(false, null, `${name}||0|0|$42|100|200|\n`)
    );
    const outOfRange = new TmuxSessionRuntime(
      new RecordingRunner(false, null, `${name}|999999999999999999999|0|0|$42|100|200|\n`)
    );

    await expect(missing.list(TEST_CONVERSATION_ID)).resolves.toMatchObject([
      { name, startedAt: null }
    ]);
    await expect(outOfRange.list(TEST_CONVERSATION_ID)).resolves.toMatchObject([
      { name, startedAt: null }
    ]);
  });

  it("fails closed when a conversation inventory exceeds its aggregate bound", async () => {
    const lines = Array.from({ length: 129 }, (_value, index) => {
      const name = buildWorkerSessionName(TEST_CONVERSATION_ID, "codex", `worker-${String(index)}`);
      return `${name}|1787313600|0|0|$${String(index + 1)}|100|200|${TEST_NONCE}`;
    }).join("\n");
    const runtime = new TmuxSessionRuntime(new RecordingRunner(false, null, `${lines}\n`));

    await expect(runtime.listInventory(TEST_CONVERSATION_ID)).rejects.toThrow(
      "exceeds the safe limit of 128"
    );
  });

  it("rejects a mixed-generation inventory instead of treating it as absence", async () => {
    const captain = buildCaptainSessionName(TEST_CONVERSATION_ID, "codex");
    const worker = buildWorkerSessionName(TEST_CONVERSATION_ID, "codex", "mixed-generation");
    const runtime = new TmuxSessionRuntime(
      new RecordingRunner(
        false,
        null,
        [
          `${captain}|1787313600|0|0|$1|100|200|${TEST_NONCE}`,
          `${worker}|1787313600|0|0|$2|101|201|${TEST_NONCE}`,
          ""
        ].join("\n")
      )
    );

    await expect(runtime.listInventory(TEST_CONVERSATION_ID)).rejects.toThrow("mixed-generation");
  });

  it("binds every guarded action to the original session name as well as generation", () => {
    const target = attachmentTarget(buildCaptainSessionName(TEST_CONVERSATION_ID, "codex"));
    const actions = [
      ["capture-pane", "-t", "$42:"],
      ["attach-session", "-t", "$42"],
      ["set-option", "-t", "$42", "status", "off"],
      ["kill-session", "-t", "$42"]
    ];

    for (const action of actions) {
      const condition = guardedTmuxArguments(target, action)[4];
      expect(condition).toContain("#{session_name}");
      expect(condition).toContain(target.sessionName);
      expect(condition).toContain(target.serverPid);
      expect(condition).toContain(target.serverStartedAt);
    }
  });

  it("refuses unmanaged targets and role-confused creation", async () => {
    const runtime = new TmuxSessionRuntime(new RecordingRunner());

    await expect(runtime.killOwned("personal-session", LEGACY_OWNERSHIP)).rejects.toThrow(
      /unmanaged tmux session/u
    );
    await expect(
      runtime.createCaptain({
        name: buildWorkerSessionName(TEST_CONVERSATION_ID, "claude", "worker"),
        cwd: "/work/project",
        command: { executable: "claude", args: [] },
        ownership: LEGACY_OWNERSHIP
      })
    ).rejects.toThrow(/only a managed captain/u);
    await expect(
      runtime.createWorker({
        name: buildCaptainSessionName(TEST_CONVERSATION_ID, "codex"),
        cwd: "/work/project",
        command: { executable: "codex", args: [] },
        ownership: LEGACY_OWNERSHIP
      })
    ).rejects.toThrow(/only a managed worker/u);
  });

  it("creates workers through the same ownership-stamped lifecycle", async () => {
    const runner = new RecordingRunner();
    const runtime = new TmuxSessionRuntime(runner);
    const name = buildWorkerSessionName(TEST_CONVERSATION_ID, "claude", "review");

    await runtime.createWorker({
      name,
      cwd: "/work/project",
      command: { executable: "/opt/claude cli", args: ["--", "review; exit 1"] },
      ownership: NONCE_OWNERSHIP
    });

    expect(runner.calls[0]?.args).toContain(`AGENTLAB_SESSION_OWNERSHIP=${TEST_NONCE}`);
    expect(runner.calls.at(-1)?.args[5]).toContain("respawn-pane");
    expect(runner.calls.at(-1)?.args[5]).toContain("/opt/claude cli");
    expect(runner.calls.at(-1)?.args[5]).toContain("review; exit 1");
  });
});

function tmuxError(message: string): Error {
  return Object.assign(new Error(message), { stderr: message });
}

function attachmentTarget(name: string) {
  return {
    sessionName: name,
    runtimeId: "$42",
    serverPid: "100",
    serverStartedAt: "200",
    ownership: NONCE_OWNERSHIP
  } as const;
}
