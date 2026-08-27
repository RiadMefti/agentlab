const CAPABILITY_PATTERN = /^[0-9a-f]{64}$/u;
const PROTOCOL = "agentlab-native-diagnostics/v1";
const CAPABILITY_MESSAGE_TYPE = "capability";
const READY_MESSAGE_TYPE = "ready";
const BOOTSTRAP_READY_MILLISECONDS = 5_000;
const BOOTSTRAP_DELIVERY_MILLISECONDS = 1_000;
const SCHEDULER_MARGIN_MILLISECONDS = 500;

/**
 * The renderer's non-renewable receive ceiling spans both parent phases plus explicit scheduler
 * margin. Successful handoffs remain event-driven and do not wait for any deadline.
 */
export const nativeDiagnosticHandoffDeadlines = Object.freeze({
  bootstrapDeliveryMilliseconds: BOOTSTRAP_DELIVERY_MILLISECONDS,
  bootstrapReadyMilliseconds: BOOTSTRAP_READY_MILLISECONDS,
  rendererReceiveMilliseconds:
    BOOTSTRAP_READY_MILLISECONDS + BOOTSTRAP_DELIVERY_MILLISECONDS + SCHEDULER_MARGIN_MILLISECONDS,
  schedulerMarginMilliseconds: SCHEDULER_MARGIN_MILLISECONDS
});

export interface NativeDiagnosticIpc {
  readonly connected: boolean;
  disconnect(): void;
  offDisconnect(listener: () => void): void;
  offExit(listener: () => void): void;
  offMessage(listener: (message: unknown) => void): void;
  onDisconnect(listener: () => void): void;
  onExit(listener: () => void): void;
  onMessage(listener: (message: unknown) => void): void;
  send(message: Readonly<Record<string, string>>, callback: (error: Error | null) => void): void;
}

export interface NativeDiagnosticScheduler {
  clearImmediate(handle: unknown): void;
  clearTimeout(handle: unknown): void;
  setImmediate(callback: () => void): unknown;
  setTimeout(callback: () => void, milliseconds: number): unknown;
}

export function receiveNativeDiagnosticCapability(
  channel: NativeDiagnosticIpc,
  scheduler: NativeDiagnosticScheduler = systemScheduler
): Promise<string | undefined> {
  return new Promise((resolveCapability) => {
    let settled = false;
    const finish = (capability?: string): void => {
      if (settled) return;
      settled = true;
      deadline.cancel();
      channel.offDisconnect(onChannelClosed);
      channel.offMessage(onMessage);
      resolveCapability(capability);
    };
    const onChannelClosed = (): void => {
      finish();
    };
    const onMessage = (message: unknown): void => {
      if (!isCapabilityMessage(message)) {
        finish();
        return;
      }
      finish(message.capability);
    };
    const deadline = startDeferredDeadline(
      scheduler,
      nativeDiagnosticHandoffDeadlines.rendererReceiveMilliseconds,
      finish
    );
    channel.onDisconnect(onChannelClosed);
    channel.onMessage(onMessage);
    try {
      if (!channel.connected) {
        finish();
        return;
      }
      channel.send(readyMessage(), (error) => {
        if (error !== null) finish();
      });
    } catch {
      finish();
    }
  });
}

export function sendNativeDiagnosticCapability(
  channel: NativeDiagnosticIpc,
  capability: string,
  scheduler: NativeDiagnosticScheduler = systemScheduler
): void {
  let state: "awaiting-ready" | "delivering" | "finished" = "awaiting-ready";
  let deliveryDeadline: DeferredDeadline | undefined;
  const finishChannel = (): void => {
    if (state === "finished") return;
    state = "finished";
    readinessDeadline.cancel();
    deliveryDeadline?.cancel();
    channel.offDisconnect(onChannelClosed);
    channel.offExit(onChannelClosed);
    channel.offMessage(onMessage);
  };
  const closeChannel = (): void => {
    try {
      if (channel.connected) channel.disconnect();
    } catch {
      // A renderer may exit before the bootstrap closes its private handoff.
    } finally {
      finishChannel();
    }
  };
  const onChannelClosed = (): void => {
    // Closure acknowledges one-shot channel consumption, never successful authorization.
    finishChannel();
  };
  const onMessage = (message: unknown): void => {
    if (state !== "awaiting-ready" || !isReadyMessage(message)) {
      closeChannel();
      return;
    }
    state = "delivering";
    readinessDeadline.cancel();
    deliveryDeadline = startDeferredDeadline(
      scheduler,
      nativeDiagnosticHandoffDeadlines.bootstrapDeliveryMilliseconds,
      closeChannel
    );
    try {
      channel.send(capabilityMessage(capability), (error) => {
        if (error !== null) closeChannel();
      });
    } catch {
      closeChannel();
    }
  };
  const readinessDeadline = startDeferredDeadline(
    scheduler,
    nativeDiagnosticHandoffDeadlines.bootstrapReadyMilliseconds,
    closeChannel
  );
  channel.onMessage(onMessage);
  channel.onDisconnect(onChannelClosed);
  channel.onExit(onChannelClosed);
}

interface DeferredDeadline {
  cancel(): void;
}

function startDeferredDeadline(
  scheduler: NativeDiagnosticScheduler,
  milliseconds: number,
  onDeadline: () => void
): DeferredDeadline {
  let immediate: unknown;
  let timer: unknown = scheduler.setTimeout(() => {
    timer = undefined;
    immediate = scheduler.setImmediate(() => {
      immediate = undefined;
      onDeadline();
    });
  }, milliseconds);
  return {
    cancel(): void {
      if (timer !== undefined) scheduler.clearTimeout(timer);
      if (immediate !== undefined) scheduler.clearImmediate(immediate);
      timer = undefined;
      immediate = undefined;
    }
  };
}

function capabilityMessage(capability: string): Readonly<Record<string, string>> {
  return { capability, protocol: PROTOCOL, type: CAPABILITY_MESSAGE_TYPE };
}

function readyMessage(): Readonly<Record<string, string>> {
  return { protocol: PROTOCOL, type: READY_MESSAGE_TYPE };
}

function isCapabilityMessage(
  message: unknown
): message is { readonly capability: string; readonly protocol: string; readonly type: string } {
  return (
    hasExactKeys(message, ["capability", "protocol", "type"]) &&
    message.protocol === PROTOCOL &&
    message.type === CAPABILITY_MESSAGE_TYPE &&
    typeof message.capability === "string" &&
    CAPABILITY_PATTERN.test(message.capability)
  );
}

function isReadyMessage(message: unknown): boolean {
  return (
    hasExactKeys(message, ["protocol", "type"]) &&
    message.protocol === PROTOCOL &&
    message.type === READY_MESSAGE_TYPE
  );
}

function hasExactKeys(
  value: unknown,
  expectedKeys: readonly string[]
): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === expectedKeys.length &&
    keys.every((key) => typeof key === "string" && expectedKeys.includes(key))
  );
}

const systemScheduler: NativeDiagnosticScheduler = {
  clearImmediate: (handle) => {
    clearImmediate(handle as NodeJS.Immediate);
  },
  clearTimeout: (handle) => {
    clearTimeout(handle as NodeJS.Timeout);
  },
  setImmediate: (callback) => setImmediate(callback),
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds)
};
