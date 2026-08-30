import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { afterEach, describe, expect, it, vi } from "vitest";

import { buildCaptainSessionName } from "../../packages/runtime/src/domain/agent-session-name.js";
import type { ConversationLifecycleTransition } from "../../packages/runtime/src/domain/conversation-repository.js";
import {
  newConversationReservationSchema,
  storedConversationSchema,
  type NewConversationReservation
} from "../../packages/runtime/src/domain/conversation-record.js";
import { latestSchemaVersion } from "../../packages/runtime/src/infrastructure/persistence/migrations.js";
import {
  SqliteConversationRepository,
  UnconfirmedDatabaseInitializationError
} from "../../packages/runtime/src/infrastructure/persistence/sqlite-conversation-repository.js";
import { TEST_CONVERSATION_ID } from "../helpers/fakes.js";
import { LONG_BEDROCK_MODEL_ID } from "../helpers/model-ids.js";

const TEST_NONCE = "22222222-2222-4222-8222-222222222222";
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("SqliteConversationRepository", () => {
  it("round-trips internal metadata and applies compare-and-set transitions", async () => {
    const repository = new SqliteConversationRepository(":memory:");
    const record = newConversationReservationSchema.parse({
      ...conversationFields("/work/project"),
      lifecycleState: "creating",
      ownershipMode: "nonce",
      ownershipNonce: TEST_NONCE
    });

    try {
      await repository.create(record);
      await expect(repository.findById(record.id)).resolves.toEqual(record);
      await expect(repository.findByWorkspacePath("/work/project")).resolves.toEqual(record);
      await expect(repository.list()).resolves.toEqual([record]);

      await expect(
        repository.transitionLifecycle({ id: record.id, expected: "active", next: "deleting" })
      ).resolves.toBeNull();
      const active = await repository.transitionLifecycle({
        id: record.id,
        expected: "creating",
        next: "active"
      });
      expect(active).toEqual({ ...record, lifecycleState: "active" });
      await expect(repository.deleteIfLifecycle(record.id, "creating")).resolves.toBe(false);
      await expect(
        repository.transitionLifecycle({ id: record.id, expected: "active", next: "deleting" })
      ).resolves.toMatchObject({ lifecycleState: "deleting" });
      await expect(repository.deleteIfLifecycle(record.id, "deleting")).resolves.toBe(true);
      await expect(repository.findById(record.id)).resolves.toBeNull();
    } finally {
      repository.close();
    }
  });

  it("creates the local metadata database with owner-only permissions", () => {
    const { databasePath } = temporaryDatabase("agentlab-db-");
    const repository = new SqliteConversationRepository(databasePath);

    try {
      expect(statSync(databasePath).mode & 0o777).toBe(0o600);
    } finally {
      repository.close();
    }
  });

  it("rejects invalid stored ownership and captain identity at the read boundary", async () => {
    const { databasePath } = temporaryDatabase("agentlab-corrupt-db-");
    const repository = new SqliteConversationRepository(databasePath);
    const record = newConversationReservationSchema.parse({
      ...conversationFields("/work/protected"),
      lifecycleState: "creating",
      ownershipMode: "nonce",
      ownershipNonce: TEST_NONCE
    });

    try {
      await repository.create(record);
      await repository.transitionLifecycle({
        id: record.id,
        expected: "creating",
        next: "active"
      });
      const database = new DatabaseSync(databasePath);
      try {
        database
          .prepare("UPDATE conversations SET captain_session_name = ? WHERE id = ?")
          .run(
            buildCaptainSessionName("33333333-3333-4333-8333-333333333333", "claude"),
            record.id
          );
      } finally {
        database.close();
      }

      expect(() => repository.findById(record.id)).toThrow(
        "Persisted captain session does not match its conversation owner."
      );
    } finally {
      repository.close();
    }
  });

  it("rejects migration-only insertion authority and every forbidden lifecycle edge", () => {
    const repository = new SqliteConversationRepository(":memory:");
    const legacy = storedConversationSchema.parse({
      ...conversationFields("/work/legacy"),
      lifecycleState: "active",
      ownershipMode: "legacy-name",
      ownershipNonce: null
    });
    const forbidden: readonly (readonly [string, string])[] = [
      ["creating", "deleting"],
      ["creating", "legacy-unlinked"],
      ["active", "creating"],
      ["active", "legacy-unlinked"],
      ["deleting", "creating"],
      ["deleting", "active"],
      ["deleting", "legacy-unlinked"],
      ["legacy-unlinked", "creating"],
      ["legacy-unlinked", "active"]
    ];

    try {
      expect(() => repository.create(legacy as unknown as NewConversationReservation)).toThrow();
      for (const [expected, next] of forbidden) {
        expect(() =>
          repository.transitionLifecycle({
            id: TEST_CONVERSATION_ID,
            expected,
            next
          } as unknown as ConversationLifecycleTransition)
        ).toThrow("Illegal durable conversation lifecycle transition");
      }
    } finally {
      repository.close();
    }
  });

  it("reports construction as unconfirmed when migration and connection close both fail", () => {
    const migrationFailure = new Error("migration failed");
    const closeFailure = new Error("database close failed");
    const database = {
      close: vi.fn(() => {
        throw closeFailure;
      })
    } as unknown as DatabaseSync;

    const failure = (() => {
      try {
        new SqliteConversationRepository(":memory:", {
          createDatabase: () => database,
          migrateDatabase: () => {
            throw migrationFailure;
          }
        });
      } catch (error: unknown) {
        return error;
      }
      return null;
    })();

    expect(failure).toBeInstanceOf(UnconfirmedDatabaseInitializationError);
    expect((failure as UnconfirmedDatabaseInitializationError).errors).toEqual([
      migrationFailure,
      closeFailure
    ]);
    expect(database.close).toHaveBeenCalledOnce();
  });

  for (const version of [1, 2, 3] as const) {
    it(`migrates version ${String(version)} rows without data loss`, async () => {
      const { databasePath } = temporaryDatabase(`agentlab-v${String(version)}-`);
      createHistoricalDatabase(databasePath, version);

      const repository = new SqliteConversationRepository(databasePath);
      try {
        await expect(repository.findById(TEST_CONVERSATION_ID)).resolves.toMatchObject({
          id: TEST_CONVERSATION_ID,
          model: LONG_BEDROCK_MODEL_ID,
          reasoning: version === 1 ? "xhigh" : null,
          workspacePath: version === 3 ? "/work/legacy" : null,
          lifecycleState: version === 3 ? "active" : "legacy-unlinked",
          ownershipMode: "legacy-name",
          ownershipNonce: null
        });
      } finally {
        repository.close();
      }

      const migrated = new DatabaseSync(databasePath);
      try {
        expect(
          (migrated.prepare("PRAGMA user_version").get() as { user_version: number }).user_version
        ).toBe(latestSchemaVersion);
      } finally {
        migrated.close();
      }
    });
  }
});

function conversationFields(workspacePath: string | null) {
  return {
    id: TEST_CONVERSATION_ID,
    title: "Refresh race",
    workspacePath,
    provider: "codex" as const,
    model: LONG_BEDROCK_MODEL_ID,
    reasoning: null,
    captainSessionName: buildCaptainSessionName(TEST_CONVERSATION_ID, "codex"),
    createdAt: "2026-08-21T12:00:00.000Z",
    updatedAt: "2026-08-21T12:00:00.000Z"
  };
}

function temporaryDatabase(prefix: string): { readonly databasePath: string } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return { databasePath: join(root, "conversations.sqlite") };
}

function createHistoricalDatabase(databasePath: string, version: 1 | 2 | 3): void {
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      provider TEXT NOT NULL CHECK (provider IN ('codex', 'claude', 'opencode')),
      model TEXT,
      reasoning TEXT ${version === 1 ? "NOT NULL" : ""},
      captain_session_name TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
      ${version === 3 ? ", workspace_path TEXT" : ""}
    ) STRICT;
    CREATE INDEX conversations_updated_at_idx
      ON conversations(updated_at DESC, id DESC);
    ${
      version === 3
        ? "CREATE UNIQUE INDEX conversations_workspace_path_idx ON conversations(workspace_path) WHERE workspace_path IS NOT NULL;"
        : ""
    }
    PRAGMA user_version = ${String(version)};
  `);
  const values = [
    TEST_CONVERSATION_ID,
    "Legacy conversation",
    "codex",
    LONG_BEDROCK_MODEL_ID,
    version === 1 ? "xhigh" : null,
    buildCaptainSessionName(TEST_CONVERSATION_ID, "codex"),
    "2026-08-20T12:00:00.000Z",
    "2026-08-20T12:00:00.000Z",
    ...(version === 3 ? ["/work/legacy"] : [])
  ];
  database
    .prepare(`INSERT INTO conversations VALUES (${values.map(() => "?").join(", ")})`)
    .run(...values);
  database.close();
}
