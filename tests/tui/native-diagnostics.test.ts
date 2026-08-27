import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

import { afterEach, describe, expect, it } from "vitest";

import {
  consumeNativeDiagnosticsEnvironment,
  nativeDiagnosticsRetention,
  nativeDiagnosticsRuntimeArguments,
  openNativeDiagnosticsLog,
  writeNativeDiagnostic
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

  it("finishes cleanly when a renderer externally closes its stderr pipe descriptor", async () => {
    const state = await temporaryState();
    const log = openNativeDiagnosticsLog({ ...process.env, XDG_STATE_HOME: state });
    const script = [
      'import { closeSync } from "node:fs";',
      'import { consumeNativeDiagnosticsEnvironment, writeNativeDiagnostic } from "./apps/tui/src/bootstrap/native-diagnostics.ts";',
      "consumeNativeDiagnosticsEnvironment(process.env);",
      "closeSync(2);",
      'process.stdout.write(String(writeNativeDiagnostic("after external close")));'
    ].join("\n");
    const child = spawn("bun", ["-e", script], {
      env: { ...process.env, AGENTLAB_DIAGNOSTIC_LOG: log.path },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      readStream(child.stdout),
      readStream(child.stderr),
      new Promise<number | null>((resolveExit) => child.once("exit", resolveExit))
    ]);

    expect(stdout).toBe("false");
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(() => {
      log.write(stderr);
      log.close();
    }).not.toThrow();
    expect(existsSync(log.path)).toBe(true);
  });

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

  it("routes renderer teardown failures through the private diagnostic pipe", async () => {
    const state = await temporaryState();
    const environment = { ...process.env, XDG_STATE_HOME: state };
    const log = openNativeDiagnosticsLog(environment);
    const script = [
      'import { consumeNativeDiagnosticsEnvironment, writeNativeDiagnostic } from "./apps/tui/src/bootstrap/native-diagnostics.ts";',
      "consumeNativeDiagnosticsEnvironment(process.env);",
      'process.stdout.write(String(writeNativeDiagnostic("Shutdown failed:\\nclose error")));'
    ].join("\n");
    const child = spawn("bun", ["-e", script], {
      env: { ...environment, AGENTLAB_DIAGNOSTIC_LOG: log.path },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      readStream(child.stdout),
      readStream(child.stderr),
      new Promise<number | null>((resolveExit) => child.once("exit", resolveExit))
    ]);
    log.write(stderr);
    log.close();

    expect(exitCode).toBe(0);
    expect(stdout).toBe("true");
    expect(stderr).toBe("[agentlab] Shutdown failed: close error\n");
    expect(readFileSync(log.path, "utf8")).toContain("[agentlab] Shutdown failed: close error");
  });

  it("rejects relative and symlinked renderer log paths", async () => {
    const state = await temporaryState();
    const target = join(state, "target.log");
    const link = join(state, "linked.log");
    await writeFile(target, "");
    await symlink(target, link);

    consumeNativeDiagnosticsEnvironment({ AGENTLAB_DIAGNOSTIC_LOG: "relative.log" });
    expect(writeNativeDiagnostic("relative")).toBe(false);
    consumeNativeDiagnosticsEnvironment({ AGENTLAB_DIAGNOSTIC_LOG: link });
    expect(writeNativeDiagnostic("symlink")).toBe(false);
    expect(readFileSync(target, "utf8")).toBe("");
  });

  it("consumes bootstrap-only environment and keeps renderer failures on the private pipe", async () => {
    const state = await temporaryState();
    const log = openNativeDiagnosticsLog({ ...process.env, XDG_STATE_HOME: state });
    const script = [
      'import { consumeNativeDiagnosticsEnvironment, writeNativeDiagnostic } from "./apps/tui/src/bootstrap/native-diagnostics.ts";',
      "consumeNativeDiagnosticsEnvironment(process.env);",
      'process.stdout.write(`${process.env.AGENTLAB_DIAGNOSTIC_LOG ?? "gone"}|${process.env.AGENTLAB_TUI_RUNTIME ?? "gone"}|${process.env.PRESERVED ?? "missing"}|${String(writeNativeDiagnostic("owned after scrub"))}`);'
    ].join("\n");
    const child = spawn("bun", ["-e", script], {
      env: {
        ...process.env,
        AGENTLAB_DIAGNOSTIC_LOG: log.path,
        AGENTLAB_TUI_RUNTIME: "runtime-token",
        PRESERVED: "yes"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      readStream(child.stdout),
      readStream(child.stderr),
      new Promise<number | null>((resolveExit) => child.once("exit", resolveExit))
    ]);
    log.write(stderr);
    log.close();

    expect(exitCode).toBe(0);
    expect(stdout).toBe("gone|gone|yes|true");
    expect(stderr).toBe("[agentlab] owned after scrub\n");
    expect(readFileSync(log.path, "utf8")).toContain("owned after scrub");
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
