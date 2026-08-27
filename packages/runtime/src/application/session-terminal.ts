import { z } from "zod";

import type { Disposable, PseudoTerminal } from "../domain/terminal.js";

export const maximumTerminalDimension = 1_000;
export const maximumOrderedTerminalOutputBytes = 1024 * 1024;

const terminalColumnsSchema = z.number().int().min(2).max(maximumTerminalDimension);
const terminalRowsSchema = z.number().int().min(1).max(maximumTerminalDimension);

export function parseTerminalDimensions(
  columns: unknown,
  rows: unknown
): { readonly columns: number; readonly rows: number } {
  return {
    columns: terminalColumnsSchema.parse(columns),
    rows: terminalRowsSchema.parse(rows)
  };
}

export interface SessionTerminalCallbacks {
  readonly onData: (data: string) => void;
  readonly onExit: (exitCode: number) => void;
}

export interface SessionTerminal {
  write(data: Uint8Array): void;
  resize(columns: number, rows: number): void;
  close(): void;
}

type BufferedTerminalEvent =
  | { readonly kind: "data"; readonly data: string }
  | { readonly kind: "exit"; readonly exitCode: number };

export interface BufferedTerminalRelease {
  readonly bufferedBytes: number;
  readonly overrun: boolean;
}

/** Holds live PTY events until presentation has seeded the older tmux history. */
export class OrderedSessionTerminalCallbacks implements SessionTerminalCallbacks {
  readonly #callbacks: SessionTerminalCallbacks;
  readonly #events: BufferedTerminalEvent[] = [];
  readonly #maximumBytes: number;
  #bufferedBytes = 0;
  #overrunBytes = 0;
  #overrun = false;
  #released = false;

  public constructor(
    callbacks: SessionTerminalCallbacks,
    maximumBytes = maximumOrderedTerminalOutputBytes
  ) {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
      throw new RangeError("Ordered terminal output limit must be a positive integer.");
    }
    this.#callbacks = callbacks;
    this.#maximumBytes = maximumBytes;
  }

  public readonly onData = (data: string): void => {
    if (this.#released) {
      this.#callbacks.onData(data);
      return;
    }
    if (this.#overrun) return;
    const bytes = Buffer.byteLength(data);
    if (bytes > this.#maximumBytes - this.#bufferedBytes) {
      // Never replay a partial escape stream. Presentation closes this ephemeral client and
      // reattaches from durable tmux history when release reports the recoverable overrun.
      this.#overrun = true;
      this.#overrunBytes = this.#bufferedBytes + bytes;
      this.#events.splice(0);
      this.#bufferedBytes = 0;
      return;
    }
    this.#bufferedBytes += bytes;
    this.#events.push({ kind: "data", data });
  };

  public readonly onExit = (exitCode: number): void => {
    if (this.#released) this.#callbacks.onExit(exitCode);
    else if (!this.#overrun) this.#events.push({ kind: "exit", exitCode });
  };

  public release(): BufferedTerminalRelease {
    if (this.#released) return { bufferedBytes: 0, overrun: this.#overrun };
    this.#released = true;
    const bufferedBytes = this.#bufferedBytes;
    this.#bufferedBytes = 0;
    if (this.#overrun) return { bufferedBytes: this.#overrunBytes, overrun: true };
    for (const event of this.#events.splice(0)) {
      if (event.kind === "data") this.#callbacks.onData(event.data);
      else this.#callbacks.onExit(event.exitCode);
    }
    return { bufferedBytes, overrun: false };
  }
}

/** Owns a single PTY attachment while leaving its durable tmux session alive. */
export class AttachedSessionTerminal implements SessionTerminal {
  readonly #process: PseudoTerminal;
  readonly #subscriptions: Disposable[] = [];
  readonly #onClose: () => void;
  #closed = false;

  public constructor(
    process: PseudoTerminal,
    callbacks: SessionTerminalCallbacks,
    onClose: () => void = () => undefined
  ) {
    this.#process = process;
    this.#onClose = onClose;
    this.#subscriptions.push(process.onData(callbacks.onData));
    const exitSubscription = process.onExit(({ exitCode }) => {
      try {
        callbacks.onExit(exitCode);
      } finally {
        this.close();
      }
    });
    if (this.#closed) exitSubscription.dispose();
    else this.#subscriptions.push(exitSubscription);
  }

  public write(data: Uint8Array): void {
    if (this.#closed) return;
    this.#process.write(data);
  }

  public get closed(): boolean {
    return this.#closed;
  }

  public resize(columns: number, rows: number): void {
    if (this.#closed) return;
    const dimensions = parseTerminalDimensions(columns, rows);
    this.#process.resize(dimensions.columns, dimensions.rows);
  }

  public close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const subscription of this.#subscriptions) subscription.dispose();
    try {
      this.#process.kill();
    } catch {
      // The tmux client PTY may already have exited. Its tmux session remains durable.
    } finally {
      this.#onClose();
    }
  }
}

/** Owns every ephemeral terminal returned by one local runtime. */
export class SessionTerminalOwner {
  readonly #terminals = new Set<SessionTerminal>();

  public track(terminal: SessionTerminal): void {
    this.#terminals.add(terminal);
  }

  public release(terminal: SessionTerminal): void {
    this.#terminals.delete(terminal);
  }

  public closeAll(): void {
    const terminals = [...this.#terminals];
    this.#terminals.clear();
    const failures: unknown[] = [];
    for (const terminal of terminals) {
      try {
        terminal.close();
      } catch (error: unknown) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "One or more terminal attachments could not close.");
    }
  }
}
