import { randomUUID } from "node:crypto";

import { FactoryEvalProductionService } from "./application/factory-eval-production-service.js";
import {
  LocalFactoryEvalProducerCoordinator,
  type LocalFactoryEvalProducerRuntime
} from "./application/local-factory-eval-producer-coordinator.js";
import { cleanupFailedRuntimeConstruction } from "./application/local-runtime-construction.js";
import { RuntimeRepositoryOwner } from "./application/runtime-repository-owner.js";
import { RuntimeTaskOwner } from "./application/runtime-task-owner.js";
import { FileFactoryArtifactStore } from "./infrastructure/filesystem/file-factory-artifact-store.js";
import { factoryPathsOverlap } from "./infrastructure/filesystem/factory-workspace-paths.js";
import type { LocalFactoryEvalProducerConfig } from "./infrastructure/filesystem/local-factory-eval-producer-config.js";
import { PinnedFactoryEvalExecutableResolver } from "./infrastructure/filesystem/pinned-factory-eval-executable-resolver.js";
import { NodeFactoryDocumentCodec } from "./infrastructure/persistence/canonical-factory-documents.js";
import { isUnconfirmedDatabaseInitializationError } from "./infrastructure/persistence/sqlite-database.js";
import { SqliteFactoryEvalProductionRepository } from "./infrastructure/persistence/sqlite-factory-eval-production-repository.js";
import { acquireSqliteWriterLease } from "./infrastructure/persistence/sqlite-writer-lease.js";
import { BubblewrapFactoryEvalSandbox } from "./infrastructure/process/bubblewrap-factory-eval-sandbox.js";
import { NodeCommandRunner } from "./infrastructure/process/command-runner.js";
import { LocalFactoryEvalHarnessExecutor } from "./infrastructure/process/local-factory-eval-harness-executor.js";
import { SystemdFactoryEvalProcessRecovery } from "./infrastructure/process/systemd-factory-eval-process-recovery.js";
import { SystemdFactoryProcessIsolator } from "./infrastructure/process/systemd-factory-process-isolator.js";

export interface LocalFactoryEvalProducerOptions {
  readonly databasePath: string;
  readonly artifactRoot: string;
  readonly workspaceRoot: string;
  readonly runnerId: string;
  readonly executables: LocalFactoryEvalProducerConfig["executables"];
  readonly systemd: LocalFactoryEvalProducerConfig["systemd"];
  readonly sandbox: LocalFactoryEvalProducerConfig["sandbox"];
  readonly now?: () => string;
  readonly createId?: () => string;
}

/** Composes offline eval production only; no signer, authority, scheduler, GitHub, merge, or release. */
export function createLocalFactoryEvalProducer(
  options: LocalFactoryEvalProducerOptions
): LocalFactoryEvalProducerRuntime {
  assertSeparatedProducerPaths(options);
  const writerLease = acquireSqliteWriterLease(options.databasePath);
  const repositories = new RuntimeRepositoryOwner();
  try {
    if (writerLease.databasePath === ":memory:") {
      throw new Error("The local factory eval producer requires a durable SQLite database.");
    }
    const documents = new NodeFactoryDocumentCodec();
    const productions = repositories.track(
      new SqliteFactoryEvalProductionRepository(writerLease.databasePath, { documents })
    );
    const runner = new NodeCommandRunner();
    const now = options.now ?? (() => new Date().toISOString());
    const producer = new FactoryEvalProductionService({
      runnerId: options.runnerId,
      productions,
      artifacts: new FileFactoryArtifactStore(options.artifactRoot),
      executables: new PinnedFactoryEvalExecutableResolver(options.executables),
      harness: new LocalFactoryEvalHarnessExecutor(
        runner,
        new BubblewrapFactoryEvalSandbox({
          executable: options.sandbox.bubblewrapExecutable,
          runtimeRoots: options.sandbox.runtimeRoots
        }),
        new SystemdFactoryProcessIsolator({
          executable: options.systemd.runExecutable,
          environmentExecutable: options.systemd.environmentExecutable,
          version: options.systemd.version
        }),
        { workspaceRoot: options.workspaceRoot, now }
      ),
      recovery: new SystemdFactoryEvalProcessRecovery(runner, {
        executable: options.systemd.controlExecutable
      }),
      documents,
      now,
      createId: options.createId ?? randomUUID
    });
    return new LocalFactoryEvalProducerCoordinator({
      producer,
      tasks: new RuntimeTaskOwner(),
      repositories,
      writerLease
    });
  } catch (error: unknown) {
    const failures = [
      error,
      ...cleanupFailedRuntimeConstruction(
        repositories,
        writerLease,
        !isUnconfirmedDatabaseInitializationError(error)
      )
    ];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Factory eval producer construction and cleanup failed.");
    }
    throw error;
  }
}

export function createConfiguredLocalFactoryEvalProducer(
  config: LocalFactoryEvalProducerConfig
): LocalFactoryEvalProducerRuntime {
  return createLocalFactoryEvalProducer(config);
}

export type {
  FactoryEvalProducerCommandPort,
  LocalFactoryEvalProducerRuntime
} from "./application/local-factory-eval-producer-coordinator.js";
export type { LocalFactoryEvalProducerConfig } from "./infrastructure/filesystem/local-factory-eval-producer-config.js";
export { loadLocalFactoryEvalProducerConfig } from "./infrastructure/filesystem/local-factory-eval-producer-config.js";
export { loadLocalFactoryEvalProductionJob } from "./infrastructure/filesystem/local-factory-eval-production-job.js";

function assertSeparatedProducerPaths(options: LocalFactoryEvalProducerOptions): void {
  if (
    factoryPathsOverlap(options.artifactRoot, options.workspaceRoot) ||
    factoryPathsOverlap(options.databasePath, options.artifactRoot) ||
    factoryPathsOverlap(options.databasePath, options.workspaceRoot) ||
    options.sandbox.runtimeRoots.some(
      (root) =>
        factoryPathsOverlap(root, options.databasePath) ||
        factoryPathsOverlap(root, options.artifactRoot) ||
        factoryPathsOverlap(root, options.workspaceRoot)
    )
  ) {
    throw new Error(
      "Factory eval producer storage, workspace, and runtime paths must be disjoint."
    );
  }
}
