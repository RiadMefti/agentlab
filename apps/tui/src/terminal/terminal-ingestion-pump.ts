const DEFAULT_SLICE_BYTES = 8 * 1024;
const DEFAULT_SLICE_MILLISECONDS = 4;
export const maximumQueuedTerminalBytes = 16 * 1024 * 1024;

type QueueEntry =
  | { readonly kind: "bytes"; readonly bytes: Uint8Array }
  | { readonly kind: "seed-boundary"; readonly onSeeded: () => void };

export interface TerminalIngestionPumpOptions {
  readonly write: (data: Uint8Array) => void;
  readonly invalidate: () => void;
  readonly onOverrun: (queuedBytes: number) => void;
  readonly maximumQueuedBytes?: number;
  readonly sliceBytes?: number;
  readonly sliceMilliseconds?: number;
  readonly now?: () => number;
  readonly schedule?: (callback: () => void) => () => void;
}

/** Single-owner, byte-preserving bridge from PTY/history producers into OpenTUI's native VT. */
export class TerminalIngestionPump {
  readonly #encoder = new TextEncoder();
  readonly #invalidate: () => void;
  readonly #maximumQueuedBytes: number;
  readonly #now: () => number;
  readonly #onOverrun: (queuedBytes: number) => void;
  readonly #schedule: (callback: () => void) => () => void;
  readonly #sliceBytes: number;
  readonly #sliceMilliseconds: number;
  readonly #write: (data: Uint8Array) => void;
  readonly #queue: QueueEntry[] = [];
  #cancelScheduled: (() => void) | null = null;
  #headOffset = 0;
  #queuedBytes = 0;
  #cancelled = false;

  public constructor(options: TerminalIngestionPumpOptions) {
    this.#write = options.write;
    this.#invalidate = options.invalidate;
    this.#onOverrun = options.onOverrun;
    this.#maximumQueuedBytes = positiveInteger(
      options.maximumQueuedBytes ?? maximumQueuedTerminalBytes,
      "terminal queue limit"
    );
    this.#sliceBytes = positiveInteger(options.sliceBytes ?? DEFAULT_SLICE_BYTES, "slice size");
    this.#sliceMilliseconds = positiveNumber(
      options.sliceMilliseconds ?? DEFAULT_SLICE_MILLISECONDS,
      "slice time"
    );
    this.#now = options.now ?? (() => performance.now());
    this.#schedule = options.schedule ?? scheduleMacrotask;
  }

  public enqueue(data: string | Uint8Array): boolean {
    if (this.#cancelled) return false;
    const bytes = typeof data === "string" ? this.#encoder.encode(data) : data.slice();
    if (bytes.byteLength === 0) return true;
    const nextSize = this.#queuedBytes + bytes.byteLength;
    if (nextSize > this.#maximumQueuedBytes) {
      this.cancel();
      this.#onOverrun(nextSize);
      return false;
    }
    this.#queue.push({ kind: "bytes", bytes });
    this.#queuedBytes = nextSize;
    this.scheduleDrain();
    return true;
  }

  /** Adds the one full-invalidation boundary that separates durable history from live output. */
  public finishHistory(onSeeded: () => void): boolean {
    if (this.#cancelled) return false;
    this.#queue.push({ kind: "seed-boundary", onSeeded });
    this.scheduleDrain();
    return true;
  }

  public cancel(): void {
    if (this.#cancelled) return;
    this.#cancelled = true;
    this.#cancelScheduled?.();
    this.#cancelScheduled = null;
    this.#queue.splice(0);
    this.#headOffset = 0;
    this.#queuedBytes = 0;
  }

  public get queuedBytes(): number {
    return this.#queuedBytes;
  }

  private scheduleDrain(): void {
    if (this.#cancelled || this.#cancelScheduled !== null) return;
    this.#cancelScheduled = this.#schedule(() => {
      this.#cancelScheduled = null;
      this.drainSlice();
    });
  }

  private drainSlice(): void {
    if (this.#cancelled) return;
    const startedAt = this.#now();
    const chunks: Uint8Array[] = [];
    let byteCount = 0;

    while (byteCount < this.#sliceBytes && this.#now() - startedAt < this.#sliceMilliseconds) {
      const entry = this.#queue[0];
      if (entry === undefined || entry.kind === "seed-boundary") break;
      const available = entry.bytes.byteLength - this.#headOffset;
      const take = Math.min(available, this.#sliceBytes - byteCount);
      chunks.push(entry.bytes.subarray(this.#headOffset, this.#headOffset + take));
      byteCount += take;
      this.#headOffset += take;
      this.#queuedBytes -= take;
      if (this.#headOffset === entry.bytes.byteLength) {
        this.#queue.shift();
        this.#headOffset = 0;
      }
    }

    if (byteCount > 0) this.#write(concatenate(chunks, byteCount));

    const boundary = this.#queue[0];
    if (boundary?.kind === "seed-boundary") {
      this.#queue.shift();
      this.#invalidate();
      boundary.onSeeded();
    }
    if (this.#queue.length > 0) this.scheduleDrain();
  }
}

function concatenate(chunks: readonly Uint8Array[], byteCount: number): Uint8Array {
  if (chunks.length === 1) return chunks[0]?.slice() ?? new Uint8Array();
  const output = new Uint8Array(byteCount);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function scheduleMacrotask(callback: () => void): () => void {
  const timer = setImmediate(callback);
  return () => {
    clearImmediate(timer);
  };
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be positive.`);
  return value;
}

function positiveNumber(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be positive.`);
  return value;
}
