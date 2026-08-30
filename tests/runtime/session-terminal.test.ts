import { describe, expect, it, vi } from "vitest";

import {
  AttachedSessionTerminal,
  OrderedSessionTerminalCallbacks,
  SessionTerminalOwner
} from "../../packages/runtime/src/application/session-terminal.js";
import type {
  Disposable,
  ManagedPseudoTerminal
} from "../../packages/runtime/src/domain/terminal.js";

function fakeProcess() {
  let dataListener: (data: string) => void = () => undefined;
  let exitListener: (event: { exitCode: number }) => void = () => undefined;
  const dataSubscription: Disposable = { dispose: vi.fn() };
  const exitSubscription: Disposable = { dispose: vi.fn() };
  const killAndWait = vi.fn(() => Promise.resolve());
  const process: ManagedPseudoTerminal = {
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    killAndWait,
    closeAndWait: killAndWait,
    onData(listener) {
      dataListener = listener;
      return dataSubscription;
    },
    onExit(listener) {
      exitListener = listener;
      return exitSubscription;
    }
  };
  return { dataListener: () => dataListener, exitListener: () => exitListener, process };
}

describe("AttachedSessionTerminal", () => {
  it("forwards bytes and bounded resizes to the PTY", () => {
    const fake = fakeProcess();
    const terminal = new AttachedSessionTerminal(fake.process, {
      onData: vi.fn(),
      onExit: vi.fn()
    });

    terminal.write(new TextEncoder().encode("hello\r"));
    terminal.resize(120, 40);

    expect(fake.process.write).toHaveBeenCalledWith(new TextEncoder().encode("hello\r"));
    expect(fake.process.resize).toHaveBeenCalledWith(120, 40);
    expect(() => {
      terminal.resize(1, 40);
    }).toThrow();
  });

  it("forwards split UTF-8 and arbitrary input bytes without decoding or re-encoding", () => {
    const fake = fakeProcess();
    const terminal = new AttachedSessionTerminal(fake.process, {
      onData: vi.fn(),
      onExit: vi.fn()
    });
    const chunks = [new Uint8Array([0xc3]), new Uint8Array([0xa9]), new Uint8Array([0, 0xff, 27])];

    for (const chunk of chunks) terminal.write(chunk);

    expect(vi.mocked(fake.process.write).mock.calls.map(([data]) => [...data])).toEqual(
      chunks.map((chunk) => [...chunk])
    );
  });

  it("forwards output and closes idempotently when the PTY exits", async () => {
    const fake = fakeProcess();
    const onData = vi.fn();
    const onExit = vi.fn();
    const terminal = new AttachedSessionTerminal(fake.process, { onData, onExit });

    fake.dataListener()("output");
    fake.exitListener()({ exitCode: 7 });
    await terminal.closeAndWait();

    expect(onData).toHaveBeenCalledWith("output");
    expect(onExit).toHaveBeenCalledWith(7);
    expect(fake.process.kill).not.toHaveBeenCalled();
  });

  it("handles a PTY that reports an existing exit while subscriptions are created", () => {
    const dataSubscription: Disposable = { dispose: vi.fn() };
    const exitSubscription: Disposable = { dispose: vi.fn() };
    const killAndWait = vi.fn(() => Promise.resolve());
    const process: ManagedPseudoTerminal = {
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      killAndWait,
      closeAndWait: killAndWait,
      onData: vi.fn(() => dataSubscription),
      onExit(listener) {
        listener({ exitCode: 0 });
        return exitSubscription;
      }
    };
    const onExit = vi.fn();

    expect(() => new AttachedSessionTerminal(process, { onData: vi.fn(), onExit })).not.toThrow();

    expect(onExit).toHaveBeenCalledWith(0);
    expect(dataSubscription.dispose).toHaveBeenCalledTimes(1);
    expect(exitSubscription.dispose).toHaveBeenCalledTimes(1);
    expect(process.kill).not.toHaveBeenCalled();
  });

  it("notifies ownership once only after an attachment confirms closure", async () => {
    const fake = fakeProcess();
    const onClose = vi.fn();
    const terminal = new AttachedSessionTerminal(
      fake.process,
      { onData: vi.fn(), onExit: vi.fn() },
      onClose
    );

    terminal.close();
    await terminal.closeAndWait();

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes every attachment still owned by a runtime", async () => {
    const owner = new SessionTerminalOwner();
    const released = ownedTerminal();
    const active = ownedTerminal();
    owner.track(released);
    owner.track(active);
    owner.release(released);

    await owner.closeAll();
    await owner.closeAll();

    expect(released.close).not.toHaveBeenCalled();
    expect(active.closeAndWait).toHaveBeenCalledTimes(1);
  });

  it("attempts every owned close when one attachment rejects", async () => {
    const owner = new SessionTerminalOwner();
    const failing = ownedTerminal(() => Promise.reject(new Error("close failed")));
    const active = ownedTerminal();
    owner.track(failing);
    owner.track(active);

    await expect(owner.closeAll()).rejects.toThrow("One or more runtime resources could not close");
    expect(active.closeAndWait).toHaveBeenCalledTimes(1);
  });

  it("retains ownership and permits retry when PTY termination is ambiguous", async () => {
    const fake = fakeProcess();
    vi.mocked(fake.process.killAndWait)
      .mockRejectedValueOnce(new Error("kill not confirmed"))
      .mockResolvedValueOnce(undefined);
    const onClose = vi.fn();
    const terminal = new AttachedSessionTerminal(
      fake.process,
      { onData: vi.fn(), onExit: vi.fn() },
      onClose
    );

    await expect(terminal.closeAndWait()).rejects.toThrow("kill not confirmed");
    expect(terminal.closed).toBe(false);
    expect(onClose).not.toHaveBeenCalled();
    await expect(terminal.closeAndWait()).resolves.toBeUndefined();
    expect(terminal.closed).toBe(true);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("propagates a pre-listener stream overrun without replaying partial output", async () => {
    const fake = fakeProcess();
    fake.process.consumePendingOutputOverrun = () => 1_100_000;
    const callbacks = new OrderedSessionTerminalCallbacks({
      onData: vi.fn(),
      onExit: vi.fn()
    });
    const terminal = new AttachedSessionTerminal(fake.process, callbacks);

    expect(callbacks.release()).toEqual({ bufferedBytes: 1_100_000, overrun: true });
    await terminal.closeAndWait();
  });
});

function ownedTerminal(closeAndWait: () => Promise<void> = () => Promise.resolve()) {
  return {
    write: vi.fn(),
    resize: vi.fn(),
    close: vi.fn(),
    closeAndWait: vi.fn(closeAndWait)
  };
}

describe("OrderedSessionTerminalCallbacks", () => {
  it("replays synchronous attach output after history and preserves event order", () => {
    const rendered: string[] = [];
    const callbacks = new OrderedSessionTerminalCallbacks({
      onData: (data) => rendered.push(data),
      onExit: (exitCode) => rendered.push(`exit:${String(exitCode)}`)
    });

    callbacks.onData("live-one");
    callbacks.onData("live-two");
    callbacks.onExit(7);
    rendered.push("history");
    const release = callbacks.release();
    callbacks.onData("after-release");

    expect(release).toEqual({ bufferedBytes: 16, overrun: false });
    expect(rendered).toEqual(["history", "live-one", "live-two", "exit:7", "after-release"]);
  });

  it("counts UTF-8 bytes and rejects the whole buffered stream on overrun", () => {
    const rendered: string[] = [];
    const callbacks = new OrderedSessionTerminalCallbacks(
      {
        onData: (data) => rendered.push(data),
        onExit: (exitCode) => rendered.push(`exit:${String(exitCode)}`)
      },
      8
    );

    callbacks.onData("a界");
    callbacks.onData("🙂");
    callbacks.onData("overflow");
    callbacks.onExit(9);

    expect(callbacks.release()).toEqual({ bufferedBytes: 16, overrun: true });
    expect(rendered).toEqual([]);
  });

  it("validates its byte cap and releases only once", () => {
    expect(
      () =>
        new OrderedSessionTerminalCallbacks({ onData: () => undefined, onExit: () => undefined }, 0)
    ).toThrow("positive integer");

    const callbacks = new OrderedSessionTerminalCallbacks({
      onData: () => undefined,
      onExit: () => undefined
    });
    callbacks.onData("one");
    expect(callbacks.release()).toEqual({ bufferedBytes: 3, overrun: false });
    expect(callbacks.release()).toEqual({ bufferedBytes: 0, overrun: false });
  });
});
