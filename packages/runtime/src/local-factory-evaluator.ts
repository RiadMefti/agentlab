import { randomUUID } from "node:crypto";

import type { Sha256Digest } from "@agentlab/contracts";

import { FactoryEvaluationService } from "./application/factory-evaluation-service.js";
import { FactoryEvalAttestationService } from "./application/factory-eval-attestation-service.js";
import {
  LocalFactoryEvaluatorCoordinator,
  type LocalFactoryEvaluatorRuntime
} from "./application/local-factory-evaluator-coordinator.js";
import { cleanupFailedRuntimeConstruction } from "./application/local-runtime-construction.js";
import { RuntimeRepositoryOwner } from "./application/runtime-repository-owner.js";
import { RuntimeTaskOwner } from "./application/runtime-task-owner.js";
import type { LocalFactoryEvaluatorConfig } from "./infrastructure/filesystem/local-factory-evaluator-config.js";
import { FileFactoryEvalAttestationKeySource } from "./infrastructure/filesystem/file-factory-eval-attestation-key-source.js";
import { NodeFactoryDsseVerifier } from "./infrastructure/crypto/node-factory-dsse-verifier.js";
import { NodeFactoryDocumentCodec } from "./infrastructure/persistence/canonical-factory-documents.js";
import { isUnconfirmedDatabaseInitializationError } from "./infrastructure/persistence/sqlite-database.js";
import { SqliteFactoryEvaluationRepository } from "./infrastructure/persistence/sqlite-factory-evaluation-repository.js";
import { SqliteFactoryEvalAttestationRepository } from "./infrastructure/persistence/sqlite-factory-eval-attestation-repository.js";
import { acquireSqliteWriterLease } from "./infrastructure/persistence/sqlite-writer-lease.js";

export interface LocalFactoryEvaluatorOptions {
  readonly databasePath: string;
  readonly runnerId: string;
  readonly trustedPublicKeyPath: string;
  readonly trustedKeyId: Sha256Digest;
  readonly maximumIssuanceDelaySeconds: number;
  readonly maximumAttestationLifetimeSeconds: number;
  readonly now?: () => string;
  readonly createId?: () => string;
}

/** Composes credentialless assessment and public-key verification; never signing or remote access. */
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
    const verifier = new NodeFactoryDsseVerifier(
      new FileFactoryEvalAttestationKeySource(options.trustedPublicKeyPath, "public"),
      options.trustedKeyId
    );
    const attestations = repositories.track(
      new SqliteFactoryEvalAttestationRepository(writerLease.databasePath, {
        evaluations,
        verifier,
        documents
      })
    );
    const evaluator = new FactoryEvaluationService({
      runnerId: options.runnerId,
      evaluations,
      documents,
      now: options.now ?? (() => new Date().toISOString()),
      createId: options.createId ?? randomUUID
    });
    const attestationVerifier = new FactoryEvalAttestationService({
      evaluations,
      attestations,
      verifier,
      maximumIssuanceDelaySeconds: options.maximumIssuanceDelaySeconds,
      maximumAttestationLifetimeSeconds: options.maximumAttestationLifetimeSeconds,
      documents,
      now: options.now ?? (() => new Date().toISOString()),
      createId: options.createId ?? randomUUID
    });
    return new LocalFactoryEvaluatorCoordinator({
      evaluator,
      attestations: attestationVerifier,
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
export type { FactoryEvalAttestationRecordResult } from "./application/factory-eval-attestation-service.js";
export {
  loadLocalFactoryEvaluatorConfig,
  type LocalFactoryEvaluatorConfig
} from "./infrastructure/filesystem/local-factory-evaluator-config.js";
export { loadLocalFactoryEvalRun } from "./infrastructure/filesystem/local-factory-eval-run.js";
export { loadLocalFactorySignedEvalAttestation } from "./infrastructure/filesystem/local-factory-signed-eval-attestation.js";
