import { randomUUID } from "node:crypto";

import {
  factoryAutonomousMergePolicySchema,
  factoryCostPolicySchema,
  factoryDailyQuotaPolicySchema,
  type FactoryAutonomousMergePolicy,
  type FactoryCostPolicy,
  type FactoryDailyQuotaPolicy,
  type FactoryRoleIdentityPolicy,
  type FactorySchedulePolicy,
  type Sha256Digest
} from "@agentlab/contracts";

import { FactoryBrokerOperator } from "./application/factory-broker-operator.js";
import { FactoryCanaryBrokerService } from "./application/factory-canary-broker-service.js";
import { FactoryCanaryPullRequestMaintenanceService } from "./application/factory-canary-pull-request-maintenance-service.js";
import { FactoryCanaryPullRequestUpdateService } from "./application/factory-canary-pull-request-update-service.js";
import {
  LocalFactoryBrokerCoordinator,
  type LocalFactoryBrokerRuntime
} from "./application/local-factory-broker-coordinator.js";
import { cleanupFailedRuntimeConstruction } from "./application/local-runtime-construction.js";
import { RuntimeRepositoryOwner } from "./application/runtime-repository-owner.js";
import { RuntimeTaskOwner } from "./application/runtime-task-owner.js";
import { FactoryControlPlane } from "./application/factory-control-plane.js";
import {
  createFactoryEvidenceCredential,
  FactoryEvidenceIngress
} from "./application/factory-evidence-ingress.js";
import { FactoryPullRequestService } from "./application/factory-pull-request-service.js";
import { FactoryPullRequestCanaryAuthority } from "./application/factory-pull-request-canary-authority.js";
import { FactoryPullRequestObservationService } from "./application/factory-pull-request-observation-service.js";
import { FactoryPullRequestRepairAdmissionService } from "./application/factory-pull-request-repair-admission-service.js";
import { FactoryPullRequestUpdateService } from "./application/factory-pull-request-update-service.js";
import {
  createAutonomousR1FactoryPolicyBundle,
  FactoryPolicyEngine,
  defaultFactoryPolicyBundle
} from "./domain/factory-policy.js";
import { assertFactoryProcessUserIdentity } from "./domain/factory-role-identity.js";
import { FileFactoryArtifactStore } from "./infrastructure/filesystem/file-factory-artifact-store.js";
import type { LocalFactoryBrokerConfig } from "./infrastructure/filesystem/local-factory-broker-config.js";
import { FileGitHubAppPrivateKeySource } from "./infrastructure/github/file-github-app-private-key-source.js";
import { GitHubAppInstallationRestClient } from "./infrastructure/github/github-app-installation-client.js";
import { GitHubAppInstallationTokenSource } from "./infrastructure/github/github-app-installation-token-source.js";
import {
  NodeGitHubAppJwtSigner,
  type GitHubAppPrivateKeySource
} from "./infrastructure/github/github-app-jwt.js";
import { GitHubFactoryPullRequestBroker } from "./infrastructure/github/github-factory-pull-request-broker.js";
import { GitHubFactoryPullRequestObserver } from "./infrastructure/github/github-factory-pull-request-observer.js";
import { GitHubRestClient } from "./infrastructure/github/github-rest-client.js";
import {
  encodeCanonicalDocument,
  NodeFactoryDocumentCodec
} from "./infrastructure/persistence/canonical-factory-documents.js";
import { SqliteConversationRepository } from "./infrastructure/persistence/sqlite-conversation-repository.js";
import { SqliteFactoryCanaryReservationRepository } from "./infrastructure/persistence/sqlite-factory-canary-reservation-repository.js";
import { SqliteFactoryDailyQuotaRepository } from "./infrastructure/persistence/sqlite-factory-daily-quota-repository.js";
import { SqliteFactoryCanaryBrokerQueue } from "./infrastructure/persistence/sqlite-factory-canary-broker-queue.js";
import { SqliteFactoryCanaryPullRequestMaintenanceQueue } from "./infrastructure/persistence/sqlite-factory-canary-pull-request-maintenance-queue.js";
import { SqliteFactoryCanaryPullRequestUpdateQueue } from "./infrastructure/persistence/sqlite-factory-canary-pull-request-update-queue.js";
import { SqliteFactoryPreparationRepository } from "./infrastructure/persistence/sqlite-factory-preparation-repository.js";
import { SqliteFactoryPullRequestDispatchRepository } from "./infrastructure/persistence/sqlite-factory-pull-request-dispatch-repository.js";
import { SqliteFactoryPullRequestRepairExecutionRepository } from "./infrastructure/persistence/sqlite-factory-pull-request-repair-execution-repository.js";
import { SqliteFactoryPullRequestUpdateRepository } from "./infrastructure/persistence/sqlite-factory-pull-request-update-repository.js";
import { SqliteFactoryRepository } from "./infrastructure/persistence/sqlite-factory-repository.js";
import { SqliteFactoryScheduleRepository } from "./infrastructure/persistence/sqlite-factory-schedule-repository.js";
import { acquireSqliteWriterLease } from "./infrastructure/persistence/sqlite-writer-lease.js";
import { NodeCommandRunner } from "./infrastructure/process/command-runner.js";
import { isUnconfirmedDatabaseInitializationError } from "./infrastructure/persistence/sqlite-database.js";

export interface LocalFactoryBrokerOptions {
  readonly databasePath: string;
  readonly artifactRoot: string;
  readonly temporaryRoot: string;
  readonly repositoryId: string;
  readonly repositoryNumericId: number;
  readonly brokerId: string;
  readonly gitExecutable: string;
  readonly costPolicy?: FactoryCostPolicy;
  readonly schedulePolicy?: FactorySchedulePolicy;
  readonly dailyQuotaPolicy?: FactoryDailyQuotaPolicy;
  readonly roleIdentityPolicy?: FactoryRoleIdentityPolicy;
  readonly expectedRoleIdentityPolicyDigest?: Sha256Digest;
  readonly autonomousMergePolicy?: FactoryAutonomousMergePolicy;
  readonly expectedAutonomousMergePolicyDigest?: Sha256Digest;
  readonly expectedFactoryPolicyBundleDigest?: Sha256Digest;
  readonly githubApp: {
    readonly clientId: string;
    readonly installationId: number;
    readonly privateKeySource: GitHubAppPrivateKeySource;
    readonly trustedStatusChecks: readonly {
      readonly context: "verify" | "factory-sandbox";
      readonly appId: number;
    }[];
  };
  readonly now?: () => string;
  readonly nowMilliseconds?: () => number;
  readonly createId?: () => string;
}

/** Composes only the broker authority plane; no provider/model adapter is loaded into this runtime. */
export function createLocalFactoryBroker(
  options: LocalFactoryBrokerOptions
): LocalFactoryBrokerRuntime {
  const writerLease = acquireSqliteWriterLease(options.databasePath);
  const repositories = new RuntimeRepositoryOwner();
  try {
    const documents = new NodeFactoryDocumentCodec();
    const schedulePolicy =
      options.schedulePolicy === undefined
        ? null
        : documents.schedulePolicy(options.schedulePolicy);
    const dailyQuotaPolicy =
      options.dailyQuotaPolicy === undefined
        ? null
        : documents.dailyQuotaPolicy(factoryDailyQuotaPolicySchema.parse(options.dailyQuotaPolicy));
    const roleIdentityPolicy =
      options.roleIdentityPolicy === undefined
        ? null
        : documents.roleIdentityPolicy(options.roleIdentityPolicy);
    if (
      (roleIdentityPolicy === null) !==
      (options.expectedRoleIdentityPolicyDigest === undefined)
    ) {
      throw new Error("Factory broker role identity policy and reviewed digest must be paired.");
    }
    if (
      roleIdentityPolicy !== null &&
      roleIdentityPolicy.digest !== options.expectedRoleIdentityPolicyDigest
    ) {
      throw new Error("Factory broker role identity policy changed after review.");
    }
    if (
      (schedulePolicy === null) !== (roleIdentityPolicy === null) ||
      (schedulePolicy === null) !== (dailyQuotaPolicy === null)
    ) {
      throw new Error(
        "Factory canary broker schedule, daily quota, and role policies must be configured together."
      );
    }
    if (
      dailyQuotaPolicy !== null &&
      !dailyQuotaPolicy.value.repositories.some(
        ({ repositoryId }) => repositoryId === options.repositoryId
      )
    ) {
      throw new Error("Factory broker repository is not authorized by its daily quota policy.");
    }
    const autonomousMergePolicy =
      options.autonomousMergePolicy === undefined
        ? null
        : documents.autonomousMergePolicy(
            factoryAutonomousMergePolicySchema.parse(options.autonomousMergePolicy)
          );
    if (
      [
        autonomousMergePolicy,
        options.expectedAutonomousMergePolicyDigest,
        options.expectedFactoryPolicyBundleDigest
      ].filter((value) => value !== null && value !== undefined).length !== 0 &&
      (autonomousMergePolicy === null ||
        options.expectedAutonomousMergePolicyDigest === undefined ||
        options.expectedFactoryPolicyBundleDigest === undefined)
    ) {
      throw new Error(
        "Factory broker autonomous merge policy and reviewed digests must be paired."
      );
    }
    if (
      autonomousMergePolicy !== null &&
      (autonomousMergePolicy.digest !== options.expectedAutonomousMergePolicyDigest ||
        autonomousMergePolicy.value.repositoryId !== options.repositoryId ||
        schedulePolicy === null ||
        dailyQuotaPolicy === null ||
        roleIdentityPolicy === null ||
        autonomousMergePolicy.value.schedulePolicyDigest !== schedulePolicy.digest ||
        autonomousMergePolicy.value.dailyQuotaPolicyDigest !== dailyQuotaPolicy.digest ||
        autonomousMergePolicy.value.roleIdentityPolicyDigest !== roleIdentityPolicy.digest)
    ) {
      throw new Error("Factory broker autonomous merge policy coordinates changed after review.");
    }
    if (autonomousMergePolicy !== null) {
      assertFactoryProcessUserIdentity(
        "PR broker",
        autonomousMergePolicy.value.prBrokerUserId,
        process.getuid?.()
      );
    }
    const databasePath = writerLease.databasePath;
    const conversations = repositories.track(new SqliteConversationRepository(databasePath));
    const factory = repositories.track(new SqliteFactoryRepository(databasePath, { documents }));
    const preparations = repositories.track(
      new SqliteFactoryPreparationRepository(databasePath, { documents })
    );
    const canaryReservations = repositories.track(
      new SqliteFactoryCanaryReservationRepository(databasePath, { documents })
    );
    const dailyQuotas = repositories.track(
      new SqliteFactoryDailyQuotaRepository(databasePath, { documents })
    );
    const schedules = repositories.track(
      new SqliteFactoryScheduleRepository(databasePath, { documents })
    );
    const canaryBrokerQueue =
      schedulePolicy === null
        ? null
        : repositories.track(new SqliteFactoryCanaryBrokerQueue(databasePath));
    const canaryPullRequestMaintenanceQueue =
      schedulePolicy === null
        ? null
        : repositories.track(new SqliteFactoryCanaryPullRequestMaintenanceQueue(databasePath));
    const canaryPullRequestUpdateQueue =
      schedulePolicy === null
        ? null
        : repositories.track(new SqliteFactoryCanaryPullRequestUpdateQueue(databasePath));
    const dispatches = repositories.track(
      new SqliteFactoryPullRequestDispatchRepository(databasePath, { documents })
    );
    const repairExecutions = repositories.track(
      new SqliteFactoryPullRequestRepairExecutionRepository(databasePath, { documents })
    );
    const updates = repositories.track(
      new SqliteFactoryPullRequestUpdateRepository(databasePath, { documents })
    );
    const artifacts = new FileFactoryArtifactStore(options.artifactRoot);
    const costPolicy = factoryCostPolicySchema.parse(
      options.costPolicy ?? defaultFactoryPolicyBundle.costPolicy
    );
    const policyBundle = encodeCanonicalDocument(
      autonomousMergePolicy === null
        ? { ...defaultFactoryPolicyBundle, costPolicy }
        : createAutonomousR1FactoryPolicyBundle({ costPolicy, mergePolicy: autonomousMergePolicy })
    );
    if (
      autonomousMergePolicy !== null &&
      policyBundle.digest !== options.expectedFactoryPolicyBundleDigest
    ) {
      throw new Error("Factory broker policy bundle changed after review.");
    }
    const policy = new FactoryPolicyEngine(policyBundle.digest, policyBundle.value);
    const now = options.now ?? (() => new Date().toISOString());
    const createId = options.createId ?? randomUUID;
    const canaryAuthority = new FactoryPullRequestCanaryAuthority({
      policyBundleDigest: policyBundle.digest,
      schedulePolicyDigest: schedulePolicy?.digest ?? null,
      roleIdentityPolicyDigest: roleIdentityPolicy?.digest ?? null,
      dailyQuotaPolicy,
      preparations,
      reservations: canaryReservations,
      schedules,
      dailyQuotas: dailyQuotaPolicy === null ? null : dailyQuotas,
      documents,
      now
    });
    const controlPlaneCredential = createFactoryEvidenceCredential();
    const brokerCredential = createFactoryEvidenceCredential();
    const evidenceIngress = new FactoryEvidenceIngress({
      tasks: factory,
      evidence: factory,
      artifacts,
      documents,
      policyBundleDigest: policyBundle.digest,
      bindings: [
        { credential: controlPlaneCredential, channel: "control-plane" },
        { credential: brokerCredential, channel: "pr-broker", producerId: options.brokerId }
      ],
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
    const signer = new NodeGitHubAppJwtSigner(options.githubApp.privateKeySource);
    const tokenSource = new GitHubAppInstallationTokenSource({
      clientId: options.githubApp.clientId,
      installationId: options.githubApp.installationId,
      repositoryId: options.repositoryId,
      repositoryNumericId: options.repositoryNumericId,
      signer,
      api: new GitHubAppInstallationRestClient(),
      ...(options.nowMilliseconds === undefined ? {} : { now: options.nowMilliseconds })
    });
    const api = new GitHubRestClient({ repositoryId: options.repositoryId, tokenSource });
    const remote = new GitHubFactoryPullRequestBroker(new NodeCommandRunner(), {
      repositoryId: options.repositoryId,
      brokerId: options.brokerId,
      tokenSource,
      api,
      documents,
      gitExecutable: options.gitExecutable,
      temporaryRoot: options.temporaryRoot,
      trustedStatusChecks: options.githubApp.trustedStatusChecks
    });
    const pullRequestObserver = new GitHubFactoryPullRequestObserver({
      repositoryId: options.repositoryId,
      brokerId: options.brokerId,
      api,
      documents,
      trustedStatusChecks: options.githubApp.trustedStatusChecks,
      now
    });
    const pullRequests = new FactoryPullRequestService({
      dispatches,
      tasks: factory,
      evidence: factory,
      controls: factory,
      conversations,
      controlPlane,
      evidenceIngress,
      evidenceCredentials: { prBroker: brokerCredential },
      artifacts,
      documents,
      remote,
      canaryAuthority,
      now,
      createId
    });
    const canaryBroker =
      schedulePolicy === null || roleIdentityPolicy === null || canaryBrokerQueue === null
        ? null
        : new FactoryCanaryBrokerService({
            repositoryId: options.repositoryId,
            schedulePolicy,
            factoryPolicyBundleDigest: policyBundle.digest,
            roleIdentityPolicyDigest: roleIdentityPolicy.digest,
            costPolicyConfigured: policyBundle.value.costPolicy.rules.length > 0,
            queue: canaryBrokerQueue,
            pullRequests,
            now
          });
    const pullRequestObservations = new FactoryPullRequestObservationService({
      dispatches,
      updates,
      tasks: factory,
      controls: factory,
      evidenceIngress,
      evidenceCredentials: { prBroker: brokerCredential },
      artifacts,
      documents,
      remote: pullRequestObserver,
      canaryAuthority,
      now,
      createId
    });
    const pullRequestRepairAdmissions = new FactoryPullRequestRepairAdmissionService({
      dispatches,
      updates,
      tasks: factory,
      evidence: factory,
      controls: factory,
      evidenceIngress,
      evidenceCredentials: { prBroker: brokerCredential },
      artifacts,
      documents,
      now,
      createId
    });
    const canaryPullRequestMaintenance =
      schedulePolicy === null ||
      roleIdentityPolicy === null ||
      canaryPullRequestMaintenanceQueue === null
        ? null
        : new FactoryCanaryPullRequestMaintenanceService({
            repositoryId: options.repositoryId,
            schedulePolicy,
            factoryPolicyBundleDigest: policyBundle.digest,
            roleIdentityPolicyDigest: roleIdentityPolicy.digest,
            costPolicyConfigured: policyBundle.value.costPolicy.rules.length > 0,
            queue: canaryPullRequestMaintenanceQueue,
            tasks: factory,
            canaryAuthority,
            observations: pullRequestObservations,
            repairAdmissions: pullRequestRepairAdmissions,
            now
          });
    const pullRequestUpdates = new FactoryPullRequestUpdateService({
      updates,
      dispatches,
      executions: repairExecutions,
      tasks: factory,
      evidence: factory,
      controls: factory,
      conversations,
      controlPlane,
      evidenceIngress,
      evidenceCredentials: { prBroker: brokerCredential },
      artifacts,
      documents,
      remote,
      now,
      createId,
      brokerId: options.brokerId
    });
    const canaryPullRequestUpdates =
      schedulePolicy === null ||
      roleIdentityPolicy === null ||
      canaryPullRequestUpdateQueue === null
        ? null
        : new FactoryCanaryPullRequestUpdateService({
            repositoryId: options.repositoryId,
            brokerId: options.brokerId,
            schedulePolicy,
            factoryPolicyBundleDigest: policyBundle.digest,
            roleIdentityPolicyDigest: roleIdentityPolicy.digest,
            costPolicyConfigured: policyBundle.value.costPolicy.rules.length > 0,
            queue: canaryPullRequestUpdateQueue,
            tasks: factory,
            controls: factory,
            remote,
            canaryAuthority,
            updates: pullRequestUpdates,
            now
          });
    const operator = new FactoryBrokerOperator({
      repositoryId: options.repositoryId,
      policyBundleDigest: policyBundle.digest,
      costPolicyConfigured: policyBundle.value.costPolicy.rules.length > 0,
      remote,
      controls: factory,
      pullRequests,
      pullRequestObservations,
      pullRequestRepairAdmissions,
      pullRequestUpdates,
      canaryBroker,
      canaryPullRequestMaintenance,
      canaryPullRequestUpdates
    });
    return new LocalFactoryBrokerCoordinator({
      operator,
      tasks: new RuntimeTaskOwner(),
      repositories,
      writerLease,
      tokenSource
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
      throw new AggregateError(failures, "Factory broker construction and cleanup failed.");
    }
    throw error;
  }
}

export function createConfiguredLocalFactoryBroker(
  config: LocalFactoryBrokerConfig
): LocalFactoryBrokerRuntime {
  return createLocalFactoryBroker({
    databasePath: config.databasePath,
    artifactRoot: config.artifactRoot,
    temporaryRoot: config.temporaryRoot,
    repositoryId: config.repositoryId,
    repositoryNumericId: config.repositoryNumericId,
    brokerId: config.brokerId,
    gitExecutable: config.gitExecutable,
    ...(config.schemaVersion === "agentlab.local-factory-broker.v1"
      ? {}
      : { costPolicy: config.costPolicy }),
    ...(config.schemaVersion === "agentlab.local-factory-broker.v3" ||
    config.schemaVersion === "agentlab.local-factory-broker.v4" ||
    config.schemaVersion === "agentlab.local-factory-broker.v5"
      ? {
          schedulePolicy: config.schedulePolicy,
          ...(config.schemaVersion === "agentlab.local-factory-broker.v4" ||
          config.schemaVersion === "agentlab.local-factory-broker.v5"
            ? { dailyQuotaPolicy: config.dailyQuotaPolicy }
            : {}),
          roleIdentityPolicy: config.roleIdentityPolicy,
          expectedRoleIdentityPolicyDigest: config.expectedRoleIdentityPolicyDigest,
          ...(config.schemaVersion === "agentlab.local-factory-broker.v5"
            ? {
                autonomousMergePolicy: config.autonomousMergePolicy,
                expectedAutonomousMergePolicyDigest: config.expectedMergePolicyDigest,
                expectedFactoryPolicyBundleDigest: config.expectedFactoryPolicyBundleDigest
              }
            : {})
        }
      : {}),
    githubApp: {
      clientId: config.githubApp.clientId,
      installationId: config.githubApp.installationId,
      privateKeySource: new FileGitHubAppPrivateKeySource(config.githubApp.privateKeyPath),
      trustedStatusChecks: config.githubApp.trustedStatusChecks
    }
  });
}

export type { LocalFactoryBrokerRuntime } from "./application/local-factory-broker-coordinator.js";
export type { FactoryBrokerCommandPort } from "./application/local-factory-broker-coordinator.js";
export type { FactoryBrokerPreflight } from "./application/factory-broker-operator.js";
export type { FactoryCanaryBrokerTickReport } from "./application/factory-canary-broker-service.js";
export type { FactoryCanaryPullRequestMaintenanceTickReport } from "./application/factory-canary-pull-request-maintenance-service.js";
export type { FactoryCanaryPullRequestUpdateTickReport } from "./application/factory-canary-pull-request-update-service.js";
export {
  loadLocalFactoryBrokerConfig,
  type LocalFactoryBrokerConfig
} from "./infrastructure/filesystem/local-factory-broker-config.js";
export type { GitHubAppPrivateKeySource } from "./infrastructure/github/github-app-jwt.js";
