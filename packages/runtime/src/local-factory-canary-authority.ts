import { randomUUID } from "node:crypto";

import type { FactoryRoleIdentityPolicy, Sha256Digest } from "@agentlab/contracts";

import { FactoryCanaryAuthorityService } from "./application/factory-canary-authority-service.js";
import { FactoryEvalAttestationService } from "./application/factory-eval-attestation-service.js";
import {
  LocalFactoryCanaryAuthorityCoordinator,
  type LocalFactoryCanaryAuthorityRuntime
} from "./application/local-factory-canary-authority-coordinator.js";
import { cleanupFailedRuntimeConstruction } from "./application/local-runtime-construction.js";
import { RuntimeRepositoryOwner } from "./application/runtime-repository-owner.js";
import { RuntimeTaskOwner } from "./application/runtime-task-owner.js";
import type { LocalFactoryCanaryAuthorityConfig } from "./infrastructure/filesystem/local-factory-canary-authority-config.js";
import { FileFactoryEvalAttestationKeySource } from "./infrastructure/filesystem/file-factory-eval-attestation-key-source.js";
import { NodeFactoryDsseVerifier } from "./infrastructure/crypto/node-factory-dsse-verifier.js";
import { NodeFactoryDocumentCodec } from "./infrastructure/persistence/canonical-factory-documents.js";
import { isUnconfirmedDatabaseInitializationError } from "./infrastructure/persistence/sqlite-database.js";
import { SqliteFactoryCanaryRepository } from "./infrastructure/persistence/sqlite-factory-canary-repository.js";
import { SqliteFactoryEvalAttestationRepository } from "./infrastructure/persistence/sqlite-factory-eval-attestation-repository.js";
import { SqliteFactoryEvaluationRepository } from "./infrastructure/persistence/sqlite-factory-evaluation-repository.js";
import { acquireSqliteWriterLease } from "./infrastructure/persistence/sqlite-writer-lease.js";

export interface LocalFactoryCanaryAuthorityOptions {
  readonly databasePath: string;
  readonly operatorId: string;
  readonly runnerId: string;
  readonly trustedPublicKeyPath: string;
  readonly trustedKeyId: Sha256Digest;
  readonly maximumIssuanceDelaySeconds: number;
  readonly maximumAttestationLifetimeSeconds: number;
  readonly roleIdentityPolicy: FactoryRoleIdentityPolicy;
  readonly expectedRoleIdentityPolicyDigest: Sha256Digest;
  readonly now?: () => string;
  readonly createId?: () => string;
}

/** Composes only human cohort issuance; execution, broker, merge, and release are unreachable. */
export function createLocalFactoryCanaryAuthority(
  options: LocalFactoryCanaryAuthorityOptions
): LocalFactoryCanaryAuthorityRuntime {
  const documents = new NodeFactoryDocumentCodec();
  const identityPolicy = documents.roleIdentityPolicy(options.roleIdentityPolicy);
  if (identityPolicy.digest !== options.expectedRoleIdentityPolicyDigest) {
    throw new Error("Factory canary authority role identity policy changed after review.");
  }
  if (
    identityPolicy.value.evalAttestor.runnerId !== options.runnerId ||
    identityPolicy.value.evalAttestor.keyId !== options.trustedKeyId
  ) {
    throw new Error("Factory canary authority trust coordinates do not match its identity policy.");
  }
  const writerLease = acquireSqliteWriterLease(options.databasePath);
  const repositories = new RuntimeRepositoryOwner();
  try {
    if (writerLease.databasePath === ":memory:") {
      throw new Error("The local factory canary authority requires a durable SQLite database.");
    }
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
        expectedRoleIdentityPolicyDigest: options.expectedRoleIdentityPolicyDigest,
        documents
      })
    );
    const canaries = repositories.track(
      new SqliteFactoryCanaryRepository(writerLease.databasePath, {
        documents,
        evaluations,
        attestations
      })
    );
    const attestationVerifier = new FactoryEvalAttestationService({
      evaluations,
      attestations,
      verifier,
      maximumIssuanceDelaySeconds: options.maximumIssuanceDelaySeconds,
      maximumAttestationLifetimeSeconds: options.maximumAttestationLifetimeSeconds,
      expectedRoleIdentityPolicyDigest: options.expectedRoleIdentityPolicyDigest,
      documents,
      now: options.now ?? (() => new Date().toISOString()),
      createId: options.createId ?? randomUUID
    });
    const authority = new FactoryCanaryAuthorityService({
      operatorId: options.operatorId,
      evaluations,
      attestations: attestationVerifier,
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
  if (config.schemaVersion !== "agentlab.local-factory-canary-authority.v2") {
    throw new Error(
      "Factory canary authority v1 cannot issue cohorts without verified eval attestations."
    );
  }
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
