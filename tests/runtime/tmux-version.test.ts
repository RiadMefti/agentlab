import { describe, expect, it } from "vitest";

import {
  assertSupportedTmuxVersion,
  minimumTmuxVersion
} from "../../packages/runtime/src/infrastructure/tmux/tmux-version.js";

describe("tmux compatibility policy", () => {
  it("accepts the oldest supported tmux release and later patch suffixes", () => {
    expect(assertSupportedTmuxVersion(() => "tmux 3.2\n")).toEqual({ major: 3, minor: 2 });
    expect(assertSupportedTmuxVersion(() => "tmux 3.2a\n")).toEqual({ major: 3, minor: 2 });
    expect(assertSupportedTmuxVersion(() => "tmux 4.0\n")).toEqual({ major: 4, minor: 0 });
    expect(minimumTmuxVersion).toBe("3.2");
  });

  it("rejects older and unparseable versions before runtime construction", () => {
    expect(() => assertSupportedTmuxVersion(() => "tmux 3.1c\n")).toThrow(
      "requires tmux 3.2 or newer"
    );
    expect(() => assertSupportedTmuxVersion(() => "not tmux\n")).toThrow("Unable to parse");
    expect(() =>
      assertSupportedTmuxVersion(() => {
        throw new Error("ENOENT");
      })
    ).toThrow("tmux -V could not run");
  });
});
