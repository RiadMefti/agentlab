import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync
} from "node:fs";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync, type StdioOptions } from "node:child_process";
import { createHash } from "node:crypto";
import { isatty } from "node:tty";

import { afterEach, describe, expect, it } from "vitest";

import {
  consumeNativeDiagnosticsInvocation,
  nativeDiagnosticsRetention,
  openNativeDiagnosticsLog
} from "../../apps/tui/src/bootstrap/native-diagnostics.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { force: true, recursive: true }))
  );
});

describe("native diagnostics bootstrap", () => {
  it("scrubs private argv and environment markers from an invalid direct handoff", async () => {
    const token = "123e4567-e89b-42d3-a456-426614174000";
    const capability = "not-a-capability";
    const result = await launchDiagnosticInvocation(
      [
        `--agentlab-tui-runtime=${token}`,
        `--agentlab-tui-diagnostic-capability=${capability}`,
        "remaining"
      ],
      {
        AGENTLAB_DIAGNOSTIC_LOG: "/private/legacy.log",
        AGENTLAB_TUI_DIAGNOSTIC_CAPABILITY: capability,
        AGENTLAB_TUI_RUNTIME: token,
        PRESERVED: "yes"
      }
    );

    expect(result).toMatchObject({ exitCode: 0, kind: "invalid", scrubbed: true, wrote: false });
  });

  it("does not expose a diagnostic writer to direct API callers", async () => {
    const invocation = await consumeNativeDiagnosticsInvocation(["bun", "main.tsx", "--version"], {
      PATH: "/usr/bin"
    });

    expect(invocation).toEqual({ arguments: ["--version"], kind: "direct" });
    expect("diagnostics" in invocation).toBe(false);
  });

  it("keeps real tmux private-mode and grapheme-capacity diagnostics off the interactive stream", async () => {
    const state = await temporaryState();
    const environment = { ...process.env, XDG_STATE_HOME: state };
    const log = openNativeDiagnosticsLog(environment);
    const fixture = resolve("tests/fixtures/native-diagnostic-renderer.bun.tsx");
    const child = spawn("bun", [fixture], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    const [stdout, stderr] = await Promise.all([
      readStream(child.stdout),
      readStream(child.stderr)
    ]);
    const exitCode = await new Promise<number | null>((resolve) => child.once("exit", resolve));
    log.write(stderr);
    log.close();

    expect(exitCode).toBe(0);
    expect(stdout).toBe("AGENTLAB_FRAME\n");
    expect(stdout).not.toContain("7727");
    expect(stdout).not.toContain("increaseCapacity");
    const diagnostics = readFileSync(log.path, "utf8");
    expect(diagnostics).toContain("unimplemented mode: 7727");
    expect(diagnostics).toContain("adjusting page capacity");
    expect(statSync(log.path).mode & 0o777).toBe(0o600);
  });

  it("uses a per-run XDG path and bounds the newest tail while its writer is active", async () => {
    const state = await temporaryState();
    const environment = { ...process.env, XDG_STATE_HOME: state };
    const log = openNativeDiagnosticsLog(environment);
    const oversized = Buffer.alloc(2 * 1024 * 1024 + 128, 0x78);
    oversized.write("LATEST_CRASH_OUTPUT", oversized.byteLength - 32, "utf8");
    log.write(oversized);
    expect(statSync(log.path).size).toBeLessThanOrEqual(nativeDiagnosticsRetention.maxFileBytes);
    expect(readFileSync(log.path, "utf8")).toContain("retained the newest diagnostics");
    log.close();

    expect(log.path).toMatch(/\/agentlab\/logs\/tui-[0-9a-f-]+\.log$/u);
    expect(statSync(log.path).size).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(readFileSync(log.path, "utf8")).toContain("LATEST_CRASH_OUTPUT");
    expect(readFileSync(log.path, "utf8")).toContain("retained the newest diagnostics");
    expect(statSync(join(state, "agentlab", "logs")).mode & 0o777).toBe(0o700);
  });

  it("drains a concurrent renderer through a live bounded single-writer pipe", async () => {
    const state = await temporaryState();
    const log = openNativeDiagnosticsLog({ ...process.env, XDG_STATE_HOME: state });
    const child = spawn(
      process.execPath,
      [
        "-e",
        "const fs=require('node:fs');let n=0;const b=Buffer.alloc(65536,120);const t=setInterval(()=>{fs.writeSync(2,b);if(++n===36)clearInterval(t)},2)"
      ],
      { stdio: ["ignore", "ignore", "pipe"] }
    );
    const stderr = child.stderr;
    const drain = (async () => {
      for await (const chunk of stderr) log.write(Buffer.from(chunk));
    })();
    await Promise.all([
      drain,
      new Promise<void>((resolveExit) =>
        child.once("exit", () => {
          resolveExit();
        })
      )
    ]);

    expect(statSync(log.path).size).toBeLessThanOrEqual(nativeDiagnosticsRetention.maxFileBytes);
    expect(readFileSync(log.path, "utf8")).toContain("retained the newest diagnostics");
    log.close();
    expect(statSync(log.path).size).toBeLessThanOrEqual(nativeDiagnosticsRetention.maxFileBytes);
  });

  it("bounds completed diagnostics across repeated launches", async () => {
    const state = await temporaryState();
    const environment = { ...process.env, XDG_STATE_HOME: state };
    for (let launch = 0; launch < nativeDiagnosticsRetention.maxFiles + 7; launch += 1) {
      const log = openNativeDiagnosticsLog(environment);
      log.write(`launch-${String(launch)}\n`);
      log.close();
      expect(existsSync(log.path)).toBe(true);
    }

    const files = retainedDiagnosticFiles(state);
    expect(files).toHaveLength(nativeDiagnosticsRetention.maxFiles);
    expect(files.every((path) => lstatSync(path).isFile())).toBe(true);
  });

  it("enforces the cross-run total-byte budget", async () => {
    const state = await temporaryState();
    const environment = { ...process.env, XDG_STATE_HOME: state };
    const payload = Buffer.alloc(2 * 1024 * 1024, 0x78);
    for (let launch = 0; launch < 9; launch += 1) {
      const log = openNativeDiagnosticsLog(environment);
      log.write(payload);
      log.close();
    }

    const files = retainedDiagnosticFiles(state);
    const totalBytes = files.reduce((total, path) => total + statSync(path).size, 0);
    expect(files.length).toBeGreaterThan(0);
    expect(files.length).toBeLessThanOrEqual(nativeDiagnosticsRetention.maxFiles);
    expect(totalBytes).toBeLessThanOrEqual(nativeDiagnosticsRetention.maxBytes);
  });

  it("never removes the active writer while retaining other launches", async () => {
    const state = await temporaryState();
    const environment = { ...process.env, XDG_STATE_HOME: state };
    const active = openNativeDiagnosticsLog(environment);
    const activePath = active.path;
    active.write("ACTIVE-BEGIN\n");

    for (let launch = 0; launch < nativeDiagnosticsRetention.maxFiles + 5; launch += 1) {
      const completed = openNativeDiagnosticsLog(environment);
      completed.write(`completed-${String(launch)}\n`);
      completed.close();
    }

    expect(existsSync(activePath)).toBe(true);
    active.write("ACTIVE-END\n");
    active.close();
    expect(active.path).not.toBe(activePath);
    expect(readFileSync(active.path, "utf8")).toContain("ACTIVE-BEGIN\nACTIVE-END");
  });

  it("accounts for active artifacts in global file and byte retention", async () => {
    const state = await temporaryState();
    const environment = { ...process.env, XDG_STATE_HOME: state };
    const active = openNativeDiagnosticsLog(environment);
    active.write(Buffer.alloc(nativeDiagnosticsRetention.maxFileBytes, 0x61));

    for (let launch = 0; launch < nativeDiagnosticsRetention.maxFiles + 3; launch += 1) {
      const completed = openNativeDiagnosticsLog(environment);
      completed.write(Buffer.alloc(nativeDiagnosticsRetention.maxFileBytes, 0x62));
      completed.close();
    }

    const artifacts = diagnosticArtifacts(state);
    expect(artifacts).toContain(active.path);
    expect(artifacts.length).toBeLessThanOrEqual(nativeDiagnosticsRetention.maxFiles);
    expect(artifacts.reduce((total, path) => total + statSync(path).size, 0)).toBeLessThanOrEqual(
      nativeDiagnosticsRetention.maxBytes
    );
    active.close();
  });

  it("recovers a stale active artifact after PID reuse using process-start identity", async () => {
    const state = await temporaryState();
    const directory = join(state, "agentlab", "logs");
    const runId = "123e4567-e89b-42d3-a456-426614174000";
    const stale = join(directory, `tui-${String(process.pid)}-0000000000000000-${runId}.active`);
    await mkdir(directory, { recursive: true });
    await writeFile(stale, "STALE-PID-REUSE\n");

    const log = openNativeDiagnosticsLog({ ...process.env, XDG_STATE_HOME: state });
    log.close();

    expect(existsSync(stale)).toBe(false);
    expect(readFileSync(join(directory, `tui-${runId}.log`), "utf8")).toContain("STALE-PID-REUSE");
  });

  it("bounds an abandoned oversized active artifact before retaining it", async () => {
    const state = await temporaryState();
    const directory = join(state, "agentlab", "logs");
    const runId = "223e4567-e89b-42d3-a456-426614174000";
    const abandoned = join(directory, `tui-2147483647-0000000000000000-${runId}.active`);
    const oversized = Buffer.alloc(nativeDiagnosticsRetention.maxFileBytes + 512, 0x78);
    oversized.write("ABANDONED-TAIL", oversized.byteLength - 32, "utf8");
    await mkdir(directory, { recursive: true });
    await writeFile(abandoned, oversized);

    const log = openNativeDiagnosticsLog({ ...process.env, XDG_STATE_HOME: state });
    log.close();
    const retained = join(directory, `tui-${runId}.log`);

    expect(existsSync(abandoned)).toBe(false);
    expect(statSync(retained).size).toBeLessThanOrEqual(nativeDiagnosticsRetention.maxFileBytes);
    expect(readFileSync(retained, "utf8")).toContain("ABANDONED-TAIL");
  });

  it("ignores symlinks and malformed or unreadable entries during retention", async () => {
    const state = await temporaryState();
    const directory = join(state, "agentlab", "logs");
    const target = join(state, "outside.log");
    const linkedName = "tui-123e4567-e89b-42d3-a456-426614174000.log";
    const malformed = join(directory, "tui-not-a-run.log");
    const unreadable = join(directory, "tui-223e4567-e89b-42d3-a456-426614174000.log");
    const disguisedDirectory = join(directory, "tui-323e4567-e89b-42d3-a456-426614174000.log");
    await mkdir(directory, { recursive: true });
    await writeFile(target, "outside");
    await symlink(target, join(directory, linkedName));
    await writeFile(malformed, "malformed");
    await writeFile(unreadable, "unreadable");
    await chmod(unreadable, 0o000);
    await mkdir(disguisedDirectory);

    const log = openNativeDiagnosticsLog({ ...process.env, XDG_STATE_HOME: state });
    log.close();

    expect(readFileSync(target, "utf8")).toBe("outside");
    expect(lstatSync(join(directory, linkedName)).isSymbolicLink()).toBe(true);
    expect(readFileSync(malformed, "utf8")).toBe("malformed");
    expect(lstatSync(unreadable).isFile()).toBe(true);
    expect(lstatSync(disguisedDirectory).isDirectory()).toBe(true);
    await chmod(unreadable, 0o600);
  });

  it("rejects a symlinked XDG state ancestor without writing into its target", async () => {
    const state = await temporaryState();
    const target = join(state, "redirect-target");
    const linkedState = join(state, "linked-state");
    await mkdir(target);
    await symlink(target, linkedState);

    expect(() => openNativeDiagnosticsLog({ ...process.env, XDG_STATE_HOME: linkedState })).toThrow(
      /Refusing unsafe AgentLab diagnostic directory/u
    );
    expect(existsSync(join(target, "agentlab"))).toBe(false);

    const result = await launchDevelopmentEntry(linkedState);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("terminal UI exited unexpectedly");
    expect(result.stderr).not.toContain("diagnostics:");
    expect(existsSync(join(target, "agentlab"))).toBe(false);
  });

  it("preserves an active writer owned by another bootstrap process", async () => {
    const state = await temporaryState();
    const childScript = [
      'import { openNativeDiagnosticsLog } from "./apps/tui/src/bootstrap/native-diagnostics.ts";',
      "const log = openNativeDiagnosticsLog(process.env);",
      'log.write("CHILD-BEGIN\\n");',
      "process.stdout.write(`${log.path}\\n`);",
      "setTimeout(() => {",
      '  log.write("CHILD-END\\n");',
      "  log.close();",
      "}, 400);"
    ].join("\n");
    const child = spawn("bun", ["-e", childScript], {
      env: { ...process.env, XDG_STATE_HOME: state },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const stderrPromise = readStream(child.stderr);
    const activePath = await readFirstLine(child.stdout);

    for (let launch = 0; launch < nativeDiagnosticsRetention.maxFiles + 4; launch += 1) {
      const log = openNativeDiagnosticsLog({ ...process.env, XDG_STATE_HOME: state });
      log.close();
    }

    expect(activePath).toMatch(/\.active$/u);
    expect(existsSync(activePath)).toBe(true);
    const exitCode = await new Promise<number | null>((resolveExit) =>
      child.once("exit", resolveExit)
    );
    expect(exitCode).toBe(0);
    expect(await stderrPromise).toBe("");
    expect(
      retainedDiagnosticFiles(state).some((path) =>
        readFileSync(path, "utf8").includes("CHILD-BEGIN\nCHILD-END")
      )
    ).toBe(true);
  });

  it("rejects descriptor reuse after activating a genuine pipe-shaped handoff", async () => {
    const state = await temporaryState();
    const replacement = join(state, "replacement.log");
    const token = "123e4567-e89b-42d3-a456-426614174000";
    const capability = "b".repeat(64);
    const proof = diagnosticCapabilityProof(token, capability);
    const script = [
      'import { closeSync, openSync } from "node:fs";',
      'import { consumeNativeDiagnosticsInvocation } from "./apps/tui/src/bootstrap/native-diagnostics.ts";',
      `const argv = ["bun", "main.tsx", "--agentlab-tui-runtime=${token}", "--agentlab-tui-diagnostic-capability=${proof}"];`,
      "const invocation = await consumeNativeDiagnosticsInvocation(argv, process.env);",
      "closeSync(2);",
      `if (openSync(${JSON.stringify(replacement)}, "w") !== 2) throw new Error("fd 2 was not reused");`,
      'process.stdout.write(String(invocation.kind === "runtime" && invocation.diagnostics.write("after reuse")));'
    ].join("\n");
    const child = spawn("bun", ["-e", script], {
      env: {
        ...process.env,
        AGENTLAB_TUI_DIAGNOSTIC_CAPABILITY: proof,
        AGENTLAB_TUI_RUNTIME: token
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"]
    });
    sendCapabilityHandoff(child, capability);
    const [stdout, stderr, exitCode] = await Promise.all([
      readStream(child.stdout),
      readStream(child.stderr),
      new Promise<number | null>((resolveExit) => child.once("exit", resolveExit))
    ]);

    expect(stdout).toBe("false");
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(readFileSync(replacement, "utf8")).toBe("");
  });

  it("rejects a closed fd 2 after activating diagnostics", async () => {
    const token = "123e4567-e89b-42d3-a456-426614174000";
    const capability = "2".repeat(64);
    const proof = diagnosticCapabilityProof(token, capability);
    const script = [
      'import { closeSync } from "node:fs";',
      'import { consumeNativeDiagnosticsInvocation } from "./apps/tui/src/bootstrap/native-diagnostics.ts";',
      `const argv = ["bun", "main.tsx", "--agentlab-tui-runtime=${token}", "--agentlab-tui-diagnostic-capability=${proof}"];`,
      "const invocation = await consumeNativeDiagnosticsInvocation(argv, process.env);",
      "closeSync(2);",
      'process.stdout.write(String(invocation.kind === "runtime" && invocation.diagnostics.write("after close")));'
    ].join("\n");
    const child = spawn("bun", ["-e", script], {
      env: diagnosticsEnvironment(token, proof),
      stdio: ["ignore", "pipe", "pipe", "ipc"]
    });
    sendCapabilityHandoff(child, capability);
    const [stdout, stderr, exitCode] = await Promise.all([
      readStream(child.stdout),
      readStream(child.stderr),
      new Promise<number | null>((resolveExit) => child.once("exit", resolveExit))
    ]);

    expect({ exitCode, stderr, stdout }).toEqual({ exitCode: 0, stderr: "", stdout: "false" });
  });

  it.skipIf(process.platform !== "linux")(
    "rejects a different pipe after fd 2 is reused",
    async () => {
      const state = await temporaryState();
      const fifo = join(state, "different.pipe");
      expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
      const reader = openSync(fifo, constants.O_RDONLY | constants.O_NONBLOCK);
      const token = "123e4567-e89b-42d3-a456-426614174000";
      const capability = "3".repeat(64);
      const proof = diagnosticCapabilityProof(token, capability);
      const script = [
        'import { closeSync, constants, openSync } from "node:fs";',
        'import { consumeNativeDiagnosticsInvocation } from "./apps/tui/src/bootstrap/native-diagnostics.ts";',
        `const argv = ["bun", "main.tsx", "--agentlab-tui-runtime=${token}", "--agentlab-tui-diagnostic-capability=${proof}"];`,
        "const invocation = await consumeNativeDiagnosticsInvocation(argv, process.env);",
        "closeSync(2);",
        `if (openSync(${JSON.stringify(fifo)}, constants.O_WRONLY | constants.O_NONBLOCK) !== 2) throw new Error("fd 2 was not reused");`,
        'process.stdout.write(String(invocation.kind === "runtime" && invocation.diagnostics.write("different pipe")));'
      ].join("\n");
      const child = spawn("bun", ["-e", script], {
        env: diagnosticsEnvironment(token, proof),
        stdio: ["ignore", "pipe", "pipe", "ipc"]
      });
      sendCapabilityHandoff(child, capability);
      try {
        const [stdout, stderr, exitCode] = await Promise.all([
          readStream(child.stdout),
          readStream(child.stderr),
          new Promise<number | null>((resolveExit) => child.once("exit", resolveExit))
        ]);
        expect({ exitCode, stderr, stdout }).toEqual({
          exitCode: 0,
          stderr: "",
          stdout: "false"
        });
      } finally {
        closeSync(reader);
      }
    }
  );

  it("tolerates cleanup and finalization failures after opening the writer", async () => {
    const state = await temporaryState();
    const log = openNativeDiagnosticsLog({ ...process.env, XDG_STATE_HOME: state });
    const directory = join(state, "agentlab", "logs");
    await chmod(directory, 0o500);

    expect(() => {
      log.close();
    }).not.toThrow();

    await chmod(directory, 0o700);
    expect(existsSync(log.path)).toBe(true);
  });

  it("rejects missing and mismatched capabilities without writing to fd 2", async () => {
    const token = "123e4567-e89b-42d3-a456-426614174000";
    const capability = "c".repeat(64);
    const missing = await launchDiagnosticInvocation([`--agentlab-tui-runtime=${token}`], {
      AGENTLAB_TUI_RUNTIME: token
    });
    const mismatched = await launchDiagnosticInvocation(
      [`--agentlab-tui-runtime=${token}`, `--agentlab-tui-diagnostic-capability=${capability}`],
      {
        AGENTLAB_TUI_DIAGNOSTIC_CAPABILITY: "d".repeat(64),
        AGENTLAB_TUI_RUNTIME: token
      }
    );
    const capabilityOnlyInArgumentsAndEnvironment = await launchDiagnosticInvocation(
      [
        `--agentlab-tui-runtime=${token}`,
        `--agentlab-tui-diagnostic-capability=${diagnosticCapabilityProof(token, capability)}`
      ],
      diagnosticsEnvironment(token, diagnosticCapabilityProof(token, capability))
    );

    expect(missing).toMatchObject({ exitCode: 0, kind: "runtime", stderr: "", wrote: false });
    expect(mismatched).toMatchObject({ exitCode: 0, kind: "invalid", stderr: "", wrote: false });
    expect(capabilityOnlyInArgumentsAndEnvironment).toMatchObject({
      exitCode: 0,
      kind: "invalid",
      stderr: "",
      wrote: false
    });
  });

  it("closes a silent forged fd 3 without blocking or authorizing diagnostics", async () => {
    const token = "123e4567-e89b-42d3-a456-426614174000";
    const capability = "7".repeat(64);
    const proof = diagnosticCapabilityProof(token, capability);
    const script = [
      'import { fstatSync } from "node:fs";',
      'import { consumeNativeDiagnosticsInvocation } from "./apps/tui/src/bootstrap/native-diagnostics.ts";',
      `const argv = ["bun", "main.tsx", "--agentlab-tui-runtime=${token}", "--agentlab-tui-diagnostic-capability=${proof}"];`,
      "const startedAt = Date.now();",
      "const invocation = await consumeNativeDiagnosticsInvocation(argv, process.env);",
      "let fd3Closed = false; try { fstatSync(3); } catch { fd3Closed = true; }",
      'const scrubbed = !argv.some((argument) => argument.startsWith("--agentlab-tui-")) && process.env.AGENTLAB_TUI_RUNTIME === undefined && process.env.AGENTLAB_TUI_DIAGNOSTIC_CAPABILITY === undefined;',
      'const wrote = invocation.kind === "runtime" && invocation.diagnostics.write("silent fd3");',
      "process.stdout.write(JSON.stringify({ elapsed: Date.now() - startedAt, fd3Closed, kind: invocation.kind, scrubbed, wrote }));"
    ].join("\n");
    const startedAt = Date.now();
    const child = spawn("bun", ["-e", script], {
      env: diagnosticsEnvironment(token, proof),
      stdio: ["ignore", "pipe", "pipe", "pipe"]
    });
    const silentWriter = child.stdio[3];
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        readStream(child.stdout),
        readStream(child.stderr),
        new Promise<number | null>((resolveExit) => child.once("exit", resolveExit))
      ]);
      const result = JSON.parse(stdout) as {
        elapsed: number;
        fd3Closed: boolean;
        kind: string;
        scrubbed: boolean;
        wrote: boolean;
      };

      expect(exitCode).toBe(0);
      expect(stderr).toBe("");
      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(result).toMatchObject({
        fd3Closed: true,
        kind: "invalid",
        scrubbed: true,
        wrote: false
      });
      expect(result.elapsed).toBeLessThan(250);
    } finally {
      silentWriter?.destroy();
    }
  });

  it("times out and closes a genuine but silent fd 3 IPC channel", async () => {
    const token = "123e4567-e89b-42d3-a456-426614174000";
    const capability = "a".repeat(64);
    const proof = diagnosticCapabilityProof(token, capability);
    const script = [
      'import { fstatSync } from "node:fs";',
      'import { consumeNativeDiagnosticsInvocation } from "./apps/tui/src/bootstrap/native-diagnostics.ts";',
      `const argv = ["bun", "main.tsx", "--agentlab-tui-runtime=${token}", "--agentlab-tui-diagnostic-capability=${proof}"];`,
      "const startedAt = Date.now();",
      "const invocation = await consumeNativeDiagnosticsInvocation(argv, process.env);",
      "let fd3Closed = false; try { fstatSync(3); } catch { fd3Closed = true; }",
      'const wrote = invocation.kind === "runtime" && invocation.diagnostics.write("silent ipc");',
      "process.stdout.write(JSON.stringify({ elapsed: Date.now() - startedAt, fd3Closed, kind: invocation.kind, wrote }));"
    ].join("\n");
    const child = spawn("bun", ["-e", script], {
      env: diagnosticsEnvironment(token, proof),
      stdio: ["ignore", "pipe", "pipe", "ipc"]
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      readStream(child.stdout),
      readStream(child.stderr),
      new Promise<number | null>((resolveExit) => child.once("exit", resolveExit))
    ]);
    const result = JSON.parse(stdout) as {
      elapsed: number;
      fd3Closed: boolean;
      kind: string;
      wrote: boolean;
    };

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(result).toMatchObject({ fd3Closed: true, kind: "invalid", wrote: false });
    expect(result.elapsed).toBeGreaterThanOrEqual(75);
    expect(result.elapsed).toBeLessThan(400);
  });

  it("closes a genuine fd 3 handoff even when argv and environment proofs mismatch", async () => {
    const token = "123e4567-e89b-42d3-a456-426614174000";
    const capability = "8".repeat(64);
    const argumentProof = diagnosticCapabilityProof(token, capability);
    const environmentProof = "9".repeat(64);
    const script = [
      'import { fstatSync } from "node:fs";',
      'import { consumeNativeDiagnosticsInvocation } from "./apps/tui/src/bootstrap/native-diagnostics.ts";',
      `const argv = ["bun", "main.tsx", "--agentlab-tui-runtime=${token}", "--agentlab-tui-diagnostic-capability=${argumentProof}"];`,
      "const invocation = await consumeNativeDiagnosticsInvocation(argv, process.env);",
      "let fd3Closed = false; try { fstatSync(3); } catch { fd3Closed = true; }",
      "const scrubbed = argv.length === 2 && process.env.AGENTLAB_TUI_RUNTIME === undefined && process.env.AGENTLAB_TUI_DIAGNOSTIC_CAPABILITY === undefined;",
      'process.stdout.write(JSON.stringify({ fd3Closed, hasWriter: "diagnostics" in invocation, kind: invocation.kind, scrubbed }));'
    ].join("\n");
    const child = spawn("bun", ["-e", script], {
      env: diagnosticsEnvironment(token, environmentProof),
      stdio: ["ignore", "pipe", "pipe", "ipc"]
    });
    sendCapabilityHandoff(child, capability);
    const [stdout, stderr, exitCode] = await Promise.all([
      readStream(child.stdout),
      readStream(child.stderr),
      new Promise<number | null>((resolveExit) => child.once("exit", resolveExit))
    ]);

    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(JSON.parse(stdout)).toEqual({
      fd3Closed: true,
      hasWriter: false,
      kind: "invalid",
      scrubbed: true
    });
  });

  it("accepts a matching capability inherited through the bootstrap pipe and scrubs it", async () => {
    const token = "123e4567-e89b-42d3-a456-426614174000";
    const capability = "f".repeat(64);
    const proof = diagnosticCapabilityProof(token, capability);
    const result = await launchDiagnosticInvocation(
      [`--agentlab-tui-runtime=${token}`, `--agentlab-tui-diagnostic-capability=${proof}`],
      {
        AGENTLAB_TUI_DIAGNOSTIC_CAPABILITY: proof,
        AGENTLAB_TUI_RUNTIME: token
      },
      "pipe",
      capability
    );

    expect(result).toEqual({
      exitCode: 0,
      kind: "runtime",
      scrubbed: true,
      stderr: "[agentlab] test diagnostic\n",
      wrote: true
    });
  });

  it("consumes authorization once and keeps every marker out of a descendant", async () => {
    const token = "123e4567-e89b-42d3-a456-426614174000";
    const capability = "4".repeat(64);
    const proof = diagnosticCapabilityProof(token, capability);
    const descendantScript =
      'process.stdout.write(JSON.stringify({argv:process.argv.filter((value)=>value.includes("agentlab-tui")),cap:process.env.AGENTLAB_TUI_DIAGNOSTIC_CAPABILITY,runtime:process.env.AGENTLAB_TUI_RUNTIME,path:process.env.AGENTLAB_DIAGNOSTIC_LOG}))';
    const script = [
      'import { spawnSync } from "node:child_process";',
      'import { consumeNativeDiagnosticsInvocation } from "./apps/tui/src/bootstrap/native-diagnostics.ts";',
      `const argv = ["bun", "main.tsx", "--agentlab-tui-runtime=${token}", "--agentlab-tui-diagnostic-capability=${proof}"];`,
      "const first = await consumeNativeDiagnosticsInvocation(argv, process.env);",
      "const second = await consumeNativeDiagnosticsInvocation(argv, process.env);",
      `const descendant = spawnSync(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], { encoding: "utf8", env: process.env });`,
      'const wrote = first.kind === "runtime" && first.diagnostics.write("one-shot writer");',
      'process.stdout.write(JSON.stringify({ descendant: descendant.stdout, second: second.kind, secondWriter: "diagnostics" in second, wrote }));'
    ].join("\n");
    const child = spawn("bun", ["-e", script], {
      env: {
        ...diagnosticsEnvironment(token, proof),
        AGENTLAB_DIAGNOSTIC_LOG: "/private/legacy.log"
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"]
    });
    sendCapabilityHandoff(child, capability);
    const [stdout, stderr, exitCode] = await Promise.all([
      readStream(child.stdout),
      readStream(child.stderr),
      new Promise<number | null>((resolveExit) => child.once("exit", resolveExit))
    ]);
    const result = JSON.parse(stdout) as {
      descendant: string;
      second: string;
      secondWriter: boolean;
      wrote: boolean;
    };

    expect(exitCode).toBe(0);
    expect(stderr).toBe("[agentlab] one-shot writer\n");
    expect(result).toEqual({
      descendant: '{"argv":[]}',
      second: "direct",
      secondWriter: false,
      wrote: true
    });
  });

  it("rejects arbitrary safe paths and non-pipe stderr descriptors", async () => {
    const state = await temporaryState();
    const unrelated = join(state, "unrelated.log");
    await writeFile(unrelated, "");
    const arbitraryPath = await launchDiagnosticInvocation([], {
      AGENTLAB_DIAGNOSTIC_LOG: unrelated
    });
    const token = "123e4567-e89b-42d3-a456-426614174000";
    const capability = "e".repeat(64);
    const proof = diagnosticCapabilityProof(token, capability);
    const ordinaryStderr = await launchDiagnosticInvocation(
      [`--agentlab-tui-runtime=${token}`, `--agentlab-tui-diagnostic-capability=${proof}`],
      {
        AGENTLAB_TUI_DIAGNOSTIC_CAPABILITY: proof,
        AGENTLAB_TUI_RUNTIME: token
      },
      "ignore",
      capability
    );

    expect(arbitraryPath).toMatchObject({ exitCode: 0, kind: "invalid", stderr: "", wrote: false });
    expect(ordinaryStderr).toMatchObject({
      exitCode: 0,
      kind: "runtime",
      stderr: "",
      wrote: false
    });
    expect(readFileSync(unrelated, "utf8")).toBe("");
  });

  it("rejects a regular-file fd 2 even with a genuine inherited capability", async () => {
    const state = await temporaryState();
    const path = join(state, "regular-stderr.log");
    const fd = openSync(path, constants.O_CREAT | constants.O_RDWR, 0o600);
    const token = "123e4567-e89b-42d3-a456-426614174000";
    const capability = "5".repeat(64);
    const proof = diagnosticCapabilityProof(token, capability);
    try {
      const result = await launchDiagnosticInvocation(
        [`--agentlab-tui-runtime=${token}`, `--agentlab-tui-diagnostic-capability=${proof}`],
        diagnosticsEnvironment(token, proof),
        fd,
        capability
      );
      expect(result).toMatchObject({ exitCode: 0, kind: "runtime", stderr: "", wrote: false });
      expect(readFileSync(path, "utf8")).toBe("");
    } finally {
      closeSync(fd);
    }
  });

  it.skipIf(process.platform !== "linux")(
    "rejects a TTY fd 2 even with a genuine inherited capability",
    async () => {
      const fd = openSync("/dev/ptmx", constants.O_RDWR | constants.O_NOCTTY);
      const token = "123e4567-e89b-42d3-a456-426614174000";
      const capability = "6".repeat(64);
      const proof = diagnosticCapabilityProof(token, capability);
      try {
        expect(isatty(fd)).toBe(true);
        const result = await launchDiagnosticInvocation(
          [`--agentlab-tui-runtime=${token}`, `--agentlab-tui-diagnostic-capability=${proof}`],
          diagnosticsEnvironment(token, proof),
          fd,
          capability
        );
        expect(result).toMatchObject({ exitCode: 0, kind: "runtime", stderr: "", wrote: false });
      } finally {
        closeSync(fd);
      }
    }
  );

  it("does not let the real runtime caller write with a forged stale marker", async () => {
    const state = await temporaryState();
    const unrelated = join(state, "unrelated.log");
    const token = "123e4567-e89b-42d3-a456-426614174000";
    const capability = "1".repeat(64);
    await writeFile(unrelated, "");
    const child = spawn(
      "bun",
      [
        resolve("apps/tui/src/main.tsx"),
        `--agentlab-tui-runtime=${token}`,
        `--agentlab-tui-diagnostic-capability=${capability}`
      ],
      {
        env: {
          ...process.env,
          AGENTLAB_DIAGNOSTIC_LOG: unrelated,
          AGENTLAB_TUI_DIAGNOSTIC_CAPABILITY: capability,
          AGENTLAB_TUI_RUNTIME: token
        },
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      readStream(child.stdout),
      readStream(child.stderr),
      new Promise<number | null>((resolveExit) => child.once("exit", resolveExit))
    ]);

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe("");
    expect(readFileSync(unrelated, "utf8")).toBe("");
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
    const diagnosticPath = diagnosticsPathFrom(stderr);
    const diagnostics = readFileSync(diagnosticPath, "utf8");

    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("diagnostics:");
    expect(stderr).not.toContain("must run in an interactive terminal");
    expect(diagnostics).toContain("must run in an interactive terminal");
  });

  it.each(["symlinked logs directory", "unwritable state root", "state root file"])(
    "launches with fd2 contained when diagnostics cannot open: %s",
    async (failure) => {
      const state = await temporaryState();
      let xdgState = state;
      if (failure === "symlinked logs directory") {
        await mkdir(join(state, "agentlab"));
        await symlink(state, join(state, "agentlab", "logs"));
      } else if (failure === "unwritable state root") {
        await chmod(state, 0o500);
      } else {
        const file = join(state, "state-file");
        await writeFile(file, "not a directory");
        xdgState = file;
      }

      const result = await launchDevelopmentEntry(xdgState);
      if (failure === "unwritable state root") await chmod(state, 0o700);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("terminal UI exited unexpectedly");
      expect(result.stderr).not.toContain("diagnostics:");
      expect(result.stderr).not.toMatch(/EACCES|ENOTDIR|Refusing unsafe/u);
    }
  );
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

async function readFirstLine(stream: NodeJS.ReadableStream | null): Promise<string> {
  if (stream === null) throw new Error("Missing child stdout.");
  return await new Promise<string>((resolveLine, reject) => {
    let buffered = "";
    stream.on("data", (chunk: Buffer | string) => {
      buffered += chunk.toString();
      const newline = buffered.indexOf("\n");
      if (newline >= 0) resolveLine(buffered.slice(0, newline));
    });
    stream.once("error", reject);
    stream.once("end", () => {
      reject(new Error("Child exited before publishing its log path."));
    });
  });
}

async function launchDiagnosticInvocation(
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  stderrMode: "ignore" | "pipe" | number = "pipe",
  inheritedCapability?: string
): Promise<{
  readonly exitCode: number | null;
  readonly kind: string;
  readonly scrubbed: boolean;
  readonly stderr: string;
  readonly wrote: boolean;
}> {
  const script = [
    'import { consumeNativeDiagnosticsInvocation } from "./apps/tui/src/bootstrap/native-diagnostics.ts";',
    `const argv = ["bun", "main.tsx", ...${JSON.stringify(args)}];`,
    "const invocation = await consumeNativeDiagnosticsInvocation(argv, process.env);",
    'const scrubbed = !argv.some((argument) => argument.startsWith("--agentlab-tui-")) && process.env.AGENTLAB_TUI_RUNTIME === undefined && process.env.AGENTLAB_TUI_DIAGNOSTIC_CAPABILITY === undefined && process.env.AGENTLAB_DIAGNOSTIC_LOG === undefined;',
    'const wrote = invocation.kind === "runtime" && invocation.diagnostics.write("test diagnostic");',
    "process.stdout.write(JSON.stringify({ kind: invocation.kind, scrubbed, wrote }));"
  ].join("\n");
  const stdio: StdioOptions =
    inheritedCapability === undefined
      ? ["ignore", "pipe", stderrMode]
      : ["ignore", "pipe", stderrMode, "ipc"];
  const child = spawn("bun", ["-e", script], {
    env: { ...process.env, ...environment },
    stdio
  });
  if (inheritedCapability !== undefined) {
    sendCapabilityHandoff(child, inheritedCapability);
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    readStream(child.stdout),
    readStream(child.stderr),
    new Promise<number | null>((resolveExit) => child.once("exit", resolveExit))
  ]);
  const result = JSON.parse(stdout) as {
    readonly kind: string;
    readonly scrubbed: boolean;
    readonly wrote: boolean;
  };
  return {
    exitCode,
    kind: result.kind,
    scrubbed: result.scrubbed,
    stderr,
    wrote: result.wrote
  };
}

function sendCapabilityHandoff(child: ReturnType<typeof spawn>, capability: string): void {
  child.send({ capability, type: "agentlab-native-diagnostics" }, (): void => {
    if (child.connected) child.disconnect();
  });
}

function diagnosticCapabilityProof(runtimeToken: string, capability: string): string {
  return createHash("sha256").update(runtimeToken).update("\0").update(capability).digest("hex");
}

function diagnosticsEnvironment(runtimeToken: string, capabilityProof: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AGENTLAB_TUI_DIAGNOSTIC_CAPABILITY: capabilityProof,
    AGENTLAB_TUI_RUNTIME: runtimeToken
  };
}

function retainedDiagnosticFiles(state: string): string[] {
  const directory = join(state, "agentlab", "logs");
  return readdirSync(directory)
    .filter((name) => /^tui-[0-9a-f-]+\.log$/u.test(name))
    .map((name) => join(directory, name));
}

function diagnosticArtifacts(state: string): string[] {
  const directory = join(state, "agentlab", "logs");
  return readdirSync(directory)
    .filter((name) => /^tui-.+\.(?:active|log)$/u.test(name))
    .map((name) => join(directory, name));
}

async function launchDevelopmentEntry(state: string) {
  const child = spawn("bun", [resolve("apps/tui/src/main.tsx")], {
    env: { ...process.env, XDG_STATE_HOME: state },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    readStream(child.stdout),
    readStream(child.stderr),
    new Promise<number | null>((resolveExit) => child.once("exit", resolveExit))
  ]);
  return { exitCode, stderr, stdout };
}

function diagnosticsPathFrom(stderr: string): string {
  const path = /diagnostics: ([^\n]+)/u.exec(stderr)?.[1];
  if (path === undefined) throw new Error(`Missing diagnostics path in: ${stderr}`);
  return path;
}
