import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { sessionHistoryLimit, terminalScrollbackBytes } from "@agentlab/contracts";

describe("terminal retention units", () => {
  it("keeps tmux lines distinct from OpenTUI's bounded byte budget", () => {
    expect(sessionHistoryLimit).toBe(20_000);
    expect(terminalScrollbackBytes).toBe(16 * 1024 * 1024);
    expect(terminalScrollbackBytes).toBeGreaterThan(sessionHistoryLimit * 400);
  });

  it("keeps the product claims and OpenTUI configuration byte-correct", () => {
    const read = (path: string): string => readFileSync(resolve(process.cwd(), path), "utf8");
    const readme = read("README.md");
    const architecture = read("docs/architecture.md");
    const panel = read("apps/tui/src/components/terminal-panel.tsx");

    expect(readme).toContain("16 MiB scrollback byte budget");
    expect(readme).toContain("20,000 history lines");
    expect(architecture).toContain("16 MiB scrollback byte budget");
    expect(architecture).toMatch(/20,000-line\s+history limit/u);
    expect(panel).toContain("maxScrollback={terminalScrollbackBytes}");
    expect(`${readme}\n${architecture}`).not.toContain("20,000-line scrollback");
  });
});
