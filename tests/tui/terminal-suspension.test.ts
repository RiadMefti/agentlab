import { describe, expect, it, vi } from "vitest";

import { createTerminalSuspendHandlers } from "../../apps/tui/src/bootstrap/terminal-suspension.js";

describe("terminal suspension", () => {
  it("restores terminal modes before stopping and repaints once after continue", () => {
    const order: string[] = [];
    const handlers = createTerminalSuspendHandlers(
      {
        suspend: () => order.push("suspend"),
        resume: () => order.push("resume")
      },
      () => order.push("stop"),
      vi.fn()
    );

    handlers.onContinue();
    handlers.onSuspend();
    handlers.onSuspend();
    handlers.onContinue();
    handlers.onContinue();

    expect(order).toEqual(["suspend", "stop", "resume"]);
  });

  it("still stops and records failures without writing to the terminal", () => {
    const stop = vi.fn();
    const report = vi.fn();
    const handlers = createTerminalSuspendHandlers(
      {
        suspend: () => {
          throw new Error("suspend broke");
        },
        resume: () => {
          throw new Error("resume broke");
        }
      },
      stop,
      report
    );

    handlers.onSuspend();
    handlers.onContinue();

    expect(stop).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenNthCalledWith(1, "Terminal suspend failed: Error: suspend broke");
    expect(report).toHaveBeenNthCalledWith(2, "Terminal resume failed: Error: resume broke");
  });
});
