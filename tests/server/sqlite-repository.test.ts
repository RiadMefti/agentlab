import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Conversation } from "@orchestrator/contracts";

import { SqliteConversationRepository } from "../../apps/server/src/infrastructure/persistence/sqlite-conversation-repository.js";
import { buildCaptainSessionName } from "../../apps/server/src/domain/agent-session-name.js";
import { TEST_CONVERSATION_ID } from "../helpers/fakes.js";

const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("SqliteConversationRepository", () => {
  it("round-trips conversation metadata", async () => {
    const repository = new SqliteConversationRepository(":memory:");
    const conversation: Conversation = {
      id: TEST_CONVERSATION_ID,
      title: "Refresh race",
      provider: "codex",
      model: null,
      reasoning: "high",
      captainSessionName: buildCaptainSessionName(TEST_CONVERSATION_ID, "codex"),
      createdAt: "2026-08-21T12:00:00.000Z",
      updatedAt: "2026-08-21T12:00:00.000Z"
    };

    try {
      await repository.create(conversation);
      await expect(repository.findById(conversation.id)).resolves.toEqual(conversation);
      await expect(repository.list()).resolves.toEqual([conversation]);
      await expect(repository.findById("22222222-2222-4222-8222-222222222222")).resolves.toBeNull();
    } finally {
      repository.close();
    }
  });

  it("creates the local metadata database with owner-only permissions", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-orchestrator-db-"));
    temporaryRoots.push(root);
    const databasePath = join(root, "conversations.sqlite");
    const repository = new SqliteConversationRepository(databasePath);

    try {
      expect(statSync(databasePath).mode & 0o777).toBe(0o600);
    } finally {
      repository.close();
    }
  });
});
