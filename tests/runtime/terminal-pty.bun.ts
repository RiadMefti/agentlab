import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";

import { afterEach, describe, expect, it } from "bun:test";

import { buildCaptainSessionName } from "../../packages/runtime/src/domain/agent-session-name.js";
import { SessionTerminalOwner } from "../../packages/runtime/src/application/session-terminal.js";
import { NodeCommandRunner } from "../../packages/runtime/src/infrastructure/process/command-runner.js";
import { BunTerminalFactory } from "../../packages/runtime/src/infrastructure/terminal/bun-terminal.js";
import { TmuxSessionRuntime } from "../../packages/runtime/src/infrastructure/tmux/tmux-session-runtime.js";
import type { SessionOwnership } from "../../packages/runtime/src/domain/session-runtime.js";

const describeIntegration =
  process.env.AGENTLAB_RUN_TMUX_INTEGRATION === "1" ? describe : describe.skip;

describeIntegration("Bun PTY integration", () => {
  const socketPath = `/tmp/ao-pty-${randomUUID()}.sock`;
  const runtime = new TmuxSessionRuntime(new NodeCommandRunner(), socketPath);
  const created: { readonly name: string; readonly ownership: SessionOwnership }[] = [];

  afterEach(async () => {
    try {
      await Promise.all(
        created.splice(0).map(({ name, ownership }) => runtime.killOwned(name, ownership))
      );
    } finally {
      try {
        await new NodeCommandRunner().run("tmux", ["-S", socketPath, "kill-server"]);
      } catch {
        // A successful managed-session cleanup may already have stopped the private server.
      }
      rmSync(socketPath, { force: true });
    }
  });

  it("attaches to the exact session and detaches without stopping it", async () => {
    const conversationId = randomUUID();
    const name = buildCaptainSessionName(conversationId, "codex");
    const ownership = { mode: "nonce", nonce: randomUUID() } as const;
    created.push({ name, ownership });
    await runtime.createCaptain({
      name,
      cwd: process.cwd(),
      command: {
        executable: process.execPath,
        args: ["-e", "setInterval(() => undefined, 1000)"]
      },
      ownership
    });

    const resolution = await runtime.resolveOwnedTarget(name, ownership);
    if (resolution.status !== "owned") throw new Error("created session was not owned");
    const terminal = new BunTerminalFactory(socketPath).attach(
      resolution.target,
      process.cwd(),
      { columns: 91, rows: 27 },
      new SessionTerminalOwner()
    );
    expect(await poll(async () => (await runtime.list(conversationId))[0]?.attached, true)).toBe(
      true
    );
    expect(
      await poll(async () => {
        const { stdout } = await new NodeCommandRunner().run("tmux", [
          "-S",
          socketPath,
          "list-clients",
          "-F",
          "#{client_width}x#{client_height}"
        ]);
        return stdout.trim();
      }, "91x27")
    ).toBe("91x27");

    const exited = new Promise<void>((resolve) => {
      terminal.onExit(() => {
        resolve();
      });
    });
    terminal.kill();
    await exited;

    expect(await poll(async () => (await runtime.list(conversationId))[0]?.attached, false)).toBe(
      false
    );
    expect(await runtime.exists(name)).toBe(true);
  });

  it("refuses attachment when a restarted server reuses the old session ID", async () => {
    const runner = new NodeCommandRunner();
    const conversationId = randomUUID();
    const name = buildCaptainSessionName(conversationId, "codex");
    const ownership = { mode: "nonce", nonce: randomUUID() } as const;
    await runtime.createCaptain({
      name,
      cwd: process.cwd(),
      command: {
        executable: process.execPath,
        args: ["-e", "setInterval(() => undefined, 1000)"]
      },
      ownership
    });
    const resolution = await runtime.resolveOwnedTarget(name, ownership);
    if (resolution.status !== "owned") throw new Error("created session was not owned");

    await runner.run("tmux", ["-S", socketPath, "kill-server"]);
    await runner.run("tmux", [
      "-S",
      socketPath,
      "new-session",
      "-d",
      "-s",
      name,
      "-c",
      process.cwd()
    ]);
    created.push({ name, ownership });

    const terminal = new BunTerminalFactory(socketPath).attach(
      resolution.target,
      process.cwd(),
      { columns: 80, rows: 24 },
      new SessionTerminalOwner()
    );
    await new Promise<void>((resolve) => {
      terminal.onExit(() => {
        resolve();
      });
    });

    expect((await runtime.list(conversationId))[0]?.attached).toBe(false);
    expect(await runtime.inspectOwnership(name)).toEqual({
      status: "present",
      nonce: null
    });
  });

  it("refuses attachment when the resolved session is renamed in the same server", async () => {
    const runner = new NodeCommandRunner();
    const conversationId = randomUUID();
    const name = buildCaptainSessionName(conversationId, "codex");
    const renamed = buildCaptainSessionName(randomUUID(), "claude");
    const ownership = { mode: "nonce", nonce: randomUUID() } as const;
    created.push({ name: renamed, ownership });
    await runtime.createCaptain({
      name,
      cwd: process.cwd(),
      command: {
        executable: process.execPath,
        args: ["-e", "setInterval(() => undefined, 1000)"]
      },
      ownership
    });
    const resolution = await runtime.resolveOwnedTarget(name, ownership);
    if (resolution.status !== "owned") throw new Error("created session was not owned");
    await runner.run("tmux", ["-S", socketPath, "rename-session", "-t", `=${name}`, renamed]);

    const owner = new SessionTerminalOwner();
    const terminal = new BunTerminalFactory(socketPath).attach(
      resolution.target,
      process.cwd(),
      { columns: 80, rows: 24 },
      owner
    );
    await new Promise<void>((resolve) => {
      terminal.onExit(() => {
        resolve();
      });
    });

    const { stdout } = await runner.run("tmux", [
      "-S",
      socketPath,
      "display-message",
      "-p",
      "-t",
      `=${renamed}:`,
      "#{session_attached}"
    ]);
    expect(stdout.trim()).toBe("0");
    await owner.closeAll();
  });
});

async function poll<T>(read: () => Promise<T>, expected: T): Promise<T> {
  const deadline = Date.now() + 3_000;
  let value = await read();
  while (value !== expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    value = await read();
  }
  return value;
}
