import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { buildCaptainSessionName } from "../../apps/server/src/domain/agent-session-name.js";
import { NodeCommandRunner } from "../../apps/server/src/infrastructure/process/command-runner.js";
import { NodePtyTerminalFactory } from "../../apps/server/src/infrastructure/terminal/pseudo-terminal.js";
import { TmuxSessionRuntime } from "../../apps/server/src/infrastructure/tmux/tmux-session-runtime.js";

describe.runIf(process.env.AO_RUN_TMUX_INTEGRATION === "1")("browser PTY integration", () => {
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

    const terminal = new NodePtyTerminalFactory(socketPath).attach(name, process.cwd());
    await expect.poll(async () => (await runtime.list(conversationId))[0]?.attached).toBe(true);

    const exited = new Promise<void>((resolve) => {
      terminal.onExit(() => {
        resolve();
      });
    });
    terminal.kill();
    await exited;

    await expect.poll(async () => (await runtime.list(conversationId))[0]?.attached).toBe(false);
    await expect(runtime.exists(name)).resolves.toBe(true);
  });
});
