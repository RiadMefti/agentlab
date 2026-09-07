import { DatabaseSync } from "node:sqlite";

import type { FactoryControlName } from "@agentlab/contracts";

import type { FactoryAuthorityState } from "../../domain/factory-task-repository.js";
import type { FactoryDocumentCodec } from "../../domain/factory-documents.js";
import { NodeFactoryDocumentCodec } from "./canonical-factory-documents.js";
import { openSqliteDatabase, type SqliteDatabaseOptions } from "./sqlite-database.js";

interface ControlRow {
  readonly event_digest: unknown;
  readonly control_name: unknown;
  readonly enabled: unknown;
  readonly event_json: unknown;
}

export interface SqliteFactoryControlStateReaderOptions extends SqliteDatabaseOptions {
  readonly documents?: FactoryDocumentCodec;
}

/** Read-only projection for credential-bearing consumers that need only kill-switch state. */
export class SqliteFactoryControlStateReader {
  readonly #database: DatabaseSync;
  readonly #documents: FactoryDocumentCodec;

  public constructor(databasePath: string, options: SqliteFactoryControlStateReaderOptions = {}) {
    this.#database = openSqliteDatabase(databasePath, options);
    this.#documents = options.documents ?? new NodeFactoryDocumentCodec();
  }

  public state(): Promise<FactoryAuthorityState> {
    return Promise.resolve({
      scheduler: this.#latest("scheduler"),
      prBroker: this.#latest("pr-broker")
    });
  }

  public close(): void {
    this.#database.close();
  }

  #latest(control: FactoryControlName): boolean {
    const row = this.#database
      .prepare(
        `SELECT event_digest, control_name, enabled, event_json
         FROM factory_control_events WHERE control_name = ? ORDER BY sequence DESC LIMIT 1`
      )
      .get(control) as ControlRow | undefined;
    if (row === undefined) return false;
    const event = this.#documents.controlEvent(parseJson(row.event_json));
    if (
      row.event_digest !== event.digest ||
      row.control_name !== event.value.control ||
      row.enabled !== (event.value.enabled ? 1 : 0) ||
      event.value.control !== control
    ) {
      throw new Error("Stored factory authority state failed immutable validation.");
    }
    return event.value.enabled;
  }
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") throw new Error("Stored factory control event is not text.");
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error("Stored factory control event is invalid JSON.", { cause: error });
  }
}
