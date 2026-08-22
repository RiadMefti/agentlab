import { describe, expect, it } from "vitest";

import { ShutdownGate } from "../../apps/desktop/src/shutdown-gate.js";

describe("desktop shutdown gate", () => {
  it("suppresses nested window-close quits until graceful shutdown finishes", () => {
    const shutdown = new ShutdownGate();

    expect(shutdown.shouldQuitAfterWindowsClose("linux")).toBe(true);
    expect(shutdown.begin()).toBe(true);
    expect(shutdown.started).toBe(true);
    expect(shutdown.shouldQuitAfterWindowsClose("linux")).toBe(false);
    expect(shutdown.begin()).toBe(false);
  });

  it("keeps macOS alive after its last window closes", () => {
    expect(new ShutdownGate().shouldQuitAfterWindowsClose("darwin")).toBe(false);
  });
});
