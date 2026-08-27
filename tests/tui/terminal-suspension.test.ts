import { describe, expect, it, vi } from "vitest";

import {
  createTerminalSuspendHandlers,
  renderWithTerminalCleanup
} from "../../apps/tui/src/bootstrap/terminal-suspension.js";

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

  it("removes suspend handlers and destroys the renderer when mounting throws", () => {
    const removeHandlers = vi.fn();
    const destroyRenderer = vi.fn();

    expect(() => {
      renderWithTerminalCleanup(
        () => {
          throw new Error("render failed");
        },
        removeHandlers,
        destroyRenderer
      );
    }).toThrow("render failed");
    expect(removeHandlers).toHaveBeenCalledOnce();
    expect(destroyRenderer).toHaveBeenCalledOnce();
  });

  it("retains both render and terminal cleanup failures", () => {
    expect(() => {
      renderWithTerminalCleanup(
        () => {
          throw new Error("render failed");
        },
        vi.fn(),
        () => {
          throw new Error("destroy failed");
        }
      );
    }).toThrow(
      expect.objectContaining({
        errors: [
          expect.objectContaining({ message: "render failed" }),
          expect.objectContaining({ message: "destroy failed" })
        ]
      })
    );
  });
});
