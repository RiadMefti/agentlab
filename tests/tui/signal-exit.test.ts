import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import {
  exitCodeForSignal,
  installSignalExitStatusHandlers,
  rendererExitStatusSignals
} from "../../apps/tui/src/bootstrap/signal-exit.js";

describe("terminal signal exit status", () => {
  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
    ["SIGQUIT", 131]
  ] as const)("maps %s to conventional status %i", (signal, status) => {
    expect(exitCodeForSignal(signal)).toBe(status);
  });

  it("guards an unknown signal instead of producing NaN", () => {
    expect(exitCodeForSignal("SIG_NOT_REAL")).toBe(1);
  });

  it("covers abnormal cleanup signals and removes every installed listener", () => {
    const emitter = new EventEmitter();
    const statuses: number[] = [];
    const remove = installSignalExitStatusHandlers(emitter, (status) => statuses.push(status));

    expect(rendererExitStatusSignals).toContain("SIGABRT");
    expect(rendererExitStatusSignals).toContain("SIGBUS");
    emitter.emit("SIGABRT");
    expect(statuses).toEqual([134]);
    remove();
    emitter.emit("SIGABRT");
    expect(statuses).toEqual([134]);
  });
});
