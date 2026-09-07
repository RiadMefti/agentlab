import { randomUUID } from "node:crypto";

import type {
  FactoryRoleIdentityPolicy,
  FactorySchedulePolicy,
  Sha256Digest
} from "@agentlab/contracts";

import { FactoryCanaryAdmissionService } from "./application/factory-canary-admission-service.js";
import { FactoryCanaryAdmissionConsumerService } from "./application/factory-canary-admission-consumer-service.js";
import { FactoryEvalAttestationService } from "./application/factory-eval-attestation-service.js";
import {
  LocalFactoryCanaryAdmissionCoordinator,
  type LocalFactoryCanaryAdmissionRuntime
} from "./application/local-factory-canary-admission-coordinator.js";
import { cleanupFailedRuntimeConstruction } from "./application/local-runtime-construction.js";
import { RuntimeRepositoryOwner } from "./application/runtime-repository-owner.js";
import { RuntimeTaskOwner } from "./application/runtime-task-owner.js";
import { assertFactoryProcessRoleIdentity } from "./domain/factory-role-identity.js";
import { NodeFactoryDsseVerifier } from "./infrastructure/crypto/node-factory-dsse-verifier.js";
import { FileFactoryEvalAttestationKeySource } from "./infrastructure/filesystem/file-factory-eval-attestation-key-source.js";
import type { LocalFactoryCanaryAdmissionConfig } from "./infrastructure/filesystem/local-factory-canary-admission-config.js";
import { NodeFactoryDocumentCodec } from "./infrastructure/persistence/canonical-factory-documents.js";
import { isUnconfirmedDatabaseInitializationError } from "./infrastructure/persistence/sqlite-database.js";
import { SqliteFactoryCanaryRepository } from "./infrastructure/persistence/sqlite-factory-canary-repository.js";
import { SqliteFactoryCanaryReservationRepository } from "./infrastructure/persistence/sqlite-factory-canary-reservation-repository.js";
import { SqliteFactoryEvalAttestationRepository } from "./infrastructure/persistence/sqlite-factory-eval-attestation-repository.js";
import { SqliteFactoryEvaluationRepository } from "./infrastructure/persistence/sqlite-factory-evaluation-repository.js";
import { SqliteFactoryPreparationRepository } from "./infrastructure/persistence/sqlite-factory-preparation-repository.js";
import { SqliteFactoryRepository } from "./infrastructure/persistence/sqlite-factory-repository.js";
import { acquireSqliteWriterLease } from "./infrastructure/persistence/sqlite-writer-lease.js";

export interface LocalFactoryCanaryAdmissionOptions {
  readonly databasePath: string;
  readonly runnerId: string;
  readonly trustedPublicKeyPath: string;
  readonly trustedKeyId: Sha256Digest;
  readonly maximumIssuanceDelaySeconds: number;
  readonly maximumAttestationLifetimeSeconds: number;
  readonly roleIdentityPolicy: FactoryRoleIdentityPolicy;
  readonly expectedRoleIdentityPolicyDigest: Sha256Digest;
  readonly expectedCohortDigest: Sha256Digest;
  readonly expectedCandidateDigest: Sha256Digest;
  readonly expectedSchedulePolicyDigest: Sha256Digest;
  readonly expectedPolicyBundleDigest: Sha256Digest;
  readonly schedulePolicy?: FactorySchedulePolicy;
  readonly now?: () => string;
  readonly createId?: () => string;
}

/** Composes only attested task admission; no model, process, broker, merge, or release is reachable. */
export function createLocalFactoryCanaryAdmission(
  options: LocalFactoryCanaryAdmissionOptions
): LocalFactoryCanaryAdmissionRuntime {
  const documents = new NodeFactoryDocumentCodec();
  const identityPolicy = documents.roleIdentityPolicy(options.roleIdentityPolicy);
  if (identityPolicy.digest !== options.expectedRoleIdentityPolicyDigest) {
    throw new Error("Factory canary admission role identity policy changed after review.");
  }
  if (
    identityPolicy.value.evalAttestor.runnerId !== options.runnerId ||
    identityPolicy.value.evalAttestor.keyId !== options.trustedKeyId
  ) {
    throw new Error("Factory canary admission trust coordinates do not match its identity policy.");
  }
  const schedulePolicy =
    options.schedulePolicy === undefined ? null : documents.schedulePolicy(options.schedulePolicy);
  if (schedulePolicy !== null && schedulePolicy.digest !== options.expectedSchedulePolicyDigest) {
    throw new Error("Factory canary admission schedule policy changed after review.");
  }
  if (schedulePolicy !== null) {
    assertFactoryProcessRoleIdentity(identityPolicy.value, "worker", process.getuid?.());
  }
  const writerLease = acquireSqliteWriterLease(options.databasePath);
  const repositories = new RuntimeRepositoryOwner();
  try {
    if (writerLease.databasePath === ":memory:") {
      throw new Error("The local factory canary admission runtime requires durable SQLite.");
    }
    const databasePath = writerLease.databasePath;
    const evaluations = repositories.track(
      new SqliteFactoryEvaluationRepository(databasePath, { documents })
    );
    const verifier = new NodeFactoryDsseVerifier(
      new FileFactoryEvalAttestationKeySource(options.trustedPublicKeyPath, "public"),
      options.trustedKeyId
    );
    const attestations = repositories.track(
      new SqliteFactoryEvalAttestationRepository(databasePath, {
        evaluations,
        verifier,
        expectedRoleIdentityPolicyDigest: options.expectedRoleIdentityPolicyDigest,
        documents
      })
    );
    const canaries = repositories.track(
      new SqliteFactoryCanaryRepository(databasePath, {
        documents,
        evaluations,
        attestations
      })
    );
    const preparations = repositories.track(
      new SqliteFactoryPreparationRepository(databasePath, { documents })
    );
    const reservations = repositories.track(
      new SqliteFactoryCanaryReservationRepository(databasePath, { documents })
    );
    const controls =
      schedulePolicy === null
        ? null
        : repositories.track(new SqliteFactoryRepository(databasePath, { documents }));
    const now = options.now ?? (() => new Date().toISOString());
    const createId = options.createId ?? randomUUID;
    const attestationVerifier = new FactoryEvalAttestationService({
      evaluations,
      attestations,
      verifier,
      maximumIssuanceDelaySeconds: options.maximumIssuanceDelaySeconds,
      maximumAttestationLifetimeSeconds: options.maximumAttestationLifetimeSeconds,
      expectedRoleIdentityPolicyDigest: options.expectedRoleIdentityPolicyDigest,
      documents,
      now,
      createId
    });
    const admission = new FactoryCanaryAdmissionService({
      expectedCohortDigest: options.expectedCohortDigest,
      expectedCandidateDigest: options.expectedCandidateDigest,
      expectedSchedulePolicyDigest: options.expectedSchedulePolicyDigest,
      expectedPolicyBundleDigest: options.expectedPolicyBundleDigest,
      expectedRoleIdentityPolicyDigest: options.expectedRoleIdentityPolicyDigest,
      canaries,
      evaluations,
      attestations: attestationVerifier,
      preparations,
      reservations,
      documents,
      now,
      createId
    });
    const consumer =
      schedulePolicy === null || controls === null
        ? undefined
        : new FactoryCanaryAdmissionConsumerService({
            schedulePolicy,
            pins: {
              expectedCohortDigest: options.expectedCohortDigest,
              expectedCandidateDigest: options.expectedCandidateDigest,
              expectedSchedulePolicyDigest: options.expectedSchedulePolicyDigest,
              expectedPolicyBundleDigest: options.expectedPolicyBundleDigest,
              expectedRoleIdentityPolicyDigest: options.expectedRoleIdentityPolicyDigest
            },
            controls,
            preparations,
            reservations,
            admission
          });
    return new LocalFactoryCanaryAdmissionCoordinator({
      admission,
      ...(consumer === undefined ? {} : { consumer }),
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
        "Factory canary admission construction and cleanup failed."
      );
    }
    throw error;
  }
}

export function createConfiguredLocalFactoryCanaryAdmission(
  config: LocalFactoryCanaryAdmissionConfig
): LocalFactoryCanaryAdmissionRuntime {
  return createLocalFactoryCanaryAdmission(config);
}

export type {
  FactoryCanaryAdmissionCommand,
  FactoryCanaryAdmissionResult
} from "./application/factory-canary-admission-service.js";
export type { FactoryCanaryAdmissionTickReport } from "./application/factory-canary-admission-consumer-service.js";
export type {
  FactoryCanaryAdmissionCommandPort,
  LocalFactoryCanaryAdmissionRuntime
} from "./application/local-factory-canary-admission-coordinator.js";
export {
  loadLocalFactoryCanaryAdmissionConfig,
  type LocalFactoryCanaryAdmissionConfig
} from "./infrastructure/filesystem/local-factory-canary-admission-config.js";
