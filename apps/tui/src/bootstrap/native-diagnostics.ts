import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { exitCodeForSignal, rendererExitStatusSignals } from "./signal-exit.js";

const LOG_DIRECTORY_MODE = 0o700;
const LOG_FILE_MODE = 0o600;
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const MAX_RETAINED_LOG_BYTES = 8 * 1024 * 1024;
const MAX_RETAINED_LOG_FILES = 8;
const RUNTIME_MARKER = "AGENTLAB_TUI_RUNTIME";
const RUNTIME_ARGUMENT_PREFIX = "--agentlab-tui-runtime=";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const PROCESS_IDENTITY_PATTERN = /^[0-9a-f]{16}$/u;
const ACTIVE_LOG_PATTERN = new RegExp(
  `^tui-([1-9][0-9]*)-(${PROCESS_IDENTITY_PATTERN.source.slice(1, -1)})-(${UUID_PATTERN.source.slice(1, -1)})\\.active$`,
  "u"
);
const RETAINED_LOG_PATTERN = new RegExp(`^tui-(${UUID_PATTERN.source.slice(1, -1)})\\.log$`, "u");
const RETENTION_MARKER = Buffer.from(
  `[AgentLab retained the newest diagnostics after ${String(MAX_LOG_BYTES)} bytes]\n`
);
let rendererOwnsDiagnosticStderr = false;
let rendererDiagnosticStderrIdentity: DescriptorIdentity | undefined;

export const nativeDiagnosticsRetention = Object.freeze({
  maxBytes: MAX_RETAINED_LOG_BYTES,
  maxFileBytes: MAX_LOG_BYTES,
  maxFiles: MAX_RETAINED_LOG_FILES
});

export interface NativeDiagnosticsLog {
  readonly path: string;
  close(): void;
  write(data: string | Uint8Array): void;
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
 * Opens the bootstrap-owned sink for a renderer's drained stderr pipe. Native OpenTUI code writes
 * only to the pipe, so this object is the retained file's sole writer and can bound it live without
 * truncating underneath native code.
 */
export function openNativeDiagnosticsLog(
  environment: NodeJS.ProcessEnv = process.env
): NativeDiagnosticsLog {
  const runId = randomUUID();
  const retainedPath = nativeDiagnosticsLogPath(environment, runId);
  const directory = dirname(retainedPath);
  mkdirSync(directory, { mode: LOG_DIRECTORY_MODE, recursive: true });
  const directoryMetadata = lstatSync(directory);
  if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink()) {
    throw new Error(`Refusing unsafe AgentLab diagnostic directory: ${directory}`);
  }
  chmodSync(directory, LOG_DIRECTORY_MODE);
  retainNativeDiagnostics(directory);
  const identity = currentProcessIdentity();
  if (identity === null) throw new Error("Cannot establish diagnostic writer identity.");
  const activePath = resolve(directory, `tui-${String(process.pid)}-${identity}-${runId}.active`);
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const fd = openSync(
    activePath,
    constants.O_APPEND | constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | noFollow,
    LOG_FILE_MODE
  );
  chmodSync(activePath, LOG_FILE_MODE);
  let closed = false;
  let publishedPath = activePath;

  return {
    get path() {
      return publishedPath;
    },
    write(data) {
      if (closed) return;
      try {
        appendBounded(fd, typeof data === "string" ? Buffer.from(data) : Buffer.from(data));
      } catch {
        // Diagnostics must never become a renderer failure.
      }
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        closeSync(fd);
      } catch {
        // An externally closed sink must not replace the renderer's real exit status.
      }
      try {
        renameSync(activePath, retainedPath);
        publishedPath = retainedPath;
      } catch {
        // The active name remains recoverable by a later retention pass.
      }
      retainNativeDiagnostics(directory, publishedPath);
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

/** Retains the private stderr pipe while removing bootstrap-only values from descendants. */
export function consumeNativeDiagnosticsEnvironment(
  environment: NodeJS.ProcessEnv = process.env
): void {
  rendererOwnsDiagnosticStderr = isOwnedDiagnosticPath(environment.AGENTLAB_DIAGNOSTIC_LOG);
  rendererDiagnosticStderrIdentity = rendererOwnsDiagnosticStderr
    ? descriptorIdentity(2)
    : undefined;
  rendererOwnsDiagnosticStderr &&= rendererDiagnosticStderrIdentity !== undefined;
  delete environment.AGENTLAB_TUI_RUNTIME;
  delete environment.AGENTLAB_DIAGNOSTIC_LOG;
}

/** Appends renderer-owned failures without ever touching the interactive terminal descriptor. */
export function writeNativeDiagnostic(message: string): boolean {
  const line = `[agentlab] ${message.replace(/[\r\n]+/gu, " ")}\n`;
  const ownsDiagnosticStderr =
    rendererOwnsDiagnosticStderr &&
    rendererDiagnosticStderrIdentity !== undefined &&
    descriptorMatches(2, rendererDiagnosticStderrIdentity);
  if (!ownsDiagnosticStderr) return false;
  try {
    writeAll(2, Buffer.from(line));
    return true;
  } catch {
    return false;
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
    stdio: ["inherit", "inherit", log === null ? "ignore" : "pipe"]
  });
  const drain = drainNativeDiagnostics(child.stderr, log);
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
    await drain;
    log?.close();
    if (exitCode !== 0) {
      const diagnostics = log === null ? "" : `; diagnostics: ${log.path}`;
      process.stderr.write(`agentlab: terminal UI exited unexpectedly${diagnostics}\n`);
    }
    return exitCode;
  } finally {
    for (const { listener, signal } of listeners) process.off(signal, listener);
    await drain;
    log?.close();
  }
}

async function drainNativeDiagnostics(
  stream: NodeJS.ReadableStream | null,
  log: NativeDiagnosticsLog | null
): Promise<void> {
  if (stream === null || log === null) return;
  try {
    for await (const chunk of stream) log.write(Buffer.from(chunk));
  } catch {
    // A renderer may close or destroy stderr; diagnostics remain fail-open.
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

function appendBounded(fd: number, data: Buffer): void {
  if (data.byteLength === 0) return;
  const size = fstatSync(fd).size;
  if (size + data.byteLength <= MAX_LOG_BYTES) {
    writeAll(fd, data);
    return;
  }

  const tailBytes = MAX_LOG_BYTES - RETENTION_MARKER.byteLength;
  const retainedFromData = Math.min(data.byteLength, tailBytes);
  const retainedFromFile = Math.min(size, tailBytes - retainedFromData);
  const tail = Buffer.allocUnsafe(retainedFromFile + retainedFromData);
  if (retainedFromFile > 0) {
    readAll(fd, tail, 0, retainedFromFile, size - retainedFromFile);
  }
  data.copy(tail, retainedFromFile, data.byteLength - retainedFromData);
  ftruncateSync(fd, 0);
  writeAll(fd, RETENTION_MARKER);
  writeAll(fd, tail);
}

interface RetainedLogCandidate {
  readonly active: boolean;
  readonly modifiedAt: number;
  readonly path: string;
  readonly size: number;
}

function retainNativeDiagnostics(directory: string, preservedPath?: string): void {
  try {
    finalizeAbandonedLogs(directory);
    const candidates: RetainedLogCandidate[] = [];
    for (const name of readdirSync(directory)) {
      const active = ACTIVE_LOG_PATTERN.test(name);
      if (!active && !RETAINED_LOG_PATTERN.test(name)) continue;
      const path = resolve(directory, name);
      try {
        const metadata = lstatSync(path);
        if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
        candidates.push({ active, modifiedAt: metadata.mtimeMs, path, size: metadata.size });
      } catch {
        // A concurrent process may have finalized or removed the entry.
      }
    }

    const activeCandidates = candidates.filter(({ active }) => active);
    const retainedCandidates = candidates
      .filter(({ active }) => !active)
      .sort((left, right) => {
        if (left.path === preservedPath) return -1;
        if (right.path === preservedPath) return 1;
        return right.modifiedAt - left.modifiedAt || right.path.localeCompare(left.path);
      });
    let retainedBytes = activeCandidates.reduce((total, candidate) => total + candidate.size, 0);
    let retainedFiles = activeCandidates.length;

    for (const candidate of retainedCandidates) {
      const preserve = candidate.path === preservedPath;
      if (
        preserve ||
        (retainedFiles < MAX_RETAINED_LOG_FILES &&
          retainedBytes + candidate.size <= MAX_RETAINED_LOG_BYTES)
      ) {
        retainedBytes += candidate.size;
        retainedFiles += 1;
        continue;
      }
      try {
        unlinkSync(candidate.path);
      } catch {
        // Retention is advisory and races safely with other bootstrap processes.
      }
    }
  } catch {
    // Cleanup is diagnostics-only and must never become a TUI launch requirement.
  }
}

function finalizeAbandonedLogs(directory: string): void {
  for (const name of readdirSync(directory)) {
    const match = ACTIVE_LOG_PATTERN.exec(name);
    if (match === null) continue;
    const pid = Number(match[1]);
    const expectedIdentity = match[2];
    const runId = match[3];
    if (
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      expectedIdentity === undefined ||
      runId === undefined ||
      activeOwnerMayBeAlive(pid, expectedIdentity)
    ) {
      continue;
    }
    const activePath = resolve(directory, name);
    const retainedPath = resolve(directory, `tui-${runId}.log`);
    try {
      const metadata = lstatSync(activePath);
      if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
      boundAbandonedLog(activePath);
      renameSync(activePath, retainedPath);
    } catch {
      // The owner or another cleanup pass may have moved the file concurrently.
    }
  }
}

function boundAbandonedLog(path: string): void {
  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  let fd: number | null = null;
  try {
    fd = openSync(path, constants.O_RDWR | noFollow);
    if (!fstatSync(fd).isFile()) return;
    const size = fstatSync(fd).size;
    if (size <= MAX_LOG_BYTES) return;
    const tail = Buffer.allocUnsafe(MAX_LOG_BYTES - RETENTION_MARKER.byteLength);
    readAll(fd, tail, 0, tail.byteLength, size - tail.byteLength);
    ftruncateSync(fd, 0);
    writeAll(fd, RETENTION_MARKER);
    writeAll(fd, tail);
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

type ProcessIdentity =
  | { readonly kind: "absent" }
  | { readonly identity: string; readonly kind: "identified" }
  | { readonly kind: "unknown" };

function activeOwnerMayBeAlive(pid: number, expectedIdentity: string): boolean {
  const state = processIdentity(pid);
  return (
    state.kind === "unknown" || (state.kind === "identified" && state.identity === expectedIdentity)
  );
}

function currentProcessIdentity(): string | null {
  const state = processIdentity(process.pid);
  return state.kind === "identified" ? state.identity : null;
}

function processIdentity(pid: number): ProcessIdentity {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ESRCH"
    ) {
      return { kind: "absent" };
    }
    return { kind: "unknown" };
  }

  const source = processIdentitySource(pid);
  return source === null
    ? { kind: "unknown" }
    : {
        identity: createHash("sha256").update(source).digest("hex").slice(0, 16),
        kind: "identified"
      };
}

function processIdentitySource(pid: number): string | null {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
      const commandEnd = stat.lastIndexOf(") ");
      if (commandEnd < 0) return null;
      const fieldsAfterCommand = stat
        .slice(commandEnd + 2)
        .trim()
        .split(/\s+/u);
      const startTicks = fieldsAfterCommand[19];
      return startTicks !== undefined && /^[0-9]+$/u.test(startTicks) ? startTicks : null;
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    const result = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], {
      encoding: "utf8",
      env: { ...process.env, LC_ALL: "C" },
      stdio: ["ignore", "pipe", "ignore"]
    });
    const startedAt = result.status === 0 ? result.stdout.trim() : "";
    return startedAt.length > 0 ? startedAt : null;
  }
  return null;
}

function readAll(
  fd: number,
  buffer: Buffer,
  offset: number,
  length: number,
  position: number
): void {
  let bytesRead = 0;
  while (bytesRead < length) {
    const count = readSync(
      fd,
      buffer,
      offset + bytesRead,
      length - bytesRead,
      position + bytesRead
    );
    if (count === 0) break;
    bytesRead += count;
  }
}

function writeAll(fd: number, buffer: Buffer): void {
  let offset = 0;
  while (offset < buffer.byteLength) {
    offset += writeSync(fd, buffer, offset, buffer.byteLength - offset);
  }
}

function isSafeAbsolutePath(value: string | undefined): value is string {
  return value !== undefined && isAbsolute(value) && !hasControlCharacter(value);
}

function isOwnedDiagnosticPath(value: string | undefined): boolean {
  if (!isSafeAbsolutePath(value)) return false;
  try {
    const metadata = lstatSync(value);
    return metadata.isFile() && !metadata.isSymbolicLink();
  } catch {
    return false;
  }
}

interface DescriptorIdentity {
  readonly device: number;
  readonly inode: number;
  readonly mode: number;
  readonly rawDevice: number;
}

function descriptorIdentity(fd: number): DescriptorIdentity | undefined {
  try {
    const metadata = fstatSync(fd);
    return {
      device: metadata.dev,
      inode: metadata.ino,
      mode: metadata.mode,
      rawDevice: metadata.rdev
    };
  } catch {
    return undefined;
  }
}

function descriptorMatches(fd: number, expected: DescriptorIdentity): boolean {
  const current = descriptorIdentity(fd);
  return (
    current?.device === expected.device &&
    current.inode === expected.inode &&
    current.mode === expected.mode &&
    current.rawDevice === expected.rawDevice
  );
}

function hasControlCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
}
