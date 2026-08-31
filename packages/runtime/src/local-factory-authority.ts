import { randomUUID } from "node:crypto";

import { FactoryAuthorityOperator } from "./application/factory-authority-operator.js";
import {
  LocalFactoryAuthorityCoordinator,
  type LocalFactoryAuthorityRuntime
} from "./application/local-factory-authority-coordinator.js";
import { cleanupFailedRuntimeConstruction } from "./application/local-runtime-construction.js";
import { RuntimeRepositoryOwner } from "./application/runtime-repository-owner.js";
import { RuntimeTaskOwner } from "./application/runtime-task-owner.js";
import type { LocalFactoryAuthorityConfig } from "./infrastructure/filesystem/local-factory-authority-config.js";
import { NodeFactoryDocumentCodec } from "./infrastructure/persistence/canonical-factory-documents.js";
import { isUnconfirmedDatabaseInitializationError } from "./infrastructure/persistence/sqlite-database.js";
import { SqliteFactoryRepository } from "./infrastructure/persistence/sqlite-factory-repository.js";
import { acquireSqliteWriterLease } from "./infrastructure/persistence/sqlite-writer-lease.js";

export interface LocalFactoryAuthorityOptions {
  readonly databasePath: string;
  readonly operatorId: string;
  readonly now?: () => string;
  readonly createId?: () => string;
}

/** Composes only local human authority state; no model, worker, broker, or remote adapter. */
export function createLocalFactoryAuthority(
  options: LocalFactoryAuthorityOptions
): LocalFactoryAuthorityRuntime {
  const writerLease = acquireSqliteWriterLease(options.databasePath);
  const repositories = new RuntimeRepositoryOwner();
  try {
    if (writerLease.databasePath === ":memory:") {
      throw new Error("The local factory authority runtime requires a durable SQLite database.");
    }
    const documents = new NodeFactoryDocumentCodec();
    const controls = repositories.track(
      new SqliteFactoryRepository(writerLease.databasePath, { documents })
    );
    const operator = new FactoryAuthorityOperator({
      controls,
      documents,
      operatorId: options.operatorId,
      now: options.now ?? (() => new Date().toISOString()),
      createId: options.createId ?? randomUUID
    });
    return new LocalFactoryAuthorityCoordinator({
      operator,
      tasks: new RuntimeTaskOwner(),
      repositories,
      writerLease
    });
  } catch (error: unknown) {
    const failures: unknown[] = [
      error,
      ...cleanupFailedRuntimeConstruction(
        repositories,
        writerLease,
        !isUnconfirmedDatabaseInitializationError(error)
      )
    ];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Factory authority construction and cleanup failed.");
    }
    throw error;
  }
}

export function createConfiguredLocalFactoryAuthority(
  config: LocalFactoryAuthorityConfig
): LocalFactoryAuthorityRuntime {
  return createLocalFactoryAuthority(config);
}

export type {
  FactoryAuthorityCommandPort,
  LocalFactoryAuthorityRuntime
} from "./application/local-factory-authority-coordinator.js";
export type {
  FactoryAuthorityInspection,
  FactoryBrokerAuthorityCommand,
  FactoryBrokerAuthorityChange
} from "./application/factory-authority-operator.js";
export {
  loadLocalFactoryAuthorityConfig,
  type LocalFactoryAuthorityConfig
} from "./infrastructure/filesystem/local-factory-authority-config.js";
