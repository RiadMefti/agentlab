import { randomUUID } from "node:crypto";

import type {
  FactoryDailyQuotaPolicy,
  FactoryOperationsHealthPolicy,
  Sha256Digest
} from "@agentlab/contracts";

import { FactoryIncidentContainmentService } from "./application/factory-incident-containment-service.js";
import { FactoryOperationsHealthService } from "./application/factory-operations-health-service.js";
import {
  LocalFactoryIncidentContainmentCoordinator,
  type LocalFactoryIncidentContainmentRuntime
} from "./application/local-factory-incident-containment-coordinator.js";
import { cleanupFailedRuntimeConstruction } from "./application/local-runtime-construction.js";
import { RuntimeRepositoryOwner } from "./application/runtime-repository-owner.js";
import { RuntimeTaskOwner } from "./application/runtime-task-owner.js";
import type { LocalFactoryIncidentContainmentConfig } from "./infrastructure/filesystem/local-factory-incident-containment-config.js";
import { NodeFactoryDocumentCodec } from "./infrastructure/persistence/canonical-factory-documents.js";
import { isUnconfirmedDatabaseInitializationError } from "./infrastructure/persistence/sqlite-database.js";
import { SqliteFactoryIncidentContainmentRepository } from "./infrastructure/persistence/sqlite-factory-incident-containment-repository.js";
import { SqliteFactoryOperationsHealthSource } from "./infrastructure/persistence/sqlite-factory-operations-health-source.js";
import { acquireSqliteWriterLease } from "./infrastructure/persistence/sqlite-writer-lease.js";

export interface LocalFactoryIncidentContainmentOptions {
  readonly databasePath: string;
  readonly controllerId: string;
  readonly controllerUserId: number;
  readonly healthPolicy: FactoryOperationsHealthPolicy;
  readonly expectedHealthPolicyDigest: Sha256Digest;
  readonly dailyQuotaPolicy: FactoryDailyQuotaPolicy;
  readonly expectedDailyQuotaPolicyDigest: Sha256Digest;
  readonly now?: () => string;
  readonly createId?: () => string;
}

/** Composes an isolated, providerless, credentialless controller with disable-only authority. */
export function createLocalFactoryIncidentContainment(
  options: LocalFactoryIncidentContainmentOptions
): LocalFactoryIncidentContainmentRuntime {
  const userId = process.getuid?.();
  if (userId === undefined || userId !== options.controllerUserId || userId < 1) {
    throw new Error("Incident controller process identity does not match reviewed configuration.");
  }
  const documents = new NodeFactoryDocumentCodec();
  const healthPolicy = documents.operationsHealthPolicy(options.healthPolicy);
  const dailyQuotaPolicy = documents.dailyQuotaPolicy(options.dailyQuotaPolicy);
  if (healthPolicy.digest !== options.expectedHealthPolicyDigest) {
    throw new Error("Factory incident health policy changed after review.");
  }
  if (dailyQuotaPolicy.digest !== options.expectedDailyQuotaPolicyDigest) {
    throw new Error("Factory incident daily quota policy changed after review.");
  }
  const writerLease = acquireSqliteWriterLease(options.databasePath);
  const repositories = new RuntimeRepositoryOwner();
  try {
    if (writerLease.databasePath === ":memory:") {
      throw new Error("Factory incident containment requires durable SQLite.");
    }
    const repository = repositories.track(
      new SqliteFactoryIncidentContainmentRepository(writerLease.databasePath, { documents })
    );
    const source = repositories.track(
      new SqliteFactoryOperationsHealthSource(writerLease.databasePath, { documents })
    );
    const now = options.now ?? (() => new Date().toISOString());
    const createId = options.createId ?? randomUUID;
    const health = new FactoryOperationsHealthService({
      observerId: options.controllerId,
      healthPolicy,
      dailyQuotaPolicy,
      source,
      documents,
      now,
      createId
    });
    const service = new FactoryIncidentContainmentService({
      controllerId: options.controllerId,
      health,
      repository,
      documents,
      now,
      createId
    });
    return new LocalFactoryIncidentContainmentCoordinator({
      service,
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
      throw new AggregateError(failures, "Incident controller construction failed.");
    }
    throw error;
  }
}

export function createConfiguredLocalFactoryIncidentContainment(
  config: LocalFactoryIncidentContainmentConfig
): LocalFactoryIncidentContainmentRuntime {
  return createLocalFactoryIncidentContainment(config);
}

export {
  loadLocalFactoryIncidentContainmentConfig,
  type LocalFactoryIncidentContainmentConfig
} from "./infrastructure/filesystem/local-factory-incident-containment-config.js";
export type {
  FactoryIncidentContainmentResult,
  FactoryIncidentContainmentServiceDependencies
} from "./application/factory-incident-containment-service.js";
export type {
  FactoryIncidentContainmentCommandPort,
  LocalFactoryIncidentContainmentRuntime
} from "./application/local-factory-incident-containment-coordinator.js";
