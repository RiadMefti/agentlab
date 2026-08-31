import { randomUUID } from "node:crypto";

import { FactoryCanaryAuthorityService } from "./application/factory-canary-authority-service.js";
import {
  LocalFactoryCanaryAuthorityCoordinator,
  type LocalFactoryCanaryAuthorityRuntime
} from "./application/local-factory-canary-authority-coordinator.js";
import { cleanupFailedRuntimeConstruction } from "./application/local-runtime-construction.js";
import { RuntimeRepositoryOwner } from "./application/runtime-repository-owner.js";
import { RuntimeTaskOwner } from "./application/runtime-task-owner.js";
import type { LocalFactoryCanaryAuthorityConfig } from "./infrastructure/filesystem/local-factory-canary-authority-config.js";
import { NodeFactoryDocumentCodec } from "./infrastructure/persistence/canonical-factory-documents.js";
import { isUnconfirmedDatabaseInitializationError } from "./infrastructure/persistence/sqlite-database.js";
import { SqliteFactoryCanaryRepository } from "./infrastructure/persistence/sqlite-factory-canary-repository.js";
import { SqliteFactoryEvaluationRepository } from "./infrastructure/persistence/sqlite-factory-evaluation-repository.js";
import { acquireSqliteWriterLease } from "./infrastructure/persistence/sqlite-writer-lease.js";

export interface LocalFactoryCanaryAuthorityOptions {
  readonly databasePath: string;
  readonly operatorId: string;
  readonly now?: () => string;
  readonly createId?: () => string;
}

/** Composes only human cohort issuance; execution, broker, merge, and release are unreachable. */
export function createLocalFactoryCanaryAuthority(
  options: LocalFactoryCanaryAuthorityOptions
): LocalFactoryCanaryAuthorityRuntime {
  const writerLease = acquireSqliteWriterLease(options.databasePath);
  const repositories = new RuntimeRepositoryOwner();
  try {
    if (writerLease.databasePath === ":memory:") {
      throw new Error("The local factory canary authority requires a durable SQLite database.");
    }
    const documents = new NodeFactoryDocumentCodec();
    const evaluations = repositories.track(
      new SqliteFactoryEvaluationRepository(writerLease.databasePath, { documents })
    );
    const canaries = repositories.track(
      new SqliteFactoryCanaryRepository(writerLease.databasePath, {
        documents,
        evaluations
      })
    );
    const authority = new FactoryCanaryAuthorityService({
      operatorId: options.operatorId,
      evaluations,
      canaries,
      documents,
      now: options.now ?? (() => new Date().toISOString()),
      createId: options.createId ?? randomUUID
    });
    return new LocalFactoryCanaryAuthorityCoordinator({
      authority,
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
      throw new AggregateError(
        failures,
        "Factory canary authority construction and cleanup failed."
      );
    }
    throw error;
  }
}

export function createConfiguredLocalFactoryCanaryAuthority(
  config: LocalFactoryCanaryAuthorityConfig
): LocalFactoryCanaryAuthorityRuntime {
  return createLocalFactoryCanaryAuthority(config);
}

export type {
  FactoryCanaryAuthorityCommand,
  FactoryCanaryAuthorityResult
} from "./application/factory-canary-authority-service.js";
export type {
  FactoryCanaryAuthorityCommandPort,
  LocalFactoryCanaryAuthorityRuntime
} from "./application/local-factory-canary-authority-coordinator.js";
export {
  loadLocalFactoryCanaryAuthorityConfig,
  type LocalFactoryCanaryAuthorityConfig
} from "./infrastructure/filesystem/local-factory-canary-authority-config.js";
export { loadLocalFactoryCanaryRequest } from "./infrastructure/filesystem/local-factory-canary-request.js";
