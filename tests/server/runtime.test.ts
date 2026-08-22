import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createOrchestratorServer } from "../../apps/server/src/runtime.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("orchestrator server composition", () => {
  it("creates a closable server for embedded desktop use", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-orchestrator-runtime-"));
    temporaryRoots.push(root);
    const server = await createOrchestratorServer({
      databasePath: join(root, "orchestrator.sqlite"),
      workspace: root,
      webRoot: null
    });

    const response = await server.inject({ method: "GET", url: "/api/health" });
    expect(response.json()).toEqual({ status: "ok" });
    await server.close();
  });
});
