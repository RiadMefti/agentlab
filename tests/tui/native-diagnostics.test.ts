import { readFileSync, statSync, writeSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import {
  nativeDiagnosticsRuntimeArguments,
  nativeDiagnosticsLogPath,
  openNativeDiagnosticsLog
} from "../../apps/tui/src/bootstrap/native-diagnostics.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true }))
  );
});

describe("native diagnostics bootstrap", () => {
  it("accepts only a matching generated runtime token at the process boundary", () => {
    const token = "123e4567-e89b-42d3-a456-426614174000";
    expect(nativeDiagnosticsRuntimeArguments([], { AGENTLAB_TUI_RUNTIME: "1" })).toBeNull();
    expect(
      nativeDiagnosticsRuntimeArguments([`--agentlab-tui-runtime=${token}`], {
        AGENTLAB_TUI_RUNTIME: "different"
      })
    ).toBeNull();
    expect(
      nativeDiagnosticsRuntimeArguments([`--agentlab-tui-runtime=${token}`, "remaining"], {
        AGENTLAB_TUI_RUNTIME: token
      })
    ).toEqual(["remaining"]);
  });

  it("keeps real tmux private-mode and grapheme-capacity diagnostics off the interactive stream", async () => {
    const state = await temporaryState();
    const environment = { ...process.env, XDG_STATE_HOME: state };
    const log = openNativeDiagnosticsLog(environment);
    const fixture = resolve("tests/fixtures/native-diagnostic-renderer.bun.tsx");
    const child = spawn("bun", [fixture], {
      stdio: ["ignore", "pipe", log.fd]
    });
    const stdout = await readStream(child.stdout);
    const exitCode = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    log.close();

    expect(exitCode).toBe(0);
    expect(stdout).toBe("AGENTLAB_FRAME\n");
    expect(stdout).not.toContain("7727");
    expect(stdout).not.toContain("increaseCapacity");
    const diagnostics = readFileSync(nativeDiagnosticsLogPath(environment), "utf8");
    expect(diagnostics).toContain("unimplemented mode: 7727");
    expect(diagnostics).toContain("adjusting page capacity");
    expect(statSync(nativeDiagnosticsLogPath(environment)).mode & 0o777).toBe(0o600);
  });

  it("uses the XDG state root and rotates a bounded private log", async () => {
    const state = await temporaryState();
    const environment = { ...process.env, XDG_STATE_HOME: state };
    const first = openNativeDiagnosticsLog(environment);
    const oversized = Buffer.alloc(2 * 1024 * 1024 + 128, 0x78);
    oversized.write("LATEST_CRASH_OUTPUT", oversized.byteLength - 32, "utf8");
    let offset = 0;
    while (offset < oversized.byteLength) {
      offset += writeSync(first.fd, oversized, offset, oversized.byteLength - offset);
    }
    first.close();

    const second = openNativeDiagnosticsLog(environment);
    second.close();
    const path = nativeDiagnosticsLogPath(environment);
    expect(path).toBe(join(state, "agentlab", "logs", "tui.log"));
    expect(statSync(`${path}.1`).size).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(readFileSync(`${path}.1`, "utf8")).toContain("LATEST_CRASH_OUTPUT");
    expect(readFileSync(`${path}.1`, "utf8")).toContain("retained the newest diagnostics");
    expect(statSync(join(state, "agentlab", "logs")).mode & 0o777).toBe(0o700);
  });

  it("boots the development entry with renderer stderr isolated and its exit code preserved", async () => {
    const state = await temporaryState();
    const child = spawn("bun", [resolve("apps/tui/src/main.tsx")], {
      env: { ...process.env, XDG_STATE_HOME: state },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      readStream(child.stdout),
      readStream(child.stderr),
      new Promise<number | null>((resolveExit) => child.once("exit", resolveExit))
    ]);
    const diagnostics = readFileSync(nativeDiagnosticsLogPath({ XDG_STATE_HOME: state }), "utf8");

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("diagnostics:");
    expect(stderr).not.toContain("must run in an interactive terminal");
    expect(diagnostics).toContain("must run in an interactive terminal");
  });
});

async function temporaryState(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "agentlab-diagnostics-"));
  temporaryDirectories.push(path);
  return path;
}

async function readStream(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (stream === null) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
