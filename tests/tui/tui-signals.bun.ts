import { constants as osConstants } from "node:os";

import { describe, expect, test } from "bun:test";

import { exitCodeForSignal } from "../../apps/tui/src/bootstrap/signal-exit.js";
import { createRuntimeSmokeSandbox } from "../../scripts/runtime-smoke-sandbox.js";

const signals = ["SIGINT", "SIGTERM", "SIGHUP", "SIGQUIT", "SIGABRT", "SIGBUS"] as const;

describe("terminal UI process signals", () => {
  for (const signal of signals) {
    test(`restores terminal modes and preserves ${signal} status without orphans`, async () => {
      const sandbox = await createRuntimeSmokeSandbox("agentlab-source-signal-");
      let output = "";
      const decoder = new TextDecoder();
      try {
        const child = Bun.spawn([process.execPath, "apps/tui/src/main.tsx"], {
          env: sandbox.environment,
          terminal: {
            cols: 100,
            rows: 30,
            name: "xterm-256color",
            data: (_terminal, data) => {
              output += decoder.decode(data, { stream: true });
            }
          }
        });
        try {
          await waitFor(() => output.includes("\x1b[?1049h"));
          const rendererPid = await childProcessId(child.pid);
          const signalNumber = osConstants.signals[signal];
          child.kill(signalNumber);

          expect(await child.exited).toBe(exitCodeForSignal(signal));
          expect(output).toContain("\x1b[?1006l");
          expect(output).toContain("\x1b[?1049l");
          await waitFor(() => !processExists(rendererPid));
        } finally {
          if (!child.killed) child.kill();
        }
      } finally {
        await sandbox.dispose();
      }
    });
  }
});

async function childProcessId(parentPid: number): Promise<number> {
  const process = Bun.spawn(["pgrep", "-P", String(parentPid)], { stdout: "pipe" });
  const [exitCode, output] = await Promise.all([
    process.exited,
    new Response(process.stdout).text()
  ]);
  const pid = Number(output.trim().split("\n")[0]);
  if (exitCode !== 0 || !Number.isSafeInteger(pid)) {
    throw new Error(`Renderer child for ${String(parentPid)} was not found.`);
  }
  return pid;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for terminal process state.");
    await Bun.sleep(20);
  }
}
