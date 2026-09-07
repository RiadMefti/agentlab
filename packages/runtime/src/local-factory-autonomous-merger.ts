import { randomUUID } from "node:crypto";

import type {
  FactoryAutonomousMergePolicy,
  FactoryCostPolicy,
  FactoryDailyQuotaPolicy,
  FactoryRoleIdentityPolicy,
  FactorySchedulePolicy,
  Sha256Digest
} from "@agentlab/contracts";

import { FactoryAutonomousMergeService } from "./application/factory-autonomous-merge-service.js";
import { FactoryControlPlane } from "./application/factory-control-plane.js";
import {
  createFactoryEvidenceCredential,
  FactoryEvidenceIngress
} from "./application/factory-evidence-ingress.js";
import {
  LocalFactoryAutonomousMergerCoordinator,
  type LocalFactoryAutonomousMergerRuntime
} from "./application/local-factory-autonomous-merger-coordinator.js";
import { cleanupFailedRuntimeConstruction } from "./application/local-runtime-construction.js";
import { RuntimeRepositoryOwner } from "./application/runtime-repository-owner.js";
import { RuntimeTaskOwner } from "./application/runtime-task-owner.js";
import {
  createAutonomousR1FactoryPolicyBundle,
  FactoryPolicyEngine
} from "./domain/factory-policy.js";
import { FileFactoryArtifactStore } from "./infrastructure/filesystem/file-factory-artifact-store.js";
import type { LocalFactoryAutonomousMergerConfig } from "./infrastructure/filesystem/local-factory-autonomous-merge-config.js";
import { FileGitHubAppPrivateKeySource } from "./infrastructure/github/file-github-app-private-key-source.js";
import { GitHubAppInstallationTokenSource } from "./infrastructure/github/github-app-installation-token-source.js";
import {
  NodeGitHubAppJwtSigner,
  type GitHubAppPrivateKeySource
} from "./infrastructure/github/github-app-jwt.js";
import { GitHubAutonomousMerger } from "./infrastructure/github/github-autonomous-merger.js";
import { GitHubGraphqlClient } from "./infrastructure/github/github-graphql-client.js";
import { GitHubMergerInstallationRestClient } from "./infrastructure/github/github-merger-installation-client.js";
import {
  encodeCanonicalDocument,
  NodeFactoryDocumentCodec
} from "./infrastructure/persistence/canonical-factory-documents.js";
import { SqliteConversationRepository } from "./infrastructure/persistence/sqlite-conversation-repository.js";
import { SqliteFactoryAutonomousMergeRepository } from "./infrastructure/persistence/sqlite-factory-autonomous-merge-repository.js";
import { isUnconfirmedDatabaseInitializationError } from "./infrastructure/persistence/sqlite-database.js";
import { SqliteFactoryRepository } from "./infrastructure/persistence/sqlite-factory-repository.js";
import { acquireSqliteWriterLease } from "./infrastructure/persistence/sqlite-writer-lease.js";

export interface LocalFactoryAutonomousMergerOptions {
  readonly databasePath: string;
  readonly artifactRoot: string;
  readonly repositoryId: string;
  readonly repositoryNumericId: number;
  readonly mergerId: string;
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
  readonly githubApp: {
    readonly clientId: string;
    readonly installationId: number;
    readonly privateKeySource: GitHubAppPrivateKeySource;
  };
  readonly now?: () => string;
  readonly nowMilliseconds?: () => number;
  readonly createId?: () => string;
}

/** Composes only the distinct merger authority plane; no provider/model adapter is loaded. */
export function createLocalFactoryAutonomousMerger(
  options: LocalFactoryAutonomousMergerOptions
): LocalFactoryAutonomousMergerRuntime {
  const userId = process.getuid?.();
  const documents = new NodeFactoryDocumentCodec();
  const mergePolicy = documents.autonomousMergePolicy(options.mergePolicy);
  const schedulePolicy = documents.schedulePolicy(options.schedulePolicy);
  const dailyQuotaPolicy = documents.dailyQuotaPolicy(options.dailyQuotaPolicy);
  const roleIdentityPolicy = documents.roleIdentityPolicy(options.roleIdentityPolicy);
  const policyBundle = encodeCanonicalDocument(
    createAutonomousR1FactoryPolicyBundle({ costPolicy: options.costPolicy, mergePolicy })
  );
  if (
    userId === undefined ||
    userId < 1 ||
    userId !== mergePolicy.value.mergerUserId ||
    options.repositoryId !== mergePolicy.value.repositoryId ||
    options.mergerId !== mergePolicy.value.mergerId ||
    mergePolicy.digest !== options.expectedMergePolicyDigest ||
    schedulePolicy.digest !== options.expectedSchedulePolicyDigest ||
    dailyQuotaPolicy.digest !== options.expectedDailyQuotaPolicyDigest ||
    roleIdentityPolicy.digest !== options.expectedRoleIdentityPolicyDigest ||
    policyBundle.digest !== options.expectedFactoryPolicyBundleDigest ||
    userId === roleIdentityPolicy.value.worker.userId ||
    userId === roleIdentityPolicy.value.evalAttestor.userId
  ) {
    throw new Error("Autonomous merger policies or POSIX identity changed after review.");
  }
  const writerLease = acquireSqliteWriterLease(options.databasePath);
  const repositories = new RuntimeRepositoryOwner();
  try {
    if (writerLease.databasePath === ":memory:") {
      throw new Error("Autonomous merger requires durable SQLite.");
    }
    const databasePath = writerLease.databasePath;
    const conversations = repositories.track(new SqliteConversationRepository(databasePath));
    const factory = repositories.track(new SqliteFactoryRepository(databasePath, { documents }));
    const journal = repositories.track(
      new SqliteFactoryAutonomousMergeRepository(databasePath, { documents })
    );
    const artifacts = new FileFactoryArtifactStore(options.artifactRoot);
    const now = options.now ?? (() => new Date().toISOString());
    const createId = options.createId ?? randomUUID;
    const policy = new FactoryPolicyEngine(policyBundle.digest, policyBundle.value);
    const controlPlaneCredential = createFactoryEvidenceCredential();
    const mergerCredential = createFactoryEvidenceCredential();
    const evidenceIngress = new FactoryEvidenceIngress({
      tasks: factory,
      evidence: factory,
      artifacts,
      documents,
      policyBundleDigest: policyBundle.digest,
      bindings: [
        { credential: controlPlaneCredential, channel: "control-plane" },
        {
          credential: mergerCredential,
          channel: "merge-broker",
          producerId: mergePolicy.value.mergerId
        }
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
      api: new GitHubMergerInstallationRestClient(),
      permissionProfile: "autonomous-merger",
      ...(options.nowMilliseconds === undefined ? {} : { now: options.nowMilliseconds })
    });
    const remote = new GitHubAutonomousMerger({
      repositoryId: options.repositoryId,
      mergerId: options.mergerId,
      api: new GitHubGraphqlClient({
        repositoryId: options.repositoryId,
        tokenSource,
        userAgent: "agentlab-factory-merger"
      })
    });
    const service = new FactoryAutonomousMergeService({
      mergePolicy,
      factoryPolicyBundleDigest: policyBundle.digest,
      repository: journal,
      tasks: factory,
      evidence: factory,
      controls: factory,
      controlPlane,
      artifacts,
      documents,
      evidenceIngress,
      evidenceCredentials: { merger: mergerCredential },
      remote,
      now,
      createId
    });
    return new LocalFactoryAutonomousMergerCoordinator({
      service,
      tasks: new RuntimeTaskOwner(),
      repositories,
      writerLease,
      tokenSource
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
      throw new AggregateError(failures, "Autonomous merger construction failed.");
    }
    throw error;
  }
}

export function createConfiguredLocalFactoryAutonomousMerger(
  config: LocalFactoryAutonomousMergerConfig
): LocalFactoryAutonomousMergerRuntime {
  return createLocalFactoryAutonomousMerger({
    ...config,
    mergePolicy: config.mergePolicy.value,
    githubApp: {
      clientId: config.githubApp.clientId,
      installationId: config.githubApp.installationId,
      privateKeySource: new FileGitHubAppPrivateKeySource(config.githubApp.privateKeyPath)
    }
  });
}

export {
  loadLocalFactoryAutonomousMergerConfig,
  type LocalFactoryAutonomousMergerConfig
} from "./infrastructure/filesystem/local-factory-autonomous-merge-config.js";
export type {
  FactoryAutonomousMergerCommandPort,
  LocalFactoryAutonomousMergerRuntime
} from "./application/local-factory-autonomous-merger-coordinator.js";
export type {
  FactoryAutonomousMergePreflight,
  FactoryAutonomousMergeTickReport
} from "./application/factory-autonomous-merge-service.js";
