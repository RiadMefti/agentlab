import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { NodeCommandRunner } from "../../packages/runtime/src/infrastructure/process/command-runner.js";
import {
  buildCaptainSessionName,
  buildWorkerSessionName
} from "../../packages/runtime/src/domain/agent-session-name.js";
import { renderShellCommand } from "../../packages/runtime/src/infrastructure/tmux/shell-command.js";
import { TmuxSessionRuntime } from "../../packages/runtime/src/infrastructure/tmux/tmux-session-runtime.js";
import type { SessionOwnership } from "../../packages/runtime/src/domain/session-runtime.js";
import {
  guardedTmuxArguments,
  ownedSessionGuardRejected
} from "../../packages/runtime/src/infrastructure/tmux/owned-session-guard.js";

describe.runIf(process.env.AGENTLAB_RUN_TMUX_INTEGRATION === "1")(
  "TmuxSessionRuntime integration",
  () => {
    const runner = new NodeCommandRunner();
    const socketPath = `/tmp/ao-test-${randomUUID()}.sock`;
    const runtime = new TmuxSessionRuntime(runner, socketPath);
    const created: { readonly name: string; readonly ownership: SessionOwnership }[] = [];

    afterEach(async () => {
      try {
        await Promise.all(
          created.splice(0).map(({ name, ownership }) => runtime.killOwned(name, ownership))
        );
      } finally {
        try {
          await runner.run("tmux", ["-S", socketPath, "kill-server"]);
        } catch {
          // Removing the final managed session normally stops the private server first.
        }
        rmSync(socketPath, { force: true });
      }
    });

    it("creates, discovers, and removes a real managed session", async () => {
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

      await expect(runtime.inspectOwnership(name)).resolves.toEqual({
        status: "present",
        nonce: ownership.nonce
      });
      await runtime.killOwned(name, ownership);
      created.pop();
      await expect(runtime.exists(name)).resolves.toBe(false);
    });

    it("discovers a worker created directly through raw tmux commands", async () => {
      const conversationId = randomUUID();
      const name = buildWorkerSessionName(conversationId, "claude", "review-tests");
      created.push({ name, ownership: { mode: "legacy-name" } });

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
      const ownership = { mode: "nonce", nonce: randomUUID() } as const;
      created.push({ name, ownership });

      await runtime.createCaptain({
        name,
        cwd: process.cwd(),
        command: {
          executable: process.execPath,
          args: [
            "-e",
            'console.log("captain startup failed"); setTimeout(() => process.exit(0), 50)'
          ]
        },
        ownership
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
        `=${name}:`
      ]);
      expect(stdout).toContain("captain startup failed");
    });

    it("refuses a guarded kill after server restart and session-ID reuse", async () => {
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
      const previousServerPid = Number.parseInt(resolution.target.serverPid, 10);
      if (!Number.isSafeInteger(previousServerPid) || previousServerPid <= 0) {
        throw new Error("created session did not expose a valid server PID");
      }

      await runner.run("tmux", ["-S", socketPath, "kill-server"]);
      await expect
        .poll(() => processExists(previousServerPid), { interval: 10, timeout: 5_000 })
        .toBe(false);
      // tmux can leave a stale custom socket after the owning server has exited.
      rmSync(socketPath, { force: true });
      expect(existsSync(socketPath)).toBe(false);
      await runner.run("tmux", [
        "-S",
        socketPath,
        "new-session",
        "-d",
        "-s",
        name,
        "-e",
        `AGENTLAB_SESSION_OWNERSHIP=${ownership.nonce}`,
        "-c",
        process.cwd()
      ]);
      created.push({ name, ownership: { mode: "legacy-name" } });

      const { stdout } = await runner.run("tmux", [
        "-S",
        socketPath,
        ...guardedTmuxArguments(resolution.target, [
          "kill-session",
          "-t",
          resolution.target.runtimeId
        ])
      ]);
      expect(ownedSessionGuardRejected(stdout)).toBe(true);
      await expect(runtime.exists(name)).resolves.toBe(true);
    });

    it("refuses configuration and kill after an in-server rename", async () => {
      const conversationId = randomUUID();
      const name = buildCaptainSessionName(conversationId, "codex");
      const renamed = buildCaptainSessionName(randomUUID(), "claude");
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
      await runner.run("tmux", ["-S", socketPath, "rename-session", "-t", `=${name}`, renamed]);
      created.push({ name: renamed, ownership });

      for (const action of [
        ["set-option", "-t", resolution.target.runtimeId, "status", "on"],
        ["kill-session", "-t", resolution.target.runtimeId]
      ]) {
        const { stdout } = await runner.run("tmux", [
          "-S",
          socketPath,
          ...guardedTmuxArguments(resolution.target, action)
        ]);
        expect(ownedSessionGuardRejected(stdout)).toBe(true);
      }

      const { stdout } = await runner.run("tmux", [
        "-S",
        socketPath,
        "show-options",
        "-v",
        "-t",
        `=${renamed}:`,
        "status"
      ]);
      expect(stdout.trim()).toBe("off");
      await expect(runtime.exists(renamed)).resolves.toBe(true);
    });
  }
);

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
