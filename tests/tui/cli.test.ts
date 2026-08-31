import { describe, expect, it } from "vitest";

import {
  assertSupportedTerminalRuntime,
  helpText,
  parseCliArguments
} from "../../apps/tui/src/cli.js";

describe("terminal CLI", () => {
  it("always opens the project chooser when no arguments are supplied", () => {
    expect(parseCliArguments([])).toEqual({ kind: "run" });
  });

  it("rejects positional workspaces so startup cannot bypass the project chooser", () => {
    expect(() => parseCliArguments(["/tmp/project"])).toThrow("Usage: agentlab");
  });

  it("recognizes informational flags without requiring a TTY", () => {
    expect(parseCliArguments(["--help"])).toEqual({ kind: "help" });
    expect(parseCliArguments(["-v"])).toEqual({ kind: "version" });
  });

  it("recognizes only the exact read-only factory broker preflight command", () => {
    expect(
      parseCliArguments([
        "factory",
        "broker-preflight",
        "--config",
        "/private/agentlab/broker.json"
      ])
    ).toEqual({
      kind: "factory-broker-preflight",
      configPath: "/private/agentlab/broker.json"
    });
    expect(() =>
      parseCliArguments(["factory", "broker-preflight", "--config", "broker.json"])
    ).toThrow(/Usage/u);
    expect(() =>
      parseCliArguments(["factory", "broker-preflight", "--enable", "/private/broker.json"])
    ).toThrow(/Usage/u);
  });

  it("documents the broker preflight and child-mouse emergency kill switch", () => {
    expect(helpText).toContain("factory broker-preflight --config");
    expect(helpText).toContain("AGENTLAB_DISABLE_MOUSE");
    expect(helpText).toContain("keep mouse input local");
  });

  it("rejects unknown flags and ambiguous arguments", () => {
    expect(() => parseCliArguments(["--listen"])).toThrow("Usage");
    expect(() => parseCliArguments(["one", "two"])).toThrow("Usage");
  });

  it("fails clearly before OpenTUI loads for an unsupported musl build", () => {
    expect(() => {
      assertSupportedTerminalRuntime("linux", { OPENTUI_LIBC: "musl" });
    }).toThrow("requires glibc");
    expect(() => {
      assertSupportedTerminalRuntime("linux", { OPENTUI_LIBC: "glibc" });
    }).not.toThrow();
    expect(() => {
      assertSupportedTerminalRuntime("darwin", { OPENTUI_LIBC: "musl" });
    }).not.toThrow();
  });
});
