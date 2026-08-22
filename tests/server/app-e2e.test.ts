import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { FastifyInstance } from "fastify";

import { ConversationService } from "../../apps/server/src/application/conversation-service.js";
import { buildApp } from "../../apps/server/src/app.js";
import { SqliteConversationRepository } from "../../apps/server/src/infrastructure/persistence/sqlite-conversation-repository.js";
import { NodeCommandRunner } from "../../apps/server/src/infrastructure/process/command-runner.js";
import { BinaryLocator } from "../../apps/server/src/infrastructure/providers/binary-locator.js";
import { codexCaptainLauncher } from "../../apps/server/src/infrastructure/providers/captain-launchers.js";
import { LocalProviderCatalog } from "../../apps/server/src/infrastructure/providers/local-provider-catalog.js";
import { TmuxSessionRuntime } from "../../apps/server/src/infrastructure/tmux/tmux-session-runtime.js";

describe.runIf(process.env.AO_RUN_TMUX_INTEGRATION === "1")(
  "application composition with real tmux",
  () => {
    const temporaryRoots: string[] = [];
    let app: FastifyInstance | null = null;
    let repository: SqliteConversationRepository | null = null;
    let runtime: TmuxSessionRuntime | null = null;
    let captainSessionName: string | null = null;

    afterEach(async () => {
      if (captainSessionName !== null && runtime !== null) {
        await runtime.kill(captainSessionName);
      }
      captainSessionName = null;
      await app?.close();
      app = null;
      repository?.close();
      repository = null;
      runtime = null;
      for (const root of temporaryRoots.splice(0)) {
        rmSync(root, { force: true, recursive: true });
      }
    });

    it("creates, saves, and discovers one real captain from the HTTP boundary", async () => {
      const root = mkdtempSync(join(tmpdir(), "agent-orchestrator-e2e-"));
      temporaryRoots.push(root);
      const fakeCodex = join(root, "codex");
      writeFileSync(
        fakeCodex,
        '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "codex-cli test"; exit 0; fi\necho "fake captain ready"\nwhile IFS= read -r line; do echo "received:$line"; done\n'
      );
      chmodSync(fakeCodex, 0o755);

      const runner = new NodeCommandRunner();
      const socketPath = join(root, "tmux.sock");
      runtime = new TmuxSessionRuntime(runner, socketPath);
      repository = new SqliteConversationRepository(join(root, "conversations.sqlite"));
      const providers = new LocalProviderCatalog(
        [codexCaptainLauncher],
        new BinaryLocator(runner, { AO_CODEX_BIN: fakeCodex }, root),
        runner
      );
      const conversations = new ConversationService({
        repository,
        providers,
        sessions: runtime,
        workspace: root
      });
      app = await buildApp({
        conversations,
        terminal: { attach: () => undefined },
        workspace: root,
        webRoot: null
      });

      const created = await app.inject({
        method: "POST",
        url: "/api/conversations",
        payload: {
          prompt: "Coordinate the test",
          provider: "codex",
          reasoning: "high"
        }
      });
      expect(created.statusCode).toBe(201);
      const conversation = created.json<{ id: string; captainSessionName: string }>();
      const sessionName = conversation.captainSessionName;
      captainSessionName = sessionName;

      const saved = await app.inject({ method: "GET", url: "/api/conversations" });
      expect(saved.json()).toMatchObject({ conversations: [{ id: conversation.id }] });

      const sessions = await app.inject({
        method: "GET",
        url: `/api/conversations/${conversation.id}/sessions`
      });
      expect(sessions.json()).toMatchObject({
        sessions: [
          {
            name: sessionName,
            role: "captain",
            provider: "codex",
            status: "running"
          }
        ]
      });

      await expect
        .poll(async () => {
          const { stdout } = await runner.run("tmux", [
            "-S",
            socketPath,
            "capture-pane",
            "-p",
            "-S",
            "-200",
            "-t",
            `${sessionName}:`
          ]);
          return stdout;
        })
        .toContain("fake captain ready");
    });
  }
);
