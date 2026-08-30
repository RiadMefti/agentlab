import {
  buildCaptainSessionName,
  buildWorkerSessionName
} from "../../packages/runtime/src/domain/agent-session-name.js";
import { newConversationReservationSchema } from "../../packages/runtime/src/domain/conversation-record.js";
import { NodeCommandRunner } from "../../packages/runtime/src/infrastructure/process/command-runner.js";
import { SqliteConversationRepository } from "../../packages/runtime/src/infrastructure/persistence/sqlite-conversation-repository.js";
import { TmuxSessionRuntime } from "../../packages/runtime/src/infrastructure/tmux/tmux-session-runtime.js";

const [databasePath, socketPath, phase, conversationId, ownershipNonce, workspacePath] =
  process.argv.slice(2);
if (
  databasePath === undefined ||
  socketPath === undefined ||
  phase === undefined ||
  conversationId === undefined ||
  ownershipNonce === undefined ||
  workspacePath === undefined
) {
  throw new Error("Missing crash-lifecycle fixture arguments.");
}

const repository = new SqliteConversationRepository(databasePath);
const sessions = new TmuxSessionRuntime(new NodeCommandRunner(), socketPath);
const captainSessionName = buildCaptainSessionName(conversationId, "codex");
const record = newConversationReservationSchema.parse({
  id: conversationId,
  title: "Crash recovery fixture",
  workspacePath,
  provider: "codex",
  model: null,
  reasoning: null,
  captainSessionName,
  createdAt: "2026-08-30T12:00:00.000Z",
  updatedAt: "2026-08-30T12:00:00.000Z",
  lifecycleState: "creating",
  ownershipMode: "nonce",
  ownershipNonce
});
await repository.create(record);

if (phase !== "creating-empty") {
  const sessionNonce = phase === "creating-conflict" ? crypto.randomUUID() : ownershipNonce;
  await sessions.createCaptain({
    name: captainSessionName,
    cwd: workspacePath,
    command: {
      executable: process.execPath,
      args: ["-e", "setInterval(() => undefined, 1000)"]
    },
    ownership: { mode: "nonce", nonce: sessionNonce }
  });
  if (phase === "creating-captain-worker" || phase === "deleting") {
    await sessions.createWorker({
      name: buildWorkerSessionName(conversationId, "codex", "crash-worker"),
      cwd: workspacePath,
      command: {
        executable: process.execPath,
        args: ["-e", "setInterval(() => undefined, 1000)"]
      },
      ownership: { mode: "nonce", nonce: ownershipNonce }
    });
  }
}

if (phase === "deleting") {
  await repository.transitionLifecycle({
    id: conversationId,
    expected: "creating",
    next: "active"
  });
  await repository.transitionLifecycle({
    id: conversationId,
    expected: "active",
    next: "deleting"
  });
}

process.kill(process.pid, "SIGKILL");
throw new Error("The crash fixture did not terminate.");
