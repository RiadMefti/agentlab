import { describe, expect, it, vi } from "vitest";

import {
  appendPendingOutput,
  closePtyResources,
  stringEnvironment,
  type PendingTerminalOutput
} from "../../packages/runtime/src/infrastructure/terminal/bun-terminal.js";

const emptyOutput: PendingTerminalOutput = { chunks: [], bytes: 0 };

describe("Bun terminal resource helpers", () => {
  it("keeps pending output within its byte budget, including one oversized chunk", () => {
    const first = appendPendingOutput(emptyOutput, "abc", 5);
    const second = appendPendingOutput(first, "de", 5);
    const evicted = appendPendingOutput(second, "fg", 5);
    const oversized = appendPendingOutput(evicted, "0123456789", 5);
    const utf8 = appendPendingOutput(emptyOutput, "ééé", 5);

    expect(evicted).toEqual({ chunks: ["de", "fg"], bytes: 4 });
    expect(oversized).toEqual({ chunks: ["56789"], bytes: 5 });
    expect(utf8).toEqual({ chunks: ["éé"], bytes: 4 });
  });

  it("closes the terminal even when killing its subprocess throws", () => {
    const terminal = { closed: false, close: vi.fn() };
    const process = {
      kill: vi.fn(() => {
        throw new Error("already exited");
      })
    };

    expect(() => {
      closePtyResources(process, terminal);
    }).toThrow("already exited");
    expect(terminal.close).toHaveBeenCalledTimes(1);
  });

  it("never passes bootstrap diagnostics capabilities into spawned tmux clients", () => {
    expect(
      stringEnvironment({
        AGENTLAB_DIAGNOSTIC_LOG: "/private/tui.log",
        AGENTLAB_TUI_DIAGNOSTIC_CAPABILITY: "opaque-capability",
        AGENTLAB_TUI_RUNTIME: "single-use-token",
        PATH: "/usr/bin"
      })
    ).toEqual({ PATH: "/usr/bin" });
  });
});
