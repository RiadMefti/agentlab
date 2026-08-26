import { describe, expect, it, vi } from "vitest";

import {
  AttachedSessionTerminal,
  OrderedSessionTerminalCallbacks,
  SessionTerminalOwner
} from "../../packages/runtime/src/application/session-terminal.js";
import type { Disposable, PseudoTerminal } from "../../packages/runtime/src/domain/terminal.js";

function fakeProcess() {
  let dataListener: (data: string) => void = () => undefined;
  let exitListener: (event: { exitCode: number }) => void = () => undefined;
  const dataSubscription: Disposable = { dispose: vi.fn() };
  const exitSubscription: Disposable = { dispose: vi.fn() };
  const process: PseudoTerminal = {
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
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

  it("forwards output and closes idempotently when the PTY exits", () => {
    const fake = fakeProcess();
    const onData = vi.fn();
    const onExit = vi.fn();
    const terminal = new AttachedSessionTerminal(fake.process, { onData, onExit });

    fake.dataListener()("output");
    fake.exitListener()({ exitCode: 7 });
    terminal.close();

    expect(onData).toHaveBeenCalledWith("output");
    expect(onExit).toHaveBeenCalledWith(7);
    expect(fake.process.kill).toHaveBeenCalledTimes(1);
  });

  it("handles a PTY that reports an existing exit while subscriptions are created", () => {
    const dataSubscription: Disposable = { dispose: vi.fn() };
    const exitSubscription: Disposable = { dispose: vi.fn() };
    const process: PseudoTerminal = {
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
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
    expect(process.kill).toHaveBeenCalledTimes(1);
  });

  it("notifies ownership once when an attachment closes", () => {
    const fake = fakeProcess();
    const onClose = vi.fn();
    const terminal = new AttachedSessionTerminal(
      fake.process,
      { onData: vi.fn(), onExit: vi.fn() },
      onClose
    );

    terminal.close();
    terminal.close();

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes every attachment still owned by a runtime", () => {
    const owner = new SessionTerminalOwner();
    const released = { write: vi.fn(), resize: vi.fn(), close: vi.fn() };
    const active = { write: vi.fn(), resize: vi.fn(), close: vi.fn() };
    owner.track(released);
    owner.track(active);
    owner.release(released);

    owner.closeAll();
    owner.closeAll();

    expect(released.close).not.toHaveBeenCalled();
    expect(active.close).toHaveBeenCalledTimes(1);
  });

  it("attempts every owned close when one attachment throws", () => {
    const owner = new SessionTerminalOwner();
    const failing = {
      write: vi.fn(),
      resize: vi.fn(),
      close: vi.fn(() => {
        throw new Error("close failed");
      })
    };
    const active = { write: vi.fn(), resize: vi.fn(), close: vi.fn() };
    owner.track(failing);
    owner.track(active);

    expect(() => {
      owner.closeAll();
    }).toThrow("One or more terminal attachments could not close");
    expect(active.close).toHaveBeenCalledTimes(1);
  });
});

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
    callbacks.release();
    callbacks.onData("after-release");

    expect(rendered).toEqual(["history", "live-one", "live-two", "exit:7", "after-release"]);
  });
});
