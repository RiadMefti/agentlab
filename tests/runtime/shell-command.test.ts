import { describe, expect, it } from "vitest";

import {
  quotePosix,
  renderShellCommand
} from "../../packages/runtime/src/infrastructure/tmux/shell-command.js";

describe("POSIX command rendering", () => {
  it("quotes shell metacharacters and apostrophes", () => {
    expect(quotePosix("plain/path-1")).toBe("plain/path-1");
    expect(quotePosix("a; touch /tmp/nope")).toBe("'a; touch /tmp/nope'");
    expect(quotePosix("it's fine")).toBe("'it'\"'\"'s fine'");
  });

  it("renders each argument as an independent token", () => {
    expect(
      renderShellCommand({
        executable: "/tmp/provider cli",
        args: ["--prompt", "fix; $(touch /tmp/nope)", "x=y z"],
        environment: { AO_TEST: "one two" }
      })
    ).toBe("AO_TEST='one two' '/tmp/provider cli' --prompt 'fix; $(touch /tmp/nope)' 'x=y z'");
  });

  it("rejects invalid environment names", () => {
    expect(() =>
      renderShellCommand({
        executable: "tool",
        args: [],
        environment: { "BAD-NAME": "value" }
      })
    ).toThrow(/Invalid environment key/u);
  });
});
