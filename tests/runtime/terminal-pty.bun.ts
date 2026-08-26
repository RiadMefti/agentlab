import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";

import { afterEach, describe, expect, it } from "bun:test";

import { buildCaptainSessionName } from "../../packages/runtime/src/domain/agent-session-name.js";
import { NodeCommandRunner } from "../../packages/runtime/src/infrastructure/process/command-runner.js";
import { BunTerminalFactory } from "../../packages/runtime/src/infrastructure/terminal/bun-terminal.js";
import { TmuxSessionRuntime } from "../../packages/runtime/src/infrastructure/tmux/tmux-session-runtime.js";

const describeIntegration = process.env.AO_RUN_TMUX_INTEGRATION === "1" ? describe : describe.skip;

describeIntegration("Bun PTY integration", () => {
  const socketPath = `/tmp/ao-pty-${randomUUID()}.sock`;
  const runtime = new TmuxSessionRuntime(new NodeCommandRunner(), socketPath);
  const created: string[] = [];

  afterEach(async () => {
    try {
      await Promise.all(created.splice(0).map((name) => runtime.kill(name)));
    } finally {
      rmSync(socketPath, { force: true });
    }
  });

  it("attaches to the exact session and detaches without stopping it", async () => {
    const conversationId = randomUUID();
    const name = buildCaptainSessionName(conversationId, "codex");
    created.push(name);
    await runtime.createCaptain({
      name,
      cwd: process.cwd(),
      command: {
        executable: process.execPath,
        args: ["-e", "setInterval(() => undefined, 1000)"]
      }
    });

    const terminal = new BunTerminalFactory(socketPath).attach(name, process.cwd(), {
      columns: 91,
      rows: 27
    });
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
