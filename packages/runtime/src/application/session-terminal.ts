import { z } from "zod";

import type {
  Disposable,
  ManagedPseudoTerminal,
  ManagedTerminalResourceOwner
} from "../domain/terminal.js";
import { RuntimeResourceOwner } from "./runtime-resource-owner.js";

export const maximumTerminalDimension = 1_000;
export const maximumOrderedTerminalOutputBytes = 1024 * 1024;

const terminalColumnsSchema = z.number().int().min(2).max(maximumTerminalDimension);
const terminalRowsSchema = z.number().int().min(1).max(maximumTerminalDimension);
const utf8Encoder = new TextEncoder();

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
    const bytes = utf8Encoder.encode(data).byteLength;
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

  public readonly onOutputOverrun = (bufferedBytes: number): void => {
    if (this.#released || this.#overrun) return;
    this.#overrun = true;
    this.#overrunBytes = bufferedBytes;
    this.#events.splice(0);
    this.#bufferedBytes = 0;
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
  readonly #process: ManagedPseudoTerminal;
  readonly #subscriptions: Disposable[] = [];
  readonly #onClose: () => void;
  #closed = false;
  #closeInFlight: Promise<void> | null = null;
  #subscriptionsDisposed = false;
  #ownershipReleased = false;

  public constructor(
    process: ManagedPseudoTerminal,
    callbacks: SessionTerminalCallbacks,
    onClose: () => void = () => undefined
  ) {
    this.#process = process;
    this.#onClose = onClose;
    try {
      this.#subscriptions.push(process.onData(callbacks.onData));
      const pendingOverrun = process.consumePendingOutputOverrun?.() ?? null;
      if (pendingOverrun !== null && "onOutputOverrun" in callbacks) {
        const reportOverrun = callbacks.onOutputOverrun;
        if (typeof reportOverrun === "function") reportOverrun.call(callbacks, pendingOverrun);
      }
      const exitSubscription = process.onExit(({ exitCode }) => {
        try {
          callbacks.onExit(exitCode);
        } finally {
          this.completeClose();
        }
      });
      if (this.#closed) exitSubscription.dispose();
      else this.#subscriptions.push(exitSubscription);
      if (pendingOverrun !== null) this.close();
    } catch (error: unknown) {
      this.disposeSubscriptions();
      throw error;
    }
  }

  public write(data: Uint8Array): void {
    if (this.#closed || this.#closeInFlight !== null) return;
    this.#process.write(data);
  }

  public get closed(): boolean {
    return this.#closed;
  }

  public resize(columns: number, rows: number): void {
    if (this.#closed || this.#closeInFlight !== null) return;
    const dimensions = parseTerminalDimensions(columns, rows);
    this.#process.resize(dimensions.columns, dimensions.rows);
  }

  public close(): void {
    void this.closeAndWait().catch(() => undefined);
  }

  public closeAndWait(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#closeInFlight !== null) return this.#closeInFlight;
    this.disposeSubscriptions();
    const attempt = Promise.resolve()
      .then(() => this.#process.killAndWait())
      .then(() => {
        this.completeClose();
      });
    const shared = attempt.finally(() => {
      if (this.#closeInFlight === shared && !this.#closed) this.#closeInFlight = null;
    });
    this.#closeInFlight = shared;
    return shared;
  }

  private completeClose(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.disposeSubscriptions();
    if (!this.#ownershipReleased) {
      this.#ownershipReleased = true;
      this.#onClose();
    }
  }

  private disposeSubscriptions(): void {
    if (this.#subscriptionsDisposed) return;
    this.#subscriptionsDisposed = true;
    for (const subscription of this.#subscriptions.splice(0)) subscription.dispose();
  }
}

/** Owns every ephemeral terminal resource created by one local runtime. */
export class SessionTerminalOwner
  extends RuntimeResourceOwner
  implements ManagedTerminalResourceOwner {}
