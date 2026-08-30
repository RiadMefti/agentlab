import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createLocalAgentLab } from "../../packages/runtime/src/local-runtime.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("local runtime composition", () => {
  it("preserves the public runtime shape and gates commands behind empty reconciliation", async () => {
    const runtime = createLocalAgentLab({ databasePath: ":memory:" });

    expect(runtime.commands).toBeDefined();
    expect(runtime.openTerminal).toBeTypeOf("function");
    expect(runtime.close).toBeTypeOf("function");
    await expect(runtime.commands.listConversations()).resolves.toEqual([]);
    const close = runtime.close;
    await expect(close()).resolves.toBeUndefined();
    await expect(runtime.close()).resolves.toBeUndefined();
  });

  it("rejects a second runtime for the same canonical database and permits it after close", async () => {
    const root = mkdtempSync(join(tmpdir(), "agentlab-runtime-"));
    temporaryRoots.push(root);
    const databasePath = join(root, "state.sqlite");
    const first = createLocalAgentLab({ databasePath });
    try {
      expect(() => createLocalAgentLab({ databasePath })).toThrow("already owns");
    } finally {
      await first.close();
    }

    const next = createLocalAgentLab({ databasePath });
    await expect(next.close()).resolves.toBeUndefined();
  });
});
