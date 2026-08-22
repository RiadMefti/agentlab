import { DatabaseSync } from "node:sqlite";
import { chmodSync } from "node:fs";

import { conversationSchema, type Conversation } from "@orchestrator/contracts";

import type { ConversationRepository } from "../../domain/conversation-repository.js";
import { migrate } from "./migrations.js";

interface ConversationRow {
  readonly id: unknown;
  readonly title: unknown;
  readonly provider: unknown;
  readonly model: unknown;
  readonly reasoning: unknown;
  readonly captain_session_name: unknown;
  readonly created_at: unknown;
  readonly updated_at: unknown;
}

const SELECT_COLUMNS = `
  id,
  title,
  provider,
  model,
  reasoning,
  captain_session_name,
  created_at,
  updated_at
`;

export class SqliteConversationRepository implements ConversationRepository {
  readonly #database: DatabaseSync;

  public constructor(databasePath: string) {
    this.#database = new DatabaseSync(databasePath);
    if (databasePath !== ":memory:") chmodSync(databasePath, 0o600);
    migrate(this.#database);
  }

  public list(): Promise<readonly Conversation[]> {
    const rows = this.#database
      .prepare(
        `SELECT ${SELECT_COLUMNS}
         FROM conversations
         ORDER BY updated_at DESC, id DESC`
      )
      .all() as unknown as ConversationRow[];
    return Promise.resolve(rows.map(toConversation));
  }

  public findById(id: string): Promise<Conversation | null> {
    const row = this.#database
      .prepare(
        `SELECT ${SELECT_COLUMNS}
         FROM conversations
         WHERE id = ?`
      )
      .get(id) as ConversationRow | undefined;
    return Promise.resolve(row === undefined ? null : toConversation(row));
  }

  public create(conversation: Conversation): Promise<void> {
    this.#database
      .prepare(
        `INSERT INTO conversations (
          id,
          title,
          provider,
          model,
          reasoning,
          captain_session_name,
          created_at,
          updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        conversation.id,
        conversation.title,
        conversation.provider,
        conversation.model,
        conversation.reasoning,
        conversation.captainSessionName,
        conversation.createdAt,
        conversation.updatedAt
      );
    return Promise.resolve();
  }

  public close(): void {
    this.#database.close();
  }
}

function toConversation(row: ConversationRow): Conversation {
  return conversationSchema.parse({
    id: row.id,
    title: row.title,
    provider: row.provider,
    model: row.model,
    reasoning: row.reasoning,
    captainSessionName: row.captain_session_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  });
}
