import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { FastifyInstance } from "fastify";

import { ConversationService } from "../../apps/server/src/application/conversation-service.js";
import type { ProviderCapabilityDiscovery } from "../../apps/server/src/domain/provider-capability-discovery.js";
import { buildApp } from "../../apps/server/src/app.js";
import { SqliteConversationRepository } from "../../apps/server/src/infrastructure/persistence/sqlite-conversation-repository.js";
import { NodeCommandRunner } from "../../apps/server/src/infrastructure/process/command-runner.js";
import { BinaryLocator } from "../../apps/server/src/infrastructure/providers/binary-locator.js";
import { codexAgentLauncher } from "../../apps/server/src/infrastructure/providers/agent-launchers.js";
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
    let workerSessionName: string | null = null;

    afterEach(async () => {
      if (workerSessionName !== null && runtime !== null) {
        await runtime.kill(workerSessionName);
      }
      workerSessionName = null;
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

    it("runs the captain and explicit worker lifecycle from the HTTP boundary", async () => {
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
        [codexAgentLauncher],
        [
          {
            id: "codex",
            discover: () =>
              Promise.resolve({
                defaultModel: "gpt-test",
                models: [
                  {
                    id: "gpt-test",
                    label: "GPT Test",
                    description: null,
                    defaultReasoning: "high",
                    reasoningOptions: [{ id: "high", label: "High" }]
                  }
                ]
              })
          } satisfies ProviderCapabilityDiscovery
        ],
        new BinaryLocator(runner, { AO_CODEX_BIN: fakeCodex }, root),
        runner,
        { workspace: root }
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

      const workerCreated = await app.inject({
        method: "POST",
        url: `/api/conversations/${conversation.id}/sessions`,
        payload: {
          label: "Review Tests",
          prompt: "Review the test suite",
          provider: "codex"
        }
      });
      expect(workerCreated.statusCode).toBe(201);
      workerSessionName = workerCreated.json<{ sessionName: string }>().sessionName;
      await expect(runtime.exists(workerSessionName)).resolves.toBe(true);

      const duplicateWorker = await app.inject({
        method: "POST",
        url: `/api/conversations/${conversation.id}/sessions`,
        payload: {
          label: "Review Tests",
          prompt: "Duplicate task",
          provider: "codex"
        }
      });
      expect(duplicateWorker.statusCode).toBe(409);
      expect(duplicateWorker.json()).toMatchObject({ error: { code: "CONFLICT" } });

      const withWorker = await app.inject({
        method: "GET",
        url: `/api/conversations/${conversation.id}/sessions`
      });
      expect(withWorker.json()).toMatchObject({
        sessions: [
          { name: captainSessionName, role: "captain" },
          { name: workerSessionName, role: "worker", label: "Review Tests" }
        ]
      });

      const workerDeleted = await app.inject({
        method: "DELETE",
        url: `/api/conversations/${conversation.id}/sessions/${encodeURIComponent(workerSessionName)}`
      });
      expect(workerDeleted.statusCode).toBe(204);
      await expect(runtime.exists(workerSessionName)).resolves.toBe(false);
      workerSessionName = null;
    });
  }
);
