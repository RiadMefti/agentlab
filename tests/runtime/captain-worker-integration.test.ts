import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";

import { afterEach, describe, expect, it } from "vitest";

import { ConversationService } from "../../packages/runtime/src/application/conversation-service.js";
import {
  buildCaptainSessionName,
  buildWorkerSessionName
} from "../../packages/runtime/src/domain/agent-session-name.js";
import { storedConversationSchema } from "../../packages/runtime/src/domain/conversation-record.js";
import { NodeCommandRunner } from "../../packages/runtime/src/infrastructure/process/command-runner.js";
import { TmuxCaptainPolicyRenderer } from "../../packages/runtime/src/infrastructure/tmux/captain-policy.js";
import { renderShellCommand } from "../../packages/runtime/src/infrastructure/tmux/shell-command.js";
import { TmuxSessionRuntime } from "../../packages/runtime/src/infrastructure/tmux/tmux-session-runtime.js";
import {
  MemoryConversationRepository,
  StaticProviderCatalog,
  StaticWorkspacePathResolver
} from "../helpers/fakes.js";

const describeIntegration =
  process.env.AGENTLAB_RUN_TMUX_INTEGRATION === "1" ? describe : describe.skip;
const runner = new NodeCommandRunner();
const sockets: string[] = [];

afterEach(async () => {
  for (const socketPath of sockets.splice(0)) {
    try {
      await runner.run("tmux", ["-S", socketPath, "kill-server"]);
    } catch {
      // A successful deletion may already have stopped the private server.
    }
    rmSync(socketPath, { force: true });
  }
});

describeIntegration("captain-created worker ownership", () => {
  it("executes the rendered nonce policy shape and authorizes service deletion", async () => {
    const fixture = await activeFixture("nonce");
    const policy = new TmuxCaptainPolicyRenderer().render({
      conversationId: fixture.conversationId,
      workspace: process.cwd(),
      ownershipNonce: fixture.nonce,
      providerExecutables: { codex: process.execPath }
    });
    const worker = buildWorkerSessionName(fixture.conversationId, "codex", "captain-created");
    await createRawWorker(
      fixture.socketPath,
      worker,
      policy.environment.AGENTLAB_WORKSPACE ?? "",
      policy.environment.AGENTLAB_SESSION_OWNERSHIP
    );

    await expect(fixture.service.listSessions(fixture.conversationId)).resolves.toEqual([
      expect.objectContaining({ name: fixture.captain }),
      expect.objectContaining({ name: worker, role: "worker" })
    ]);
    await expect(
      fixture.service.deleteWorker(fixture.conversationId, worker)
    ).resolves.toBeUndefined();
    await expect(fixture.sessions.exists(worker)).resolves.toBe(false);
  });

  it("preserves exact-name deletion for a migrated legacy captain-created worker", async () => {
    const fixture = await activeFixture("legacy-name");
    const worker = buildWorkerSessionName(fixture.conversationId, "claude", "legacy-created");
    await createRawWorker(fixture.socketPath, worker, process.cwd());

    await expect(fixture.service.listSessions(fixture.conversationId)).resolves.toEqual([
      expect.objectContaining({ name: fixture.captain }),
      expect.objectContaining({ name: worker, role: "worker" })
    ]);
    await expect(
      fixture.service.deleteWorker(fixture.conversationId, worker)
    ).resolves.toBeUndefined();
    await expect(fixture.sessions.exists(worker)).resolves.toBe(false);
  });
});

async function activeFixture(ownershipMode: "nonce" | "legacy-name") {
  const socketPath = `/tmp/agentlab-captain-worker-${randomUUID()}.sock`;
  sockets.push(socketPath);
  const conversationId = randomUUID();
  const nonce = randomUUID();
  const captain = buildCaptainSessionName(conversationId, "codex");
  const sessions = new TmuxSessionRuntime(runner, socketPath);
  const ownership =
    ownershipMode === "nonce"
      ? ({ mode: "nonce", nonce } as const)
      : ({ mode: "legacy-name" } as const);
  await sessions.createCaptain({
    name: captain,
    cwd: process.cwd(),
    command: {
      executable: process.execPath,
      args: ["-e", "setInterval(() => undefined, 1000)"]
    },
    ownership
  });
  const repository = new MemoryConversationRepository();
  repository.conversations.push(
    storedConversationSchema.parse({
      id: conversationId,
      title: "Captain worker fixture",
      workspacePath: process.cwd(),
      provider: "codex",
      model: null,
      reasoning: null,
      captainSessionName: captain,
      createdAt: "2026-08-30T12:00:00.000Z",
      updatedAt: "2026-08-30T12:00:00.000Z",
      lifecycleState: "active",
      ownershipMode,
      ownershipNonce: ownershipMode === "nonce" ? nonce : null
    })
  );
  const service = new ConversationService({
    repository,
    sessions,
    providers: new StaticProviderCatalog(),
    workspacePaths: new StaticWorkspacePathResolver(),
    captainPolicy: new TmuxCaptainPolicyRenderer(),
    now: () => new Date("2026-08-30T12:00:00.000Z"),
    createId: randomUUID,
    createOwnershipNonce: randomUUID
  });
  return { captain, conversationId, nonce, service, sessions, socketPath };
}

async function createRawWorker(
  socketPath: string,
  name: string,
  workspace: string,
  nonce?: string
): Promise<void> {
  const ownershipArguments =
    nonce === undefined ? [] : ["-e", `AGENTLAB_SESSION_OWNERSHIP=${nonce}`];
  await runner.run("tmux", [
    "-S",
    socketPath,
    "new-session",
    "-d",
    "-s",
    name,
    ...ownershipArguments,
    "-c",
    workspace,
    renderShellCommand({
      executable: process.execPath,
      args: ["-e", "setInterval(() => undefined, 1000)"]
    })
  ]);
}
