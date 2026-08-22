import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it } from "vitest";

import type { Conversation } from "@orchestrator/contracts";

import { SqliteConversationRepository } from "../../apps/server/src/infrastructure/persistence/sqlite-conversation-repository.js";
import { buildCaptainSessionName } from "../../apps/server/src/domain/agent-session-name.js";
import { TEST_CONVERSATION_ID } from "../helpers/fakes.js";
import { LONG_BEDROCK_MODEL_ID } from "../helpers/model-ids.js";

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
      model: LONG_BEDROCK_MODEL_ID,
      reasoning: null,
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

  it("migrates version-one rows without losing their selections", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-orchestrator-migration-"));
    temporaryRoots.push(root);
    const databasePath = join(root, "conversations.sqlite");
    const legacy = new DatabaseSync(databasePath);
    legacy.exec(`
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        provider TEXT NOT NULL CHECK (provider IN ('codex', 'claude', 'opencode')),
        model TEXT,
        reasoning TEXT NOT NULL CHECK (
          reasoning IN ('minimal', 'low', 'medium', 'high', 'xhigh', 'max')
        ),
        captain_session_name TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX conversations_updated_at_idx
        ON conversations(updated_at DESC, id DESC);
      PRAGMA user_version = 1;
    `);
    legacy
      .prepare(`INSERT INTO conversations VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        TEST_CONVERSATION_ID,
        "Legacy conversation",
        "codex",
        LONG_BEDROCK_MODEL_ID,
        "xhigh",
        buildCaptainSessionName(TEST_CONVERSATION_ID, "codex"),
        "2026-08-20T12:00:00.000Z",
        "2026-08-20T12:00:00.000Z"
      );
    legacy.close();

    const repository = new SqliteConversationRepository(databasePath);
    try {
      await expect(repository.findById(TEST_CONVERSATION_ID)).resolves.toMatchObject({
        model: LONG_BEDROCK_MODEL_ID,
        reasoning: "xhigh"
      });
    } finally {
      repository.close();
    }

    const migrated = new DatabaseSync(databasePath);
    try {
      expect(
        (migrated.prepare("PRAGMA user_version").get() as { user_version: number }).user_version
      ).toBe(2);
    } finally {
      migrated.close();
    }
  });
});
