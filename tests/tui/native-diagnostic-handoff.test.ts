import { describe, expect, it, vi } from "vitest";

import {
  nativeDiagnosticHandoffDeadlines,
  receiveNativeDiagnosticCapability,
  sendNativeDiagnosticCapability,
  type NativeDiagnosticIpc,
  type NativeDiagnosticScheduler
} from "../../apps/tui/src/bootstrap/native-diagnostic-handoff.js";

const PROTOCOL = "agentlab-native-diagnostics/v1";

describe("native diagnostic capability handoff", () => {
  it("gives the non-renewable renderer ceiling explicit margin over both parent phases", () => {
    expect(nativeDiagnosticHandoffDeadlines.rendererReceiveMilliseconds).toBeGreaterThan(
      nativeDiagnosticHandoffDeadlines.bootstrapReadyMilliseconds +
        nativeDiagnosticHandoffDeadlines.bootstrapDeliveryMilliseconds
    );
    expect(nativeDiagnosticHandoffDeadlines.schedulerMarginMilliseconds).toBe(500);
  });

  it("lets queued readiness win over a due readiness timer", () => {
    const scheduler = new ManualScheduler();
    const bootstrap = new FakeDiagnosticIpc();
    sendNativeDiagnosticCapability(bootstrap, "a".repeat(64), scheduler);

    scheduler.advance(nativeDiagnosticHandoffDeadlines.bootstrapReadyMilliseconds);
    expect(bootstrap.disconnectCalls).toBe(0);
    bootstrap.emitMessage(readyMessage());
    scheduler.runImmediateTurn();

    expect(bootstrap.sent).toEqual([capabilityMessage("a".repeat(64))]);
    expect(bootstrap.disconnectCalls).toBe(0);
    bootstrap.emitDisconnect();
    expect(bootstrap.listenerCount()).toBe(0);
    expect(scheduler.pending()).toBe(0);
  });

  it("lets a queued capability win over a due receive timer", async () => {
    const scheduler = new ManualScheduler();
    const renderer = new FakeDiagnosticIpc();
    const capability = "b".repeat(64);
    const received = receiveNativeDiagnosticCapability(renderer, scheduler);

    scheduler.advance(nativeDiagnosticHandoffDeadlines.rendererReceiveMilliseconds);
    expect(renderer.listenerCount()).toBe(2);
    renderer.emitMessage(capabilityMessage(capability));
    scheduler.runImmediateTurn();

    await expect(received).resolves.toBe(capability);
    expect(renderer.listenerCount()).toBe(0);
    expect(scheduler.pending()).toBe(0);
  });

  it("allows readiness at its edge followed by the full delivery phase", async () => {
    const scheduler = new ManualScheduler();
    const bootstrap = new FakeDiagnosticIpc();
    const renderer = new FakeDiagnosticIpc();
    const capability = "c".repeat(64);
    const received = receiveNativeDiagnosticCapability(renderer, scheduler);
    sendNativeDiagnosticCapability(bootstrap, capability, scheduler);

    scheduler.advance(nativeDiagnosticHandoffDeadlines.bootstrapReadyMilliseconds);
    bootstrap.emitMessage(readyMessage());
    expect(bootstrap.sent).toEqual([capabilityMessage(capability)]);

    scheduler.advance(nativeDiagnosticHandoffDeadlines.bootstrapDeliveryMilliseconds);
    renderer.emitMessage(capabilityMessage(capability));
    bootstrap.emitDisconnect();
    scheduler.runImmediateTurn();

    await expect(received).resolves.toBe(capability);
    expect(bootstrap.disconnectCalls).toBe(0);
    expect(bootstrap.listenerCount()).toBe(0);
    expect(renderer.listenerCount()).toBe(0);
    expect(scheduler.pending()).toBe(0);
  });

  it("settles a silent readiness timeout after exactly one immediate turn", () => {
    const scheduler = new ManualScheduler();
    const bootstrap = new FakeDiagnosticIpc();
    sendNativeDiagnosticCapability(bootstrap, "d".repeat(64), scheduler);

    scheduler.advance(nativeDiagnosticHandoffDeadlines.bootstrapReadyMilliseconds);
    expect(bootstrap.disconnectCalls).toBe(0);
    scheduler.runImmediateTurn();
    expect(bootstrap.disconnectCalls).toBe(1);
    scheduler.runImmediateTurn();

    expect(bootstrap.disconnectCalls).toBe(1);
    expect(bootstrap.listenerCount()).toBe(0);
    expect(scheduler.pending()).toBe(0);
  });

  it.each(["callback error", "synchronous throw"] as const)(
    "cleans the sender exactly once after a %s",
    (failure) => {
      const scheduler = new ManualScheduler();
      const bootstrap = new FakeDiagnosticIpc();
      bootstrap.sendError = failure === "callback error" ? new Error("closed channel") : null;
      bootstrap.throwOnSend = failure === "synchronous throw";
      sendNativeDiagnosticCapability(bootstrap, "e".repeat(64), scheduler);

      bootstrap.emitMessage(readyMessage());
      bootstrap.emitMessage(readyMessage());
      scheduler.advance(10_000);
      scheduler.runImmediateTurn();

      expect(bootstrap.disconnectCalls).toBe(1);
      expect(bootstrap.listenerCount()).toBe(0);
      expect(scheduler.pending()).toBe(0);
    }
  );

  it.each(["callback error", "synchronous throw"] as const)(
    "settles and cleans the receiver after a ready-send %s",
    async (failure) => {
      const scheduler = new ManualScheduler();
      const renderer = new FakeDiagnosticIpc();
      renderer.sendError = failure === "callback error" ? new Error("closed channel") : null;
      renderer.throwOnSend = failure === "synchronous throw";
      const settled = vi.fn();
      const received = receiveNativeDiagnosticCapability(renderer, scheduler).then((value) => {
        settled(value);
      });

      renderer.emitMessage(capabilityMessage("f".repeat(64)));
      scheduler.advance(10_000);
      scheduler.runImmediateTurn();
      await received;

      expect(settled).toHaveBeenCalledOnce();
      expect(settled).toHaveBeenCalledWith(undefined);
      expect(renderer.listenerCount()).toBe(0);
      expect(scheduler.pending()).toBe(0);
    }
  );

  it("rejects malformed and out-of-order messages with exact cleanup", async () => {
    const invalidMessages = [
      { ...readyMessage(), extra: "field" },
      { protocol: "agentlab-native-diagnostics/v2", type: "ready" },
      capabilityMessage("0".repeat(64))
    ];

    for (const message of invalidMessages) {
      const scheduler = new ManualScheduler();
      const bootstrap = new FakeDiagnosticIpc();
      sendNativeDiagnosticCapability(bootstrap, "1".repeat(64), scheduler);
      bootstrap.emitMessage(message);
      expect(bootstrap.disconnectCalls).toBe(1);
      expect(bootstrap.sent).toEqual([]);
      expect(bootstrap.listenerCount()).toBe(0);
      expect(scheduler.pending()).toBe(0);
    }

    const scheduler = new ManualScheduler();
    const renderer = new FakeDiagnosticIpc();
    const received = receiveNativeDiagnosticCapability(renderer, scheduler);
    renderer.emitMessage({ ...capabilityMessage("2".repeat(64)), extra: "field" });
    await expect(received).resolves.toBeUndefined();
    expect(renderer.listenerCount()).toBe(0);
    expect(scheduler.pending()).toBe(0);
  });

  it("rejects duplicate readiness without sending or settling twice", () => {
    const scheduler = new ManualScheduler();
    const bootstrap = new FakeDiagnosticIpc();
    sendNativeDiagnosticCapability(bootstrap, "3".repeat(64), scheduler);

    bootstrap.emitMessage(readyMessage());
    bootstrap.emitMessage(readyMessage());
    bootstrap.emitDisconnect();
    scheduler.advance(10_000);
    scheduler.runImmediateTurn();

    expect(bootstrap.sent).toEqual([capabilityMessage("3".repeat(64))]);
    expect(bootstrap.disconnectCalls).toBe(1);
    expect(bootstrap.listenerCount()).toBe(0);
    expect(scheduler.pending()).toBe(0);
  });

  it("settles a malformed receive exactly once despite later channel activity", async () => {
    const scheduler = new ManualScheduler();
    const renderer = new FakeDiagnosticIpc();
    const settled = vi.fn();
    const received = receiveNativeDiagnosticCapability(renderer, scheduler).then((value) => {
      settled(value);
    });

    renderer.emitMessage({ protocol: PROTOCOL, type: "ready" });
    renderer.emitMessage(capabilityMessage("4".repeat(64)));
    renderer.emitDisconnect();
    scheduler.advance(10_000);
    scheduler.runImmediateTurn();
    await received;

    expect(settled).toHaveBeenCalledOnce();
    expect(settled).toHaveBeenCalledWith(undefined);
    expect(renderer.listenerCount()).toBe(0);
    expect(scheduler.pending()).toBe(0);
  });
});

function capabilityMessage(capability: string): Readonly<Record<string, string>> {
  return { capability, protocol: PROTOCOL, type: "capability" };
}

function readyMessage(): Readonly<Record<string, string>> {
  return { protocol: PROTOCOL, type: "ready" };
}

class FakeDiagnosticIpc implements NativeDiagnosticIpc {
  public connected = true;
  public disconnectCalls = 0;
  public sendError: Error | null = null;
  public readonly sent: Readonly<Record<string, string>>[] = [];
  public throwOnSend = false;
  readonly #disconnectListeners = new Set<() => void>();
  readonly #exitListeners = new Set<() => void>();
  readonly #messageListeners = new Set<(message: unknown) => void>();

  public disconnect(): void {
    this.disconnectCalls += 1;
    this.connected = false;
  }

  public emitDisconnect(): void {
    this.connected = false;
    for (const listener of [...this.#disconnectListeners]) listener();
  }

  public emitMessage(message: unknown): void {
    for (const listener of [...this.#messageListeners]) listener(message);
  }

  public listenerCount(): number {
    return this.#disconnectListeners.size + this.#exitListeners.size + this.#messageListeners.size;
  }

  public offDisconnect(listener: () => void): void {
    this.#disconnectListeners.delete(listener);
  }

  public offExit(listener: () => void): void {
    this.#exitListeners.delete(listener);
  }

  public offMessage(listener: (message: unknown) => void): void {
    this.#messageListeners.delete(listener);
  }

  public onDisconnect(listener: () => void): void {
    this.#disconnectListeners.add(listener);
  }

  public onExit(listener: () => void): void {
    this.#exitListeners.add(listener);
  }

  public onMessage(listener: (message: unknown) => void): void {
    this.#messageListeners.add(listener);
  }

  public send(
    message: Readonly<Record<string, string>>,
    callback: (error: Error | null) => void
  ): void {
    if (this.throwOnSend) throw new Error("synchronous send failure");
    this.sent.push(message);
    callback(this.sendError);
  }
}

interface ManualTask {
  readonly callback: () => void;
  readonly deadline?: number;
  active: boolean;
}

class ManualScheduler implements NativeDiagnosticScheduler {
  #now = 0;
  readonly #immediates: ManualTask[] = [];
  readonly #timers: ManualTask[] = [];

  public advance(milliseconds: number): void {
    const target = this.#now + milliseconds;
    for (;;) {
      const next = this.#timers
        .filter((task) => task.active && (task.deadline ?? Infinity) <= target)
        .sort((left, right) => (left.deadline ?? 0) - (right.deadline ?? 0))[0];
      if (next === undefined) break;
      this.#now = next.deadline ?? this.#now;
      next.active = false;
      next.callback();
    }
    this.#now = target;
  }

  public clearImmediate(handle: unknown): void {
    this.deactivate(handle);
  }

  public clearTimeout(handle: unknown): void {
    this.deactivate(handle);
  }

  public pending(): number {
    return [...this.#timers, ...this.#immediates].filter(({ active }) => active).length;
  }

  public runImmediateTurn(): void {
    const turn = this.#immediates.filter(({ active }) => active);
    for (const task of turn) task.active = false;
    for (const task of turn) task.callback();
  }

  public setImmediate(callback: () => void): unknown {
    const task = { active: true, callback };
    this.#immediates.push(task);
    return task;
  }

  public setTimeout(callback: () => void, milliseconds: number): unknown {
    const task = { active: true, callback, deadline: this.#now + milliseconds };
    this.#timers.push(task);
    return task;
  }

  private deactivate(handle: unknown): void {
    if (typeof handle === "object" && handle !== null && "active" in handle) {
      (handle as ManualTask).active = false;
    }
  }
}
