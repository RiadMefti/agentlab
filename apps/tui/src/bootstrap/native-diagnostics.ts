import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  writeSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { exitCodeForSignal, rendererExitStatusSignals } from "./signal-exit.js";

const LOG_DIRECTORY_MODE = 0o700;
const LOG_FILE_MODE = 0o600;
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const RUNTIME_MARKER = "AGENTLAB_TUI_RUNTIME";
const RUNTIME_ARGUMENT_PREFIX = "--agentlab-tui-runtime=";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
let ownedDiagnosticPath: string | undefined;

export interface NativeDiagnosticsLog {
  readonly fd: number;
  readonly path: string;
  close(): void;
}

/** Resolves AgentLab's private, local-first diagnostic log without importing the TUI runtime. */
export function nativeDiagnosticsLogPath(
  environment: NodeJS.ProcessEnv = process.env,
  runId?: string
): string {
  const configured = environment.XDG_STATE_HOME;
  const configuredHome = environment.HOME;
  const stateRoot = isSafeAbsolutePath(configured)
    ? configured
    : resolve(isSafeAbsolutePath(configuredHome) ? configuredHome : homedir(), ".local", "state");
  return resolve(
    stateRoot,
    "agentlab",
    "logs",
    runId === undefined ? "tui.log" : `tui-${runId}.log`
  );
}

/**
 * Opens the file inherited as fd 2 by the renderer process. OpenTUI's native library writes
 * directly to that descriptor, so redirecting at spawn is the compatibility seam until a stable
 * release contains upstream fixes 189f1007 and a7fb4ec7.
 */
export function openNativeDiagnosticsLog(
  environment: NodeJS.ProcessEnv = process.env
): NativeDiagnosticsLog {
  const path = nativeDiagnosticsLogPath(environment, randomUUID());
  const directory = dirname(path);
  mkdirSync(directory, { mode: LOG_DIRECTORY_MODE, recursive: true });
  const directoryMetadata = lstatSync(directory);
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
    throw new Error(`Refusing unsafe AgentLab diagnostic directory: ${directory}`);
  }
  chmodSync(directory, LOG_DIRECTORY_MODE);
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const fd = openSync(
    path,
    constants.O_APPEND | constants.O_CREAT | constants.O_RDWR | noFollow,
    LOG_FILE_MODE
  );
  chmodSync(path, LOG_FILE_MODE);
  let closed = false;

  return {
    fd,
    path,
    close() {
      if (closed) return;
      closed = true;
      // The bootstrap closes this only after its renderer exits. Bounding here cannot race the
      // writer, and the per-run filename prevents another renderer from sharing the descriptor.
      boundActiveLog(fd);
      closeSync(fd);
    }
  };
}

export function nativeDiagnosticsRuntimeArguments(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env
): readonly string[] | null {
  const token = environment[RUNTIME_MARKER];
  if (
    token === undefined ||
    !UUID_PATTERN.test(token) ||
    args[0] !== `${RUNTIME_ARGUMENT_PREFIX}${token}`
  ) {
    return null;
  }
  return args.slice(1);
}

/** Retains renderer diagnostics privately while removing bootstrap-only values from descendants. */
export function consumeNativeDiagnosticsEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): void {
  const path = environment.AGENTLAB_DIAGNOSTIC_LOG;
  ownedDiagnosticPath = isSafeAbsolutePath(path) ? path : undefined;
  delete environment.AGENTLAB_TUI_RUNTIME;
  delete environment.AGENTLAB_DIAGNOSTIC_LOG;
}

/** Appends renderer-owned failures without ever touching the interactive terminal descriptor. */
export function writeNativeDiagnostic(message: string, environment?: NodeJS.ProcessEnv): boolean {
  const path = environment?.AGENTLAB_DIAGNOSTIC_LOG ?? ownedDiagnosticPath;
  if (!isSafeAbsolutePath(path)) return false;
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_APPEND | constants.O_WRONLY | noFollow);
    if (!fstatSync(fd).isFile()) return false;
    writeSync(fd, `[agentlab] ${message.replace(/[\r\n]+/gu, " ")}\n`);
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // Diagnostics must never become a second renderer failure.
      }
    }
  }
}

export async function runWithNativeDiagnostics(
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env
): Promise<number> {
  let log: NativeDiagnosticsLog | null = null;
  try {
    log = openNativeDiagnosticsLog(environment);
  } catch {
    // Diagnostics must fail open: an unsafe or unavailable XDG path cannot block the renderer.
  }
  const runtimeToken = randomUUID();
  const command = rendererCommand([`${RUNTIME_ARGUMENT_PREFIX}${runtimeToken}`, ...args]);
  const executable = command[0];
  if (executable === undefined) throw new Error("AgentLab renderer command is empty.");
  const rendererEnvironment = { ...environment };
  delete rendererEnvironment.AGENTLAB_TUI_RUNTIME;
  delete rendererEnvironment.AGENTLAB_DIAGNOSTIC_LOG;
  rendererEnvironment[RUNTIME_MARKER] = runtimeToken;
  if (log !== null) rendererEnvironment.AGENTLAB_DIAGNOSTIC_LOG = log.path;
  const child = spawn(executable, command.slice(1), {
    env: rendererEnvironment,
    stdio: ["inherit", "inherit", log?.fd ?? "ignore"]
  });
  const listeners = rendererExitStatusSignals.map((signal) => {
    const listener = (): void => {
      try {
        child.kill(signal);
      } catch {
        // The renderer may have already handled the same process-group signal.
      }
    };
    process.on(signal, listener);
    return { listener, signal };
  });

  try {
    const exitCode = await new Promise<number>((resolvePromise, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (code !== null) resolvePromise(code);
        else resolvePromise(signal === null ? 1 : exitCodeForSignal(signal));
      });
    });
    if (exitCode !== 0) {
      const diagnostics = log === null ? "" : `; diagnostics: ${log.path}`;
      process.stderr.write(`agentlab: terminal UI exited unexpectedly${diagnostics}\n`);
    }
    return exitCode;
  } finally {
    for (const { listener, signal } of listeners) process.off(signal, listener);
    log?.close();
  }
}

function rendererCommand(args: readonly string[]): string[] {
  const entry = process.argv[1];
  const compiled = fileURLToPath(import.meta.url).includes("/$bunfs/");
  if (!compiled && entry !== undefined && resolve(entry) !== resolve(process.execPath)) {
    return [process.execPath, entry, ...args];
  }
  return [process.execPath, ...args];
}

function boundActiveLog(fd: number): void {
  try {
    const size = fstatSync(fd).size;
    if (size <= MAX_LOG_BYTES) return;
    const marker = Buffer.from(
      `[AgentLab retained the newest diagnostics after ${String(MAX_LOG_BYTES)} bytes]\n`
    );
    const tail = Buffer.allocUnsafe(MAX_LOG_BYTES - marker.byteLength);
    let bytesRead = 0;
    while (bytesRead < tail.byteLength) {
      const count = readSync(
        fd,
        tail,
        bytesRead,
        tail.byteLength - bytesRead,
        size - tail.byteLength + bytesRead
      );
      if (count === 0) break;
      bytesRead += count;
    }
    ftruncateSync(fd, 0);
    writeSync(fd, marker);
    writeSync(fd, tail.subarray(0, bytesRead));
  } catch {
    // Runtime diagnostics must never compete with or crash the interactive renderer.
  }
}

function isSafeAbsolutePath(value: string | undefined): value is string {
  return value !== undefined && isAbsolute(value) && !hasControlCharacter(value);
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}
