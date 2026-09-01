import { DatabaseSync } from "node:sqlite";

import type { FactoryOwnedPullRequestIndex } from "../../domain/factory-external-pull-request-source.js";
import { openSqliteDatabase, type SqliteDatabaseOptions } from "./sqlite-database.js";

export class SqliteFactoryOwnedPullRequestIndex implements FactoryOwnedPullRequestIndex {
  readonly #database: DatabaseSync;

  public constructor(databasePath: string, options: SqliteDatabaseOptions = {}) {
    this.#database = openSqliteDatabase(databasePath, options);
  }

  public contains(repositoryId: string, pullRequestNumber: number): Promise<boolean> {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/u.test(repositoryId)) {
      throw new Error("Factory-owned PR lookup repository is invalid.");
    }
    if (!Number.isSafeInteger(pullRequestNumber) || pullRequestNumber < 1) {
      throw new Error("Factory-owned PR lookup number is invalid.");
    }
    const row = this.#database
      .prepare(
        `SELECT 1 AS present
         FROM factory_pull_request_dispatch_events AS event
         JOIN factory_pull_request_dispatches AS dispatch
           ON dispatch.dispatch_id = event.dispatch_id
         WHERE dispatch.repository_id = ?
           AND event.kind = 'remote-observed'
           AND event.pull_request_number = ?
         LIMIT 1`
      )
      .get(repositoryId, pullRequestNumber) as { readonly present?: unknown } | undefined;
    return Promise.resolve(row?.present === 1);
  }

  public close(): void {
    this.#database.close();
  }
}
