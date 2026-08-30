import type {
  Disposable,
  ManagedPseudoTerminal,
  ManagedPseudoTerminalFactory,
  ManagedTerminalResource,
  ManagedTerminalResourceOwner,
  TerminalDimensions
} from "../../domain/terminal.js";
import type { SessionAttachmentTarget } from "../../domain/session-runtime.js";
import { guardedTmuxArguments } from "../tmux/owned-session-guard.js";

const MAX_PENDING_OUTPUT_BYTES = 1024 * 1024;
const PTY_GRACEFUL_EXIT_MS = 500;
const PTY_FORCED_EXIT_MS = 2_000;

export interface PendingTerminalOutput {
  readonly chunks: readonly string[];
  readonly bytes: number;
  readonly overrun: boolean;
  readonly overrunBytes: number;
}

const EMPTY_PENDING_OUTPUT: PendingTerminalOutput = {
  chunks: [],
  bytes: 0,
  overrun: false,
  overrunBytes: 0
};
const PRIVATE_TUI_ENVIRONMENT_KEYS = new Set([
  "AGENTLAB_DIAGNOSTIC_LOG",
  "AGENTLAB_TUI_DIAGNOSTIC_CAPABILITY",
  "AGENTLAB_TUI_RUNTIME"
]);

/** Attaches Bun's native PTY to an exact managed tmux session. */
export class BunTerminalFactory implements ManagedPseudoTerminalFactory {
  public constructor(
    private readonly socketPath?: string,
    private readonly spawnTerminal?: typeof Bun.spawn
  ) {}

  public attach(
    target: SessionAttachmentTarget,
    cwd: string,
    dimensions: TerminalDimensions,
    owner: ManagedTerminalResourceOwner
  ): ManagedPseudoTerminal {
    const tmuxArgs = guardedTmuxArguments(target, ["attach-session", "-t", target.runtimeId]);
    return new BunPseudoTerminal(
      this.socketPath === undefined ? tmuxArgs : ["-S", this.socketPath, ...tmuxArgs],
      cwd,
      dimensions,
      owner,
      this.spawnTerminal ?? Bun.spawn
    );
  }
}

class BunPseudoTerminal implements ManagedPseudoTerminal {
  readonly #dataListeners = new Set<(data: string) => void>();
  readonly #exitListeners = new Set<(event: { exitCode: number }) => void>();
  readonly #decoder = new TextDecoder();
  readonly #terminal: Bun.Terminal;
  readonly #lifecycle: ConfirmedBunProcess;
  readonly #owner: ManagedTerminalResourceOwner;
  #pendingOutput = EMPTY_PENDING_OUTPUT;
  #pendingOverrunBytes: number | null = null;
  #observedExitCode: number | null = null;
  #exitCode: number | null = null;
  #decoderFlushed = false;
  #closed = false;

  public constructor(
    args: readonly string[],
    cwd: string,
    dimensions: TerminalDimensions,
    owner: ManagedTerminalResourceOwner,
    spawnTerminal: typeof Bun.spawn
  ) {
    const subprocess = spawnTerminal(["tmux", ...args], {
      cwd,
      env: stringEnvironment({
        ...process.env,
        TERM: "xterm-256color",
        COLORTERM: "truecolor"
      }),
      terminal: {
        cols: dimensions.columns,
        rows: dimensions.rows,
        name: "xterm-256color",
        data: (_terminal, data) => {
          this.emitData(this.#decoder.decode(data, { stream: true }));
        }
      }
    });
    const lifecycle = new ConfirmedBunProcess(subprocess, () => {
      const terminal = subprocess.terminal;
      if (terminal !== undefined && !terminal.closed) terminal.close();
    });
    // Bun may spawn successfully and still fail to provide the requested PTY. Register the raw
    // child before checking that fallible postcondition so runtime shutdown can retry confirmation.
    owner.track(lifecycle);
    if (subprocess.terminal === undefined) {
      lifecycle.kill();
      throw new Error("Bun did not create a terminal for the tmux attachment.");
    }
    this.#terminal = subprocess.terminal;
    this.#lifecycle = lifecycle;
    this.#owner = owner;
    owner.track(this);
    owner.release(lifecycle);
    lifecycle.onExit(({ exitCode }) => {
      this.observeExit(exitCode);
    });
  }

  public write(data: Uint8Array): void {
    if (!this.#closed) this.#terminal.write(data);
  }

  public resize(columns: number, rows: number): void {
    if (!this.#closed) this.#terminal.resize(columns, rows);
  }

  public kill(): void {
    void this.killAndWait().catch(() => undefined);
  }

  public closeAndWait(): Promise<void> {
    return this.killAndWait();
  }

  public async killAndWait(): Promise<void> {
    if (this.#closed) return;
    if (this.#observedExitCode === null) await this.#lifecycle.killAndWait();
    this.finalizeObservedExit();
  }

  public onData(listener: (data: string) => void): Disposable {
    this.#dataListeners.add(listener);
    try {
      const pending = this.#pendingOutput;
      if (!pending.overrun) {
        for (const data of pending.chunks) listener(data);
      } else {
        this.#pendingOverrunBytes = pending.overrunBytes;
      }
      this.#pendingOutput = EMPTY_PENDING_OUTPUT;
    } catch (error: unknown) {
      this.#dataListeners.delete(listener);
      throw error;
    }
    return disposable(() => this.#dataListeners.delete(listener));
  }

  public consumePendingOutputOverrun(): number | null {
    const bytes = this.#pendingOverrunBytes;
    this.#pendingOverrunBytes = null;
    return bytes;
  }

  public onExit(listener: (event: { exitCode: number }) => void): Disposable {
    this.#exitListeners.add(listener);
    try {
      if (this.#exitCode !== null) listener({ exitCode: this.#exitCode });
    } catch (error: unknown) {
      this.#exitListeners.delete(listener);
      throw error;
    }
    return disposable(() => this.#exitListeners.delete(listener));
  }

  private emitData(data: string): void {
    if (data === "") return;
    if (this.#dataListeners.size > 0) {
      for (const listener of this.#dataListeners) {
        try {
          listener(data);
        } catch {
          // Presentation callbacks cannot interrupt PTY lifecycle observation or cleanup.
        }
      }
      return;
    }
    this.#pendingOutput = appendPendingOutput(this.#pendingOutput, data, MAX_PENDING_OUTPUT_BYTES);
  }

  private observeExit(exitCode: number): void {
    this.#observedExitCode ??= exitCode;
    this.finalizeObservedExit();
  }

  private finalizeObservedExit(): void {
    if (this.#closed) return;
    if (this.#observedExitCode === null) {
      throw new Error("The tmux terminal client has not confirmed process exit.");
    }
    if (!this.#decoderFlushed) {
      this.#decoderFlushed = true;
      this.emitData(this.#decoder.decode());
    }
    if (!this.#terminal.closed) this.#terminal.close();
    this.#exitCode = this.#observedExitCode;
    this.#closed = true;
    this.#owner.release(this);
    for (const listener of this.#exitListeners) {
      try {
        listener({ exitCode: this.#exitCode });
      } catch {
        // Presentation callbacks run only after cleanup and cannot revoke confirmed finalization.
      }
    }
  }
}

interface ObservableBunProcess {
  readonly exited: Promise<number>;
  kill(signal?: NodeJS.Signals): unknown;
}

/** Treats only a resolved Bun exit promise as proof that an owned child is gone. */
export class ConfirmedBunProcess implements ManagedTerminalResource {
  readonly #listeners = new Set<(event: { exitCode: number }) => void>();
  readonly #exit: Promise<void>;
  #exitEvent: { readonly exitCode: number } | null = null;
  #killInFlight: Promise<void> | null = null;

  public constructor(
    private readonly processHandle: ObservableBunProcess,
    private readonly closeTerminal: () => void = () => undefined
  ) {
    this.#exit = processHandle.exited.then((exitCode) => {
      this.#exitEvent = { exitCode };
      for (const listener of this.#listeners) {
        try {
          listener(this.#exitEvent);
        } catch {
          // Consumer callbacks cannot turn a positively observed process exit into ambiguity.
        }
      }
    });
    // Observation belongs to killAndWait; suppress only the ambient unhandled-rejection report.
    void this.#exit.catch(() => undefined);
  }

  public kill(): void {
    void this.killAndWait().catch(() => undefined);
  }

  public closeAndWait(): Promise<void> {
    return this.killAndWait();
  }

  public killAndWait(): Promise<void> {
    if (this.#exitEvent !== null) return Promise.resolve();
    if (this.#killInFlight !== null) return this.#killInFlight;
    const attempt = this.terminateAndConfirm();
    const shared = attempt.finally(() => {
      if (this.#killInFlight === shared && this.#exitEvent === null) this.#killInFlight = null;
    });
    this.#killInFlight = shared;
    return shared;
  }

  public onExit(listener: (event: { readonly exitCode: number }) => void): Disposable {
    this.#listeners.add(listener);
    if (this.#exitEvent !== null) listener(this.#exitEvent);
    return disposable(() => this.#listeners.delete(listener));
  }

  private async terminateAndConfirm(): Promise<void> {
    closePtyResources(this.processHandle, { closed: false, close: this.closeTerminal });
    if (await settlesWithin(this.#exit, PTY_GRACEFUL_EXIT_MS)) return;
    this.processHandle.kill("SIGKILL");
    if (await settlesWithin(this.#exit, PTY_FORCED_EXIT_MS)) return;
    throw new Error("The tmux terminal client did not confirm process exit.");
  }
}

/** Discards the whole pending stream on overflow so no partial ANSI sequence can be replayed. */
export function appendPendingOutput(
  current: PendingTerminalOutput,
  data: string,
  maximumBytes: number
): PendingTerminalOutput {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new Error("Pending terminal output limit must be a positive integer.");
  }

  if (current.overrun) return current;
  const dataBytes = Buffer.byteLength(data);
  if (dataBytes > maximumBytes - current.bytes) {
    return {
      chunks: [],
      bytes: 0,
      overrun: true,
      overrunBytes: current.bytes + dataBytes
    };
  }

  return {
    chunks: [...current.chunks, data],
    bytes: current.bytes + dataBytes,
    overrun: false,
    overrunBytes: 0
  };
}

interface KillableProcess {
  kill(): unknown;
}

interface CloseableTerminal {
  readonly closed: boolean;
  close(): void;
}

/** Releases both PTY resources even when process termination reports an error. */
export function closePtyResources(
  processHandle: KillableProcess,
  terminal: CloseableTerminal
): void {
  try {
    processHandle.kill();
  } finally {
    if (!terminal.closed) terminal.close();
  }
}

function disposable(dispose: () => unknown): Disposable {
  let disposed = false;
  return {
    dispose() {
      if (disposed) return;
      disposed = true;
      dispose();
    }
  };
}

async function settlesWithin(operation: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<false>((resolve) => {
    timeout = setTimeout(() => {
      resolve(false);
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation.then(() => true), deadline]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export function stringEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !PRIVATE_TUI_ENVIRONMENT_KEYS.has(entry[0])
    )
  );
}
