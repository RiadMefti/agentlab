import { randomUUID } from "node:crypto";

import {
  factoryIdentifierSchema,
  type FactoryDailyQuotaPolicy,
  type FactoryOperationsHealthPolicy,
  type Sha256Digest
} from "@agentlab/contracts";

import { FactoryOperationsHealthService } from "./application/factory-operations-health-service.js";
import {
  LocalFactoryOperationsHealthCoordinator,
  type LocalFactoryOperationsHealthRuntime
} from "./application/local-factory-operations-health-coordinator.js";
import { RuntimeTaskOwner } from "./application/runtime-task-owner.js";
import type { LocalFactoryOperationsHealthConfig } from "./infrastructure/filesystem/local-factory-operations-health-config.js";
import { NodeFactoryDocumentCodec } from "./infrastructure/persistence/canonical-factory-documents.js";
import { SqliteFactoryOperationsHealthSource } from "./infrastructure/persistence/sqlite-factory-operations-health-source.js";

export interface LocalFactoryOperationsHealthOptions {
  readonly databasePath: string;
  readonly observerId: string;
  readonly healthPolicy: FactoryOperationsHealthPolicy;
  readonly expectedHealthPolicyDigest: Sha256Digest;
  readonly dailyQuotaPolicy: FactoryDailyQuotaPolicy;
  readonly expectedDailyQuotaPolicyDigest: Sha256Digest;
  readonly now?: () => string;
  readonly createId?: () => string;
}

/** Composes a query-only ledger observer with no provider, GitHub, control, or writer capability. */
export function createLocalFactoryOperationsHealth(
  options: LocalFactoryOperationsHealthOptions
): LocalFactoryOperationsHealthRuntime {
  if (options.databasePath === ":memory:") {
    throw new Error("Factory operations health requires a durable SQLite database.");
  }
  factoryIdentifierSchema.parse(options.observerId);
  const documents = new NodeFactoryDocumentCodec();
  const healthPolicy = documents.operationsHealthPolicy(options.healthPolicy);
  const dailyQuotaPolicy = documents.dailyQuotaPolicy(options.dailyQuotaPolicy);
  if (healthPolicy.digest !== options.expectedHealthPolicyDigest) {
    throw new Error("Factory operations health policy changed after review.");
  }
  if (dailyQuotaPolicy.digest !== options.expectedDailyQuotaPolicyDigest) {
    throw new Error("Factory operations daily quota policy changed after review.");
  }
  let source: SqliteFactoryOperationsHealthSource | null = null;
  try {
    source = new SqliteFactoryOperationsHealthSource(options.databasePath, { documents });
    const service = new FactoryOperationsHealthService({
      observerId: options.observerId,
      healthPolicy,
      dailyQuotaPolicy,
      source,
      documents,
      now: options.now ?? (() => new Date().toISOString()),
      createId: options.createId ?? randomUUID
    });
    return new LocalFactoryOperationsHealthCoordinator({
      service,
      tasks: new RuntimeTaskOwner(),
      source
    });
  } catch (error: unknown) {
    try {
      source?.close();
    } catch (closeError: unknown) {
      throw new AggregateError(
        [error, closeError],
        "Factory operations health construction and cleanup both failed.",
        { cause: error }
      );
    }
    throw error;
  }
}

export function createConfiguredLocalFactoryOperationsHealth(
  config: LocalFactoryOperationsHealthConfig
): LocalFactoryOperationsHealthRuntime {
  return createLocalFactoryOperationsHealth(config);
}

export type {
  FactoryOperationsHealthCommandPort,
  LocalFactoryOperationsHealthRuntime
} from "./application/local-factory-operations-health-coordinator.js";
export type { FactoryOperationsHealthServiceDependencies } from "./application/factory-operations-health-service.js";
export {
  loadLocalFactoryOperationsHealthConfig,
  type LocalFactoryOperationsHealthConfig
} from "./infrastructure/filesystem/local-factory-operations-health-config.js";
export { loadLocalFactoryOperationsHealthPolicy } from "./infrastructure/filesystem/local-factory-operations-health-policy.js";
