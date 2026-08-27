import { describe, expect, it, vi } from "vitest";

import { TerminalIngestionPump } from "../../apps/tui/src/terminal/terminal-ingestion-pump.js";

describe("TerminalIngestionPump", () => {
  it("preserves exact bytes and boundaries while yielding between bounded slices", () => {
    const scheduler = manualScheduler();
    const writes: Uint8Array[] = [];
    const pump = new TerminalIngestionPump({
      invalidate: vi.fn(),
      onOverrun: vi.fn(),
      schedule: scheduler.schedule,
      sliceBytes: 3,
      sliceMilliseconds: 10,
      write: (data) => writes.push(data)
    });
    const input = new Uint8Array([
      0x1b, 0x5b, 0x3f, 0x37, 0x37, 0x32, 0x37, 0x6c, 0xf0, 0x9f, 0xa7, 0xaa
    ]);

    pump.enqueue(input.subarray(0, 5));
    pump.enqueue(input.subarray(5));

    expect(scheduler.pending()).toBe(1);
    scheduler.runOne();
    expect(join(writes)).toEqual(input.subarray(0, 3));
    expect(scheduler.pending()).toBe(1);
    scheduler.runAll();
    expect(join(writes)).toEqual(input);
    expect(writes.every(({ byteLength }) => byteLength <= 3)).toBe(true);
  });

  it("invalidates exactly once after history before releasing queued live output", () => {
    const scheduler = manualScheduler();
    const events: string[] = [];
    const pump = new TerminalIngestionPump({
      invalidate: () => events.push("invalidate"),
      onOverrun: vi.fn(),
      schedule: scheduler.schedule,
      sliceBytes: 64,
      write: (data) => events.push(new TextDecoder().decode(data))
    });

    pump.enqueue("history");
    pump.finishHistory(() => {
      events.push("released");
      pump.enqueue("live");
    });
    scheduler.runAll();

    expect(events).toEqual(["history", "invalidate", "released", "live"]);
  });

  it("ends a slice at its time budget and yields before continuing", () => {
    const scheduler = manualScheduler();
    const writes: string[] = [];
    let clock = 0;
    const pump = new TerminalIngestionPump({
      invalidate: vi.fn(),
      now: () => {
        const current = clock;
        clock += 2;
        return current;
      },
      onOverrun: vi.fn(),
      schedule: scheduler.schedule,
      sliceBytes: 100,
      sliceMilliseconds: 3,
      write: (data) => writes.push(new TextDecoder().decode(data))
    });

    pump.enqueue("first");
    pump.enqueue("second");
    scheduler.runOne();
    expect(writes).toEqual(["first"]);
    expect(scheduler.pending()).toBe(1);
    scheduler.runAll();
    expect(writes.join("")).toBe("firstsecond");
  });

  it("cancels scheduled and stale work without writing it", () => {
    const scheduler = manualScheduler();
    const write = vi.fn();
    const pump = new TerminalIngestionPump({
      invalidate: vi.fn(),
      onOverrun: vi.fn(),
      schedule: scheduler.schedule,
      write
    });

    pump.enqueue("stale attachment");
    pump.cancel();
    scheduler.runAll();

    expect(write).not.toHaveBeenCalled();
    expect(pump.enqueue("later")).toBe(false);
    expect(pump.queuedBytes).toBe(0);
  });

  it("fails closed once on overrun rather than dropping escape-sequence bytes", () => {
    const scheduler = manualScheduler();
    const onOverrun = vi.fn();
    const write = vi.fn();
    const pump = new TerminalIngestionPump({
      invalidate: vi.fn(),
      maximumQueuedBytes: 5,
      onOverrun,
      schedule: scheduler.schedule,
      write
    });

    expect(pump.enqueue(new Uint8Array([1, 2, 3]))).toBe(true);
    expect(pump.enqueue(new Uint8Array([4, 5, 6]))).toBe(false);
    expect(pump.enqueue(new Uint8Array([7]))).toBe(false);
    scheduler.runAll();

    expect(onOverrun).toHaveBeenCalledOnce();
    expect(onOverrun).toHaveBeenCalledWith(6);
    expect(write).not.toHaveBeenCalled();
  });

  it("drains real-scheduler output exactly while allowing timers to run", async () => {
    const input = new Uint8Array(512 * 1024);
    for (let index = 0; index < input.byteLength; index += 1) input[index] = index % 251;
    let completeAndOrdered = true;
    let maximumWriteBytes = 0;
    let writtenBytes = 0;
    let timerObserved = false;
    const pump = new TerminalIngestionPump({
      invalidate: vi.fn(),
      onOverrun: vi.fn(),
      write: (data) => {
        maximumWriteBytes = Math.max(maximumWriteBytes, data.byteLength);
        for (let index = 0; index < data.byteLength; index += 1) {
          if (data[index] !== input[writtenBytes + index]) completeAndOrdered = false;
        }
        writtenBytes += data.byteLength;
      }
    });
    const timer = setTimeout(() => {
      timerObserved = true;
    }, 0);
    pump.enqueue(input);
    await new Promise<void>((resolveSeeded) => {
      pump.finishHistory(resolveSeeded);
    });
    clearTimeout(timer);

    expect(completeAndOrdered).toBe(true);
    expect(writtenBytes).toBe(input.byteLength);
    expect(maximumWriteBytes).toBeLessThanOrEqual(8 * 1024);
    expect(timerObserved).toBe(true);
  });
});

function manualScheduler() {
  const tasks: { active: boolean; callback: () => void }[] = [];
  return {
    schedule(callback: () => void): () => void {
      const task = { active: true, callback };
      tasks.push(task);
      return () => {
        task.active = false;
      };
    },
    pending(): number {
      return tasks.filter(({ active }) => active).length;
    },
    runOne(): void {
      const task = tasks.shift();
      if (task?.active) task.callback();
    },
    runAll(): void {
      while (tasks.length > 0) this.runOne();
    }
  };
}

function join(chunks: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
