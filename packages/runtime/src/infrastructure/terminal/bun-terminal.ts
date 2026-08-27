import type {
  Disposable,
  PseudoTerminal,
  PseudoTerminalFactory,
  TerminalDimensions
} from "../../domain/terminal.js";

const MAX_PENDING_OUTPUT_BYTES = 1024 * 1024;

export interface PendingTerminalOutput {
  readonly chunks: readonly string[];
  readonly bytes: number;
}

const EMPTY_PENDING_OUTPUT: PendingTerminalOutput = { chunks: [], bytes: 0 };
const PRIVATE_TUI_ENVIRONMENT_KEYS = new Set(["AGENTLAB_DIAGNOSTIC_LOG", "AGENTLAB_TUI_RUNTIME"]);

/** Attaches Bun's native PTY to an exact managed tmux session. */
export class BunTerminalFactory implements PseudoTerminalFactory {
  public constructor(private readonly socketPath?: string) {}

  public attach(sessionName: string, cwd: string, dimensions: TerminalDimensions): PseudoTerminal {
    const tmuxArgs = ["attach-session", "-t", `=${sessionName}`];
    return new BunPseudoTerminal(
      this.socketPath === undefined ? tmuxArgs : ["-S", this.socketPath, ...tmuxArgs],
      cwd,
      dimensions
    );
  }
}

class BunPseudoTerminal implements PseudoTerminal {
  readonly #dataListeners = new Set<(data: string) => void>();
  readonly #exitListeners = new Set<(event: { exitCode: number }) => void>();
  readonly #decoder = new TextDecoder();
  readonly #process: Bun.Subprocess;
  readonly #terminal: Bun.Terminal;
  #pendingOutput = EMPTY_PENDING_OUTPUT;
  #exitCode: number | null = null;
  #closed = false;

  public constructor(args: readonly string[], cwd: string, dimensions: TerminalDimensions) {
    const subprocess = Bun.spawn(["tmux", ...args], {
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
    if (subprocess.terminal === undefined) {
      subprocess.kill();
      throw new Error("Bun did not create a terminal for the tmux attachment.");
    }
    this.#process = subprocess;
    this.#terminal = subprocess.terminal;
    void subprocess.exited.then(
      (exitCode) => {
        this.finish(exitCode);
      },
      () => {
        this.finish(1);
      }
    );
  }

  public write(data: Uint8Array): void {
    if (!this.#closed) this.#terminal.write(data);
  }

  public resize(columns: number, rows: number): void {
    if (!this.#closed) this.#terminal.resize(columns, rows);
  }

  public kill(): void {
    if (this.#closed) return;
    this.#closed = true;
    closePtyResources(this.#process, this.#terminal);
  }

  public onData(listener: (data: string) => void): Disposable {
    this.#dataListeners.add(listener);
    for (const data of this.#pendingOutput.chunks) listener(data);
    this.#pendingOutput = EMPTY_PENDING_OUTPUT;
    return disposable(() => this.#dataListeners.delete(listener));
  }

  public onExit(listener: (event: { exitCode: number }) => void): Disposable {
    this.#exitListeners.add(listener);
    if (this.#exitCode !== null) listener({ exitCode: this.#exitCode });
    return disposable(() => this.#exitListeners.delete(listener));
  }

  private emitData(data: string): void {
    if (data === "") return;
    if (this.#dataListeners.size > 0) {
      for (const listener of this.#dataListeners) listener(data);
      return;
    }
    this.#pendingOutput = appendPendingOutput(this.#pendingOutput, data, MAX_PENDING_OUTPUT_BYTES);
  }

  private finish(exitCode: number): void {
    if (this.#exitCode !== null) return;
    this.emitData(this.#decoder.decode());
    this.#exitCode = exitCode;
    this.#closed = true;
    if (!this.#terminal.closed) this.#terminal.close();
    for (const listener of this.#exitListeners) listener({ exitCode });
  }
}

/** Keeps the newest complete UTF-8 output within a strict byte budget. */
export function appendPendingOutput(
  current: PendingTerminalOutput,
  data: string,
  maximumBytes: number
): PendingTerminalOutput {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
    throw new Error("Pending terminal output limit must be a positive integer.");
  }

  const dataBytes = Buffer.byteLength(data);
  if (dataBytes >= maximumBytes) {
    const tail = utf8Tail(data, maximumBytes);
    return tail === "" ? EMPTY_PENDING_OUTPUT : { chunks: [tail], bytes: Buffer.byteLength(tail) };
  }

  const chunks = [...current.chunks];
  let bytes = current.bytes;
  while (chunks.length > 0 && bytes + dataBytes > maximumBytes) {
    const removed = chunks.shift();
    if (removed !== undefined) bytes -= Buffer.byteLength(removed);
  }
  chunks.push(data);
  return { chunks, bytes: bytes + dataBytes };
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

function utf8Tail(value: string, maximumBytes: number): string {
  const encoded = Buffer.from(value);
  let start = encoded.length - maximumBytes;
  while (start < encoded.length && (encoded[start] ?? 0) >> 6 === 0b10) start += 1;
  return encoded.subarray(start).toString("utf8");
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

export function stringEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !PRIVATE_TUI_ENVIRONMENT_KEYS.has(entry[0])
    )
  );
}
