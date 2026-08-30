import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import { ConversationService } from "../../packages/runtime/src/application/conversation-service.js";
import { buildCaptainSessionName } from "../../packages/runtime/src/domain/agent-session-name.js";
import { SqliteConversationRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-conversation-repository.js";
import { NodeCommandRunner } from "../../packages/runtime/src/infrastructure/process/command-runner.js";
import { TmuxCaptainPolicyRenderer } from "../../packages/runtime/src/infrastructure/tmux/captain-policy.js";
import { TmuxSessionRuntime } from "../../packages/runtime/src/infrastructure/tmux/tmux-session-runtime.js";
import { StaticProviderCatalog, StaticWorkspacePathResolver } from "../helpers/fakes.js";

const describeIntegration =
  process.env.AGENTLAB_RUN_TMUX_INTEGRATION === "1" ? describe : describe.skip;
const fixturePath = fileURLToPath(
  new URL("../fixtures/crash-lifecycle-runtime.ts", import.meta.url)
);
const temporaryRoots: string[] = [];
const sockets: string[] = [];

afterEach(async () => {
  const runner = new NodeCommandRunner();
  for (const socket of sockets.splice(0)) {
    try {
      await runner.run("tmux", ["-S", socket, "kill-server"]);
    } catch {
      // A successful recovery normally removes the final session and server first.
    }
    rmSync(socket, { force: true });
  }
  for (const root of temporaryRoots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describeIntegration("durable lifecycle crash recovery", () => {
  for (const phase of [
    "creating-empty",
    "creating-captain",
    "creating-captain-worker",
    "deleting"
  ] as const) {
    it(`reconciles a process crash at ${phase}`, async () => {
      const fixture = crashFixture(phase);
      const repository = new SqliteConversationRepository(fixture.databasePath);
      const sessions = new TmuxSessionRuntime(new NodeCommandRunner(), fixture.socketPath);
      const service = conversationService(repository, sessions);

      try {
        await expect(service.reconcilePending()).resolves.toBeUndefined();
        await expect(repository.findById(fixture.conversationId)).resolves.toBeNull();
        await expect(sessions.list(fixture.conversationId)).resolves.toEqual([]);
      } finally {
        repository.close();
      }
    });
  }

  it("retains the durable journal and foreign captain after a crash-time nonce conflict", async () => {
    const fixture = crashFixture("creating-conflict");
    const repository = new SqliteConversationRepository(fixture.databasePath);
    const sessions = new TmuxSessionRuntime(new NodeCommandRunner(), fixture.socketPath);
    const service = conversationService(repository, sessions);

    try {
      await expect(service.reconcilePending()).rejects.toThrow(
        "startup reconciliation failed closed"
      );
      await expect(repository.findById(fixture.conversationId)).resolves.toMatchObject({
        lifecycleState: "creating",
        ownershipNonce: fixture.ownershipNonce
      });
      await expect(
        sessions.inspectOwnership(buildCaptainSessionName(fixture.conversationId, "codex"))
      ).resolves.toEqual({
        status: "present",
        nonce: expect.not.stringMatching(fixture.ownershipNonce)
      });
    } finally {
      repository.close();
    }
  });
});

function crashFixture(phase: string) {
  const root = mkdtempSync(join(tmpdir(), "agentlab-crash-recovery-"));
  temporaryRoots.push(root);
  const databasePath = join(root, "agentlab.sqlite");
  const socketPath = join(root, "tmux.sock");
  sockets.push(socketPath);
  const conversationId = randomUUID();
  const ownershipNonce = randomUUID();
  const result = spawnSync(
    "bun",
    [fixturePath, databasePath, socketPath, phase, conversationId, ownershipNonce, root],
    { encoding: "utf8", timeout: 10_000 }
  );
  expect(result.signal).toBe("SIGKILL");
  expect(result.error).toBeUndefined();
  return { databasePath, socketPath, conversationId, ownershipNonce };
}

function conversationService(
  repository: SqliteConversationRepository,
  sessions: TmuxSessionRuntime
): ConversationService {
  return new ConversationService({
    repository,
    sessions,
    providers: new StaticProviderCatalog(),
    workspacePaths: new StaticWorkspacePathResolver(),
    captainPolicy: new TmuxCaptainPolicyRenderer(),
    now: () => new Date("2026-08-30T12:00:00.000Z"),
    createId: randomUUID,
    createOwnershipNonce: randomUUID
  });
}
