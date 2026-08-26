import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { NodeCommandRunner } from "../../packages/runtime/src/infrastructure/process/command-runner.js";
import {
  buildCaptainSessionName,
  buildWorkerSessionName
} from "../../packages/runtime/src/domain/agent-session-name.js";
import { renderShellCommand } from "../../packages/runtime/src/infrastructure/tmux/shell-command.js";
import { TmuxSessionRuntime } from "../../packages/runtime/src/infrastructure/tmux/tmux-session-runtime.js";

describe.runIf(process.env.AGENTLAB_RUN_TMUX_INTEGRATION === "1")(
  "TmuxSessionRuntime integration",
  () => {
    const runner = new NodeCommandRunner();
    const socketPath = `/tmp/ao-test-${randomUUID()}.sock`;
    const runtime = new TmuxSessionRuntime(runner, socketPath);
    const created: string[] = [];

    afterEach(async () => {
      try {
        await Promise.all(created.splice(0).map((name) => runtime.kill(name)));
      } finally {
        rmSync(socketPath, { force: true });
      }
    });

    it("creates, discovers, and removes a real managed session", async () => {
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

      await expect(runtime.exists(name)).resolves.toBe(true);
      await expect(runtime.list(conversationId)).resolves.toEqual([
        expect.objectContaining({
          name,
          conversationId,
          role: "captain",
          provider: "codex",
          status: "running"
        })
      ]);

      await runtime.kill(name);
      created.pop();
      await expect(runtime.exists(name)).resolves.toBe(false);
    });

    it("discovers a worker created directly through raw tmux commands", async () => {
      const conversationId = randomUUID();
      const name = buildWorkerSessionName(conversationId, "claude", "review-tests");
      created.push(name);

      await runner.run("tmux", [
        "-S",
        socketPath,
        "new-session",
        "-d",
        "-s",
        name,
        "-c",
        process.cwd(),
        renderShellCommand({
          executable: process.execPath,
          args: ["-e", "setInterval(() => undefined, 1000)"]
        })
      ]);

      await expect(runtime.list(conversationId)).resolves.toEqual([
        expect.objectContaining({
          name,
          conversationId,
          role: "worker",
          provider: "claude",
          label: "Review Tests"
        })
      ]);
    });

    it("retains a captain that exits immediately so its output remains inspectable", async () => {
      const conversationId = randomUUID();
      const name = buildCaptainSessionName(conversationId, "codex");
      created.push(name);

      await runtime.createCaptain({
        name,
        cwd: process.cwd(),
        command: {
          executable: process.execPath,
          args: [
            "-e",
            'console.log("captain startup failed"); setTimeout(() => process.exit(0), 50)'
          ]
        }
      });

      await expect
        .poll(async () => (await runtime.list(conversationId))[0]?.status)
        .toBe("stopped");
      const { stdout } = await runner.run("tmux", [
        "-S",
        socketPath,
        "capture-pane",
        "-p",
        "-S",
        "-20000",
        "-t",
        `${name}:`
      ]);
      expect(stdout).toContain("captain startup failed");
    });
  }
);
