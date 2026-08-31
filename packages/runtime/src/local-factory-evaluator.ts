import { randomUUID } from "node:crypto";

import { FactoryEvaluationService } from "./application/factory-evaluation-service.js";
import {
  LocalFactoryEvaluatorCoordinator,
  type LocalFactoryEvaluatorRuntime
} from "./application/local-factory-evaluator-coordinator.js";
import { cleanupFailedRuntimeConstruction } from "./application/local-runtime-construction.js";
import { RuntimeRepositoryOwner } from "./application/runtime-repository-owner.js";
import { RuntimeTaskOwner } from "./application/runtime-task-owner.js";
import type { LocalFactoryEvaluatorConfig } from "./infrastructure/filesystem/local-factory-evaluator-config.js";
import { NodeFactoryDocumentCodec } from "./infrastructure/persistence/canonical-factory-documents.js";
import { isUnconfirmedDatabaseInitializationError } from "./infrastructure/persistence/sqlite-database.js";
import { SqliteFactoryEvaluationRepository } from "./infrastructure/persistence/sqlite-factory-evaluation-repository.js";
import { acquireSqliteWriterLease } from "./infrastructure/persistence/sqlite-writer-lease.js";

export interface LocalFactoryEvaluatorOptions {
  readonly databasePath: string;
  readonly runnerId: string;
  readonly now?: () => string;
  readonly createId?: () => string;
}

/** Composes only credentialless eval assessment; no model, GitHub, merge, or release adapter. */
export function createLocalFactoryEvaluator(
  options: LocalFactoryEvaluatorOptions
): LocalFactoryEvaluatorRuntime {
  const writerLease = acquireSqliteWriterLease(options.databasePath);
  const repositories = new RuntimeRepositoryOwner();
  try {
    if (writerLease.databasePath === ":memory:") {
      throw new Error("The local factory evaluator requires a durable SQLite database.");
    }
    const documents = new NodeFactoryDocumentCodec();
    const evaluations = repositories.track(
      new SqliteFactoryEvaluationRepository(writerLease.databasePath, { documents })
    );
    const evaluator = new FactoryEvaluationService({
      runnerId: options.runnerId,
      evaluations,
      documents,
      now: options.now ?? (() => new Date().toISOString()),
      createId: options.createId ?? randomUUID
    });
    return new LocalFactoryEvaluatorCoordinator({
      evaluator,
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
      throw new AggregateError(failures, "Factory evaluator construction and cleanup failed.");
    }
    throw error;
  }
}

export function createConfiguredLocalFactoryEvaluator(
  config: LocalFactoryEvaluatorConfig
): LocalFactoryEvaluatorRuntime {
  return createLocalFactoryEvaluator(config);
}

export type {
  FactoryEvaluatorCommandPort,
  LocalFactoryEvaluatorRuntime
} from "./application/local-factory-evaluator-coordinator.js";
export type { FactoryEvalSnapshot } from "./domain/factory-evaluation-repository.js";
export {
  loadLocalFactoryEvaluatorConfig,
  type LocalFactoryEvaluatorConfig
} from "./infrastructure/filesystem/local-factory-evaluator-config.js";
export { loadLocalFactoryEvalRun } from "./infrastructure/filesystem/local-factory-eval-run.js";
