import { randomUUID } from "node:crypto";

import type {
  FactoryAutonomousMergePolicy,
  FactoryCostPolicy,
  FactoryDailyQuotaPolicy,
  FactoryRoleIdentityPolicy,
  FactorySchedulePolicy,
  Sha256Digest
} from "@agentlab/contracts";

import { FactoryAutonomousMergeAdmissionService } from "./application/factory-autonomous-merge-admission-service.js";
import { FactoryControlPlane } from "./application/factory-control-plane.js";
import {
  createFactoryEvidenceCredential,
  FactoryEvidenceIngress
} from "./application/factory-evidence-ingress.js";
import { FactoryPullRequestCanaryAuthority } from "./application/factory-pull-request-canary-authority.js";
import {
  LocalFactoryAutonomousMergeAdmissionCoordinator,
  type LocalFactoryAutonomousMergeAdmissionRuntime
} from "./application/local-factory-autonomous-merge-admission-coordinator.js";
import { cleanupFailedRuntimeConstruction } from "./application/local-runtime-construction.js";
import { RuntimeRepositoryOwner } from "./application/runtime-repository-owner.js";
import { RuntimeTaskOwner } from "./application/runtime-task-owner.js";
import {
  createAutonomousR1FactoryPolicyBundle,
  FactoryPolicyEngine
} from "./domain/factory-policy.js";
import { FileFactoryArtifactStore } from "./infrastructure/filesystem/file-factory-artifact-store.js";
import type { LocalFactoryAutonomousMergeAdmissionConfig } from "./infrastructure/filesystem/local-factory-autonomous-merge-config.js";
import {
  encodeCanonicalDocument,
  NodeFactoryDocumentCodec
} from "./infrastructure/persistence/canonical-factory-documents.js";
import { SqliteConversationRepository } from "./infrastructure/persistence/sqlite-conversation-repository.js";
import { SqliteFactoryCanaryReservationRepository } from "./infrastructure/persistence/sqlite-factory-canary-reservation-repository.js";
import { SqliteFactoryDailyQuotaRepository } from "./infrastructure/persistence/sqlite-factory-daily-quota-repository.js";
import { isUnconfirmedDatabaseInitializationError } from "./infrastructure/persistence/sqlite-database.js";
import { SqliteFactoryPreparationRepository } from "./infrastructure/persistence/sqlite-factory-preparation-repository.js";
import { SqliteFactoryPullRequestDispatchRepository } from "./infrastructure/persistence/sqlite-factory-pull-request-dispatch-repository.js";
import { SqliteFactoryPullRequestUpdateRepository } from "./infrastructure/persistence/sqlite-factory-pull-request-update-repository.js";
import { SqliteFactoryRepository } from "./infrastructure/persistence/sqlite-factory-repository.js";
import { SqliteFactoryScheduleRepository } from "./infrastructure/persistence/sqlite-factory-schedule-repository.js";
import { acquireSqliteWriterLease } from "./infrastructure/persistence/sqlite-writer-lease.js";

export interface LocalFactoryAutonomousMergeAdmissionOptions {
  readonly databasePath: string;
  readonly artifactRoot: string;
  readonly repositoryId: string;
  readonly admissionUserId: number;
  readonly costPolicy: FactoryCostPolicy;
  readonly schedulePolicy: FactorySchedulePolicy;
  readonly dailyQuotaPolicy: FactoryDailyQuotaPolicy;
  readonly roleIdentityPolicy: FactoryRoleIdentityPolicy;
  readonly mergePolicy: FactoryAutonomousMergePolicy;
  readonly expectedFactoryPolicyBundleDigest: Sha256Digest;
  readonly expectedSchedulePolicyDigest: Sha256Digest;
  readonly expectedDailyQuotaPolicyDigest: Sha256Digest;
  readonly expectedRoleIdentityPolicyDigest: Sha256Digest;
  readonly expectedMergePolicyDigest: Sha256Digest;
  readonly now?: () => string;
  readonly createId?: () => string;
}

/** Composes a providerless, credentialless exact-head merge-admission process. */
export function createLocalFactoryAutonomousMergeAdmission(
  options: LocalFactoryAutonomousMergeAdmissionOptions
): LocalFactoryAutonomousMergeAdmissionRuntime {
  const userId = process.getuid?.();
  if (userId === undefined || userId !== options.admissionUserId || userId < 1) {
    throw new Error("Autonomous merge admission process identity is not reviewed.");
  }
  const documents = new NodeFactoryDocumentCodec();
  const mergePolicy = documents.autonomousMergePolicy(options.mergePolicy);
  const schedulePolicy = documents.schedulePolicy(options.schedulePolicy);
  const dailyQuotaPolicy = documents.dailyQuotaPolicy(options.dailyQuotaPolicy);
  const roleIdentityPolicy = documents.roleIdentityPolicy(options.roleIdentityPolicy);
  const policyBundle = encodeCanonicalDocument(
    createAutonomousR1FactoryPolicyBundle({ costPolicy: options.costPolicy, mergePolicy })
  );
  if (
    options.repositoryId !== mergePolicy.value.repositoryId ||
    mergePolicy.digest !== options.expectedMergePolicyDigest ||
    schedulePolicy.digest !== options.expectedSchedulePolicyDigest ||
    dailyQuotaPolicy.digest !== options.expectedDailyQuotaPolicyDigest ||
    roleIdentityPolicy.digest !== options.expectedRoleIdentityPolicyDigest ||
    policyBundle.digest !== options.expectedFactoryPolicyBundleDigest ||
    options.admissionUserId !== roleIdentityPolicy.value.worker.userId
  ) {
    throw new Error("Autonomous merge admission policies changed after review.");
  }
  const writerLease = acquireSqliteWriterLease(options.databasePath);
  const repositories = new RuntimeRepositoryOwner();
  try {
    if (writerLease.databasePath === ":memory:") {
      throw new Error("Autonomous merge admission requires durable SQLite.");
    }
    const databasePath = writerLease.databasePath;
    const conversations = repositories.track(new SqliteConversationRepository(databasePath));
    const factory = repositories.track(new SqliteFactoryRepository(databasePath, { documents }));
    const preparations = repositories.track(
      new SqliteFactoryPreparationRepository(databasePath, { documents })
    );
    const reservations = repositories.track(
      new SqliteFactoryCanaryReservationRepository(databasePath, { documents })
    );
    const dailyQuotas = repositories.track(
      new SqliteFactoryDailyQuotaRepository(databasePath, { documents })
    );
    const schedules = repositories.track(
      new SqliteFactoryScheduleRepository(databasePath, { documents })
    );
    const dispatches = repositories.track(
      new SqliteFactoryPullRequestDispatchRepository(databasePath, { documents })
    );
    const updates = repositories.track(
      new SqliteFactoryPullRequestUpdateRepository(databasePath, { documents })
    );
    const artifacts = new FileFactoryArtifactStore(options.artifactRoot);
    const now = options.now ?? (() => new Date().toISOString());
    const createId = options.createId ?? randomUUID;
    const policy = new FactoryPolicyEngine(policyBundle.digest, policyBundle.value);
    const controlPlaneCredential = createFactoryEvidenceCredential();
    const evidenceIngress = new FactoryEvidenceIngress({
      tasks: factory,
      evidence: factory,
      artifacts,
      documents,
      policyBundleDigest: policyBundle.digest,
      bindings: [{ credential: controlPlaneCredential, channel: "control-plane" }],
      now,
      createId
    });
    const controlPlane = new FactoryControlPlane({
      tasks: factory,
      evidence: factory,
      controls: factory,
      conversations,
      artifacts,
      documents,
      policy,
      policyBundle,
      evidenceIngress,
      evidenceCredential: controlPlaneCredential,
      now,
      createId
    });
    const canaryAuthority = new FactoryPullRequestCanaryAuthority({
      policyBundleDigest: policyBundle.digest,
      schedulePolicyDigest: schedulePolicy.digest,
      roleIdentityPolicyDigest: roleIdentityPolicy.digest,
      dailyQuotaPolicy,
      preparations,
      reservations,
      schedules,
      dailyQuotas,
      documents,
      now
    });
    const service = new FactoryAutonomousMergeAdmissionService({
      mergePolicy,
      policyBundle,
      schedulePolicyDigest: schedulePolicy.digest,
      dailyQuotaPolicyDigest: dailyQuotaPolicy.digest,
      roleIdentityPolicy,
      dispatches,
      updates,
      tasks: factory,
      evidence: factory,
      controls: factory,
      controlPlane,
      canaryAuthority,
      evidenceIngress,
      evidenceCredentials: { controlPlane: controlPlaneCredential },
      artifacts,
      documents,
      now,
      createId
    });
    return new LocalFactoryAutonomousMergeAdmissionCoordinator({
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
      throw new AggregateError(failures, "Autonomous merge admission construction failed.");
    }
    throw error;
  }
}

export function createConfiguredLocalFactoryAutonomousMergeAdmission(
  config: LocalFactoryAutonomousMergeAdmissionConfig
): LocalFactoryAutonomousMergeAdmissionRuntime {
  return createLocalFactoryAutonomousMergeAdmission({
    ...config,
    mergePolicy: config.mergePolicy.value
  });
}

export {
  loadLocalFactoryAutonomousMergeAdmissionConfig,
  type LocalFactoryAutonomousMergeAdmissionConfig
} from "./infrastructure/filesystem/local-factory-autonomous-merge-config.js";
export type {
  FactoryAutonomousMergeAdmissionCommandPort,
  LocalFactoryAutonomousMergeAdmissionRuntime
} from "./application/local-factory-autonomous-merge-admission-coordinator.js";
export type {
  FactoryAutonomousMergeAdmissionOutcome,
  FactoryAutonomousMergeAdmissionPreflight,
  FactoryAutonomousMergeAdmissionTickReport
} from "./application/factory-autonomous-merge-admission-service.js";
