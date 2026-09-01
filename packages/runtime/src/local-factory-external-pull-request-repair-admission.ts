import { randomUUID } from "node:crypto";

import type {
  FactoryExternalPullRequestRepairAdmissionPolicy,
  Sha256Digest
} from "@agentlab/contracts";

import { FactoryExternalPullRequestRepairAdmissionService } from "./application/factory-external-pull-request-repair-admission-service.js";
import {
  LocalFactoryExternalPullRequestRepairAdmissionCoordinator,
  type LocalFactoryExternalPullRequestRepairAdmissionRuntime
} from "./application/local-factory-external-pull-request-repair-admission-coordinator.js";
import { cleanupFailedRuntimeConstruction } from "./application/local-runtime-construction.js";
import { RuntimeRepositoryOwner } from "./application/runtime-repository-owner.js";
import { RuntimeTaskOwner } from "./application/runtime-task-owner.js";
import type { LocalFactoryExternalPullRequestRepairAdmissionConfig } from "./infrastructure/filesystem/local-factory-external-pull-request-repair-admission-config.js";
import { NodeFactoryDocumentCodec } from "./infrastructure/persistence/canonical-factory-documents.js";
import { isUnconfirmedDatabaseInitializationError } from "./infrastructure/persistence/sqlite-database.js";
import { SqliteFactoryControlStateReader } from "./infrastructure/persistence/sqlite-factory-control-state-reader.js";
import { SqliteFactoryExternalPullRequestRepairAdmissionRepository } from "./infrastructure/persistence/sqlite-factory-external-pull-request-repair-admission-repository.js";
import { acquireSqliteWriterLease } from "./infrastructure/persistence/sqlite-writer-lease.js";

export interface LocalFactoryExternalPullRequestRepairAdmissionOptions {
  readonly databasePath: string;
  readonly repositoryId: string;
  readonly processUserId: number;
  readonly admissionPolicy: FactoryExternalPullRequestRepairAdmissionPolicy;
  readonly expectedAdmissionPolicyDigest: Sha256Digest;
  readonly now?: () => string;
  readonly createId?: () => string;
}

/** Composes deterministic admission only: no model, process, workspace, GitHub, merge, or release. */
export function createLocalFactoryExternalPullRequestRepairAdmission(
  options: LocalFactoryExternalPullRequestRepairAdmissionOptions
): LocalFactoryExternalPullRequestRepairAdmissionRuntime {
  if (process.getuid?.() !== options.processUserId) {
    throw new Error(
      "External PR repair admission process does not match its reviewed POSIX user ID."
    );
  }
  const documents = new NodeFactoryDocumentCodec();
  const now = options.now ?? (() => new Date().toISOString());
  const policy = documents.externalPullRequestRepairAdmissionPolicy(options.admissionPolicy);
  if (
    policy.digest !== options.expectedAdmissionPolicyDigest ||
    policy.value.repositoryId !== options.repositoryId
  ) {
    throw new Error("External PR repair admission policy changed after administrator review.");
  }
  const writerLease = acquireSqliteWriterLease(options.databasePath);
  const repositories = new RuntimeRepositoryOwner();
  try {
    if (writerLease.databasePath === ":memory:") {
      throw new Error("External PR repair admission requires a durable SQLite database.");
    }
    const decisions = repositories.track(
      new SqliteFactoryExternalPullRequestRepairAdmissionRepository(writerLease.databasePath, {
        documents,
        now
      })
    );
    const controls = repositories.track(
      new SqliteFactoryControlStateReader(writerLease.databasePath, { documents })
    );
    const service = new FactoryExternalPullRequestRepairAdmissionService({
      admissionPolicy: policy,
      repository: decisions,
      controls,
      documents,
      now,
      createId: options.createId ?? randomUUID
    });
    return new LocalFactoryExternalPullRequestRepairAdmissionCoordinator({
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
      throw new AggregateError(
        failures,
        "External PR repair admission construction and cleanup failed."
      );
    }
    throw error;
  }
}

export function createConfiguredLocalFactoryExternalPullRequestRepairAdmission(
  config: LocalFactoryExternalPullRequestRepairAdmissionConfig
): LocalFactoryExternalPullRequestRepairAdmissionRuntime {
  return createLocalFactoryExternalPullRequestRepairAdmission({
    databasePath: config.databasePath,
    repositoryId: config.repositoryId,
    processUserId: config.processUserId,
    admissionPolicy: config.admissionPolicy,
    expectedAdmissionPolicyDigest: config.expectedAdmissionPolicyDigest
  });
}

export {
  loadLocalFactoryExternalPullRequestRepairAdmissionConfig,
  type LocalFactoryExternalPullRequestRepairAdmissionConfig
} from "./infrastructure/filesystem/local-factory-external-pull-request-repair-admission-config.js";
export type {
  FactoryExternalPullRequestRepairAdmissionPreflight,
  FactoryExternalPullRequestRepairAdmissionTickReport
} from "./application/factory-external-pull-request-repair-admission-service.js";
export type {
  FactoryExternalPullRequestRepairAdmissionCommandPort,
  LocalFactoryExternalPullRequestRepairAdmissionRuntime
} from "./application/local-factory-external-pull-request-repair-admission-coordinator.js";
