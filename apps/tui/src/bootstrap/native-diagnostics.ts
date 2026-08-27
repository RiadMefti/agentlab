import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  closePrivateDiagnosticDescriptor,
  isSafeAbsolutePath,
  openPrivateDiagnosticArtifact,
  privateDiagnosticArtifactMatches,
  preparePrivateDiagnosticDirectory
} from "./private-diagnostic-files.js";
import { exitCodeForSignal, rendererExitStatusSignals } from "./signal-exit.js";

const LOG_DIRECTORY_MODE = 0o700;
const LOG_FILE_MODE = 0o600;
const MAX_LOG_BYTES = 2 * 1024 * 1024;
const MAX_RETAINED_LOG_BYTES = 8 * 1024 * 1024;
const MAX_RETAINED_LOG_FILES = 8;
const RUNTIME_MARKER = "AGENTLAB_TUI_RUNTIME";
const DIAGNOSTIC_CAPABILITY_MARKER = "AGENTLAB_TUI_DIAGNOSTIC_CAPABILITY";
const LEGACY_DIAGNOSTIC_PATH_MARKER = "AGENTLAB_DIAGNOSTIC_LOG";
const RUNTIME_ARGUMENT_PREFIX = "--agentlab-tui-runtime=";
const DIAGNOSTIC_CAPABILITY_ARGUMENT_PREFIX = "--agentlab-tui-diagnostic-capability=";
const DIAGNOSTIC_CAPABILITY_DESCRIPTOR = 3;
const DIAGNOSTIC_CAPABILITY_BYTES = 32;
const DIAGNOSTIC_CAPABILITY_TIMEOUT_MS = 100;
const DIAGNOSTIC_CAPABILITY_MESSAGE = "agentlab-native-diagnostics";
const DIAGNOSTIC_CAPABILITY_READY_MESSAGE = "agentlab-native-diagnostics-ready";
const DIAGNOSTIC_CAPABILITY_READY_TIMEOUT_MS = 1_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIAGNOSTIC_CAPABILITY_PATTERN = /^[0-9a-f]{64}$/u;
const PROCESS_IDENTITY_PATTERN = /^[0-9a-f]{16}$/u;
const ACTIVE_LOG_PATTERN = new RegExp(
  `^tui-([1-9][0-9]*)-(${PROCESS_IDENTITY_PATTERN.source.slice(1, -1)})-(${UUID_PATTERN.source.slice(1, -1)})\\.active$`,
  "u"
);
const RETAINED_LOG_PATTERN = new RegExp(`^tui-(${UUID_PATTERN.source.slice(1, -1)})\\.log$`, "u");
const RETENTION_MARKER = Buffer.from(
  `[AgentLab retained the newest diagnostics after ${String(MAX_LOG_BYTES)} bytes]\n`
);

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

export interface NativeDiagnosticWriter {
  write(message: string): boolean;
}

export interface NativeDiagnosticsRuntime {
  readonly arguments: readonly string[];
  readonly diagnostics: NativeDiagnosticWriter;
  readonly kind: "runtime";
}

export type NativeDiagnosticsInvocation =
  | { readonly arguments: readonly string[]; readonly kind: "direct" }
  | { readonly arguments: readonly string[]; readonly kind: "invalid" }
  | NativeDiagnosticsRuntime;

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
  const preparedDirectory = preparePrivateDiagnosticDirectory(directory, LOG_DIRECTORY_MODE);
  let activePath: string;
  let artifact: ReturnType<typeof openPrivateDiagnosticArtifact>;
  try {
    retainNativeDiagnostics(directory);
    const identity = currentProcessIdentity();
    if (identity === null) throw new Error("Cannot establish diagnostic writer identity.");
    activePath = resolve(directory, `tui-${String(process.pid)}-${identity}-${runId}.active`);
    artifact = openPrivateDiagnosticArtifact(
      activePath,
      directory,
      preparedDirectory.identity,
      LOG_FILE_MODE
    );
  } finally {
    closePrivateDiagnosticDescriptor(preparedDirectory.fd);
  }
  const { fd, identity: artifactIdentity } = artifact;
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
      if (!closeNativeDiagnosticsLogDescriptor(fd)) return;
      if (!privateDiagnosticArtifactMatches(activePath, artifactIdentity)) return;
      try {
        // Node/Bun lack renameat-by-descriptor. This check prevents known replacements from moving,
        // while a same-user swap between this lstat and rename remains an unavoidable TOCTOU.
        renameSync(activePath, retainedPath);
        publishedPath = retainedPath;
      } catch {
        // The active name remains recoverable by a later retention pass.
      }
      retainNativeDiagnostics(directory, publishedPath);
    }
  };
}

/** Consumes and validates the bootstrap's private renderer handoff in one operation. */
export async function consumeNativeDiagnosticsInvocation(
  processArguments: string[] = process.argv,
  environment: NodeJS.ProcessEnv = process.env
): Promise<NativeDiagnosticsInvocation> {
  const rawArguments = processArguments.slice(2);
  const runtimeArgument = rawArguments[0];
  const capabilityArgument = rawArguments[1];
  const runtimeToken = environment[RUNTIME_MARKER];
  const environmentCapability = environment[DIAGNOSTIC_CAPABILITY_MARKER];
  const argumentCapability = capabilityArgument?.startsWith(DIAGNOSTIC_CAPABILITY_ARGUMENT_PREFIX)
    ? capabilityArgument.slice(DIAGNOSTIC_CAPABILITY_ARGUMENT_PREFIX.length)
    : undefined;
  const hasPrivateMarker =
    runtimeToken !== undefined ||
    environmentCapability !== undefined ||
    environment[LEGACY_DIAGNOSTIC_PATH_MARKER] !== undefined ||
    rawArguments.some(isPrivateRuntimeArgument);

  scrubPrivateDiagnosticsMarkers(processArguments, environment);

  if (!hasPrivateMarker) return { arguments: rawArguments, kind: "direct" };
  if (
    runtimeToken === undefined ||
    !UUID_PATTERN.test(runtimeToken) ||
    runtimeArgument !== `${RUNTIME_ARGUMENT_PREFIX}${runtimeToken}`
  ) {
    await closeInheritedDiagnosticCapability();
    return { arguments: userRuntimeArguments(rawArguments), kind: "invalid" };
  }

  const capabilityMissing = environmentCapability === undefined && argumentCapability === undefined;
  // Equality across caller-controlled argv/env binds the two invocation representations only.
  // Diagnostics authorization additionally requires the inherited secret and its descriptor class.
  const diagnosticsAuthorization =
    environmentCapability !== undefined &&
    DIAGNOSTIC_CAPABILITY_PATTERN.test(environmentCapability) &&
    argumentCapability === environmentCapability
      ? consumeNativeDiagnosticsAuthorization(runtimeToken, environmentCapability)
      : undefined;
  const resolvedAuthorization = await diagnosticsAuthorization;
  if (!capabilityMissing && resolvedAuthorization === undefined) {
    await closeInheritedDiagnosticCapability();
    return { arguments: userRuntimeArguments(rawArguments), kind: "invalid" };
  }
  if (capabilityMissing) await closeInheritedDiagnosticCapability();

  return {
    arguments: userRuntimeArguments(rawArguments),
    diagnostics: createNativeDiagnosticWriter(resolvedAuthorization),
    kind: "runtime"
  };
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
  const diagnosticCapability =
    log === null ? null : randomBytes(DIAGNOSTIC_CAPABILITY_BYTES).toString("hex");
  const diagnosticCapabilityProof =
    diagnosticCapability === null
      ? null
      : nativeDiagnosticCapabilityProof(runtimeToken, diagnosticCapability);
  const privateArguments = [
    `${RUNTIME_ARGUMENT_PREFIX}${runtimeToken}`,
    ...(diagnosticCapabilityProof === null
      ? []
      : [`${DIAGNOSTIC_CAPABILITY_ARGUMENT_PREFIX}${diagnosticCapabilityProof}`])
  ];
  const command = rendererCommand([...privateArguments, ...args]);
  const executable = command[0];
  if (executable === undefined) throw new Error("AgentLab renderer command is empty.");
  const rendererEnvironment = { ...environment };
  scrubPrivateDiagnosticsEnvironment(rendererEnvironment);
  rendererEnvironment[RUNTIME_MARKER] = runtimeToken;
  if (diagnosticCapabilityProof !== null) {
    rendererEnvironment[DIAGNOSTIC_CAPABILITY_MARKER] = diagnosticCapabilityProof;
  }
  const child = spawn(executable, command.slice(1), {
    env: rendererEnvironment,
    stdio: [
      "inherit",
      "inherit",
      log === null ? "ignore" : "pipe",
      ...(diagnosticCapability === null ? [] : (["ipc"] as const))
    ]
  });
  if (diagnosticCapability !== null) {
    sendInheritedDiagnosticCapability(child, diagnosticCapability);
  }
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

function closeNativeDiagnosticsLogDescriptor(fd: number): boolean {
  try {
    closeSync(fd);
    return true;
  } catch {
    // An externally closed or unclosable sink must leave its active pathname recoverable.
    return false;
  }
}

interface NativeDiagnosticsAuthorization {
  readonly descriptorClass: AnonymousPipeDescriptorClass;
}

function createNativeDiagnosticWriter(
  authorization: NativeDiagnosticsAuthorization | undefined
): NativeDiagnosticWriter {
  const identity = authorization === undefined ? undefined : descriptorIdentity(2);
  const expected =
    identity?.descriptorClass === authorization?.descriptorClass ? identity : undefined;
  return Object.freeze({
    write(message: string): boolean {
      if (expected === undefined || !descriptorMatches(2, expected)) return false;
      const line = `[agentlab] ${message.replace(/[\r\n]+/gu, " ")}\n`;
      try {
        writeAll(2, Buffer.from(line));
        return true;
      } catch {
        return false;
      }
    }
  });
}

interface InheritedDiagnosticCapability {
  readonly descriptorClass: AnonymousPipeDescriptorClass;
  readonly value: string;
}

async function consumeInheritedDiagnosticCapability(): Promise<
  InheritedDiagnosticCapability | undefined
> {
  let descriptorClass: AnonymousPipeDescriptorClass | undefined;
  try {
    const metadata = fstatSync(DIAGNOSTIC_CAPABILITY_DESCRIPTOR);
    descriptorClass = anonymousPipeDescriptorClass(metadata);
    if (descriptorClass === undefined) return undefined;
    if (!process.connected) return undefined;
    const capability = await receiveInheritedDiagnosticCapability();
    return capability === undefined ? undefined : { descriptorClass, value: capability };
  } catch {
    return undefined;
  } finally {
    await closeInheritedDiagnosticCapability();
  }
}

async function consumeNativeDiagnosticsAuthorization(
  runtimeToken: string,
  expectedProof: string
): Promise<NativeDiagnosticsAuthorization | undefined> {
  const inherited = await consumeInheritedDiagnosticCapability();
  return inherited !== undefined &&
    nativeDiagnosticCapabilityProof(runtimeToken, inherited.value) === expectedProof
    ? { descriptorClass: inherited.descriptorClass }
    : undefined;
}

function receiveInheritedDiagnosticCapability(): Promise<string | undefined> {
  return new Promise((resolveCapability) => {
    let settled = false;
    const finish = (capability?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      process.off("message", onMessage);
      resolveCapability(capability);
    };
    const onMessage = (message: unknown): void => {
      if (
        typeof message !== "object" ||
        message === null ||
        !("type" in message) ||
        message.type !== DIAGNOSTIC_CAPABILITY_MESSAGE ||
        !("capability" in message) ||
        typeof message.capability !== "string" ||
        !DIAGNOSTIC_CAPABILITY_PATTERN.test(message.capability)
      ) {
        finish();
        return;
      }
      finish(message.capability);
    };
    const timeout = setTimeout(() => {
      finish();
    }, DIAGNOSTIC_CAPABILITY_TIMEOUT_MS);
    process.once("message", onMessage);
    try {
      if (typeof process.send !== "function") {
        finish();
        return;
      }
      process.send({ type: DIAGNOSTIC_CAPABILITY_READY_MESSAGE }, (error: Error | null) => {
        if (error !== null) finish();
      });
    } catch {
      finish();
    }
  });
}

async function closeInheritedDiagnosticCapability(): Promise<void> {
  if (process.connected) {
    await new Promise<void>((resolveClose) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        process.off("disconnect", finish);
        resolveClose();
      };
      const timeout = setTimeout(finish, DIAGNOSTIC_CAPABILITY_TIMEOUT_MS);
      process.once("disconnect", finish);
      try {
        process.disconnect();
      } catch {
        finish();
      }
    });
  }
  closePrivateDiagnosticDescriptor(DIAGNOSTIC_CAPABILITY_DESCRIPTOR);
}

function nativeDiagnosticCapabilityProof(runtimeToken: string, capability: string): string {
  return createHash("sha256").update(runtimeToken).update("\0").update(capability).digest("hex");
}

function sendInheritedDiagnosticCapability(
  child: ReturnType<typeof spawn>,
  capability: string
): void {
  let timeout: NodeJS.Timeout;
  const disconnect = (): void => {
    try {
      if (child.connected) child.disconnect();
    } catch {
      // A renderer may exit before the bootstrap finishes closing its private handoff.
    }
  };
  const finish = (): void => {
    clearTimeout(timeout);
    child.off("disconnect", finish);
    child.off("exit", finish);
    child.off("message", onMessage);
  };
  const onMessage = (message: unknown): void => {
    if (
      typeof message !== "object" ||
      message === null ||
      !("type" in message) ||
      message.type !== DIAGNOSTIC_CAPABILITY_READY_MESSAGE
    ) {
      return;
    }
    child.off("message", onMessage);
    clearTimeout(timeout);
    timeout = setTimeout(disconnect, DIAGNOSTIC_CAPABILITY_TIMEOUT_MS * 2);
    try {
      child.send(
        { capability, type: DIAGNOSTIC_CAPABILITY_MESSAGE },
        (error: Error | null): void => {
          if (error !== null) disconnect();
        }
      );
    } catch {
      disconnect();
    }
  };
  child.on("message", onMessage);
  child.once("disconnect", finish);
  child.once("exit", finish);
  timeout = setTimeout(disconnect, DIAGNOSTIC_CAPABILITY_READY_TIMEOUT_MS);
}

function isPrivateRuntimeArgument(argument: string): boolean {
  return (
    argument.startsWith(RUNTIME_ARGUMENT_PREFIX) ||
    argument.startsWith(DIAGNOSTIC_CAPABILITY_ARGUMENT_PREFIX)
  );
}

function userRuntimeArguments(arguments_: readonly string[]): readonly string[] {
  return arguments_.filter((argument) => !isPrivateRuntimeArgument(argument));
}

function scrubPrivateDiagnosticsMarkers(
  processArguments: string[],
  environment: NodeJS.ProcessEnv
): void {
  for (let index = processArguments.length - 1; index >= 2; index -= 1) {
    const argument = processArguments[index];
    if (argument !== undefined && isPrivateRuntimeArgument(argument)) {
      processArguments.splice(index, 1);
    }
  }
  scrubPrivateDiagnosticsEnvironment(environment);
}

function scrubPrivateDiagnosticsEnvironment(environment: NodeJS.ProcessEnv): void {
  delete environment.AGENTLAB_TUI_RUNTIME;
  delete environment.AGENTLAB_TUI_DIAGNOSTIC_CAPABILITY;
  delete environment.AGENTLAB_DIAGNOSTIC_LOG;
}

type AnonymousPipeDescriptorClass = "fifo" | "socket";

interface DescriptorIdentity {
  readonly descriptorClass: AnonymousPipeDescriptorClass;
  readonly device: number;
  readonly inode: number;
  readonly mode: number;
  readonly rawDevice: number;
}

function descriptorIdentity(fd: number): DescriptorIdentity | undefined {
  try {
    const metadata = fstatSync(fd);
    const descriptorClass = anonymousPipeDescriptorClass(metadata);
    if (descriptorClass === undefined) return undefined;
    return {
      descriptorClass,
      device: metadata.dev,
      inode: metadata.ino,
      mode: metadata.mode,
      rawDevice: metadata.rdev
    };
  } catch {
    return undefined;
  }
}

function anonymousPipeDescriptorClass(metadata: {
  isFIFO(): boolean;
  isSocket(): boolean;
}): AnonymousPipeDescriptorClass | undefined {
  if (metadata.isSocket() && !metadata.isFIFO()) return "socket";
  if (metadata.isFIFO() && !metadata.isSocket()) return "fifo";
  return undefined;
}

function descriptorMatches(fd: number, expected: DescriptorIdentity): boolean {
  const current = descriptorIdentity(fd);
  return (
    current?.device === expected.device &&
    current.inode === expected.inode &&
    current.descriptorClass === expected.descriptorClass &&
    current.mode === expected.mode &&
    current.rawDevice === expected.rawDevice
  );
}
