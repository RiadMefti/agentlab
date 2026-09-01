import { randomUUID } from "node:crypto";

import type {
  FactoryExternalPullRequestDiscoveryPolicy,
  FactorySchedulePolicy,
  Sha256Digest
} from "@agentlab/contracts";

import { FactoryExternalPullRequestDiscoveryService } from "./application/factory-external-pull-request-discovery-service.js";
import {
  LocalFactoryExternalPullRequestDiscoveryCoordinator,
  type LocalFactoryExternalPullRequestDiscoveryRuntime
} from "./application/local-factory-external-pull-request-discovery-coordinator.js";
import { cleanupFailedRuntimeConstruction } from "./application/local-runtime-construction.js";
import { RuntimeRepositoryOwner } from "./application/runtime-repository-owner.js";
import { RuntimeTaskOwner } from "./application/runtime-task-owner.js";
import { FileFactoryArtifactStore } from "./infrastructure/filesystem/file-factory-artifact-store.js";
import type { LocalFactoryExternalPullRequestDiscoveryConfig } from "./infrastructure/filesystem/local-factory-external-pull-request-discovery-config.js";
import { FileGitHubAppPrivateKeySource } from "./infrastructure/github/file-github-app-private-key-source.js";
import { GitHubAppInstallationTokenSource } from "./infrastructure/github/github-app-installation-token-source.js";
import {
  NodeGitHubAppJwtSigner,
  type GitHubAppPrivateKeySource
} from "./infrastructure/github/github-app-jwt.js";
import { GitHubExternalPullRequestSource } from "./infrastructure/github/github-external-pull-request-source.js";
import { GitHubReadOnlyInstallationRestClient } from "./infrastructure/github/github-read-only-installation-client.js";
import { GitHubRestClient } from "./infrastructure/github/github-rest-client.js";
import { NodeFactoryDocumentCodec } from "./infrastructure/persistence/canonical-factory-documents.js";
import { isUnconfirmedDatabaseInitializationError } from "./infrastructure/persistence/sqlite-database.js";
import { SqliteFactoryExternalPullRequestDiscoveryRepository } from "./infrastructure/persistence/sqlite-factory-external-pull-request-discovery-repository.js";
import { SqliteFactoryOwnedPullRequestIndex } from "./infrastructure/persistence/sqlite-factory-owned-pull-request-index.js";
import { acquireSqliteWriterLease } from "./infrastructure/persistence/sqlite-writer-lease.js";

export interface LocalFactoryExternalPullRequestDiscoveryOptions {
  readonly databasePath: string;
  readonly artifactRoot: string;
  readonly repositoryId: string;
  readonly repositoryNumericId: number;
  readonly observerId: string;
  readonly discoveryPolicy: FactoryExternalPullRequestDiscoveryPolicy;
  readonly expectedDiscoveryPolicyDigest: Sha256Digest;
  readonly schedulePolicy: FactorySchedulePolicy;
  readonly expectedSchedulePolicyDigest: Sha256Digest;
  readonly githubApp: {
    readonly clientId: string;
    readonly installationId: number;
    readonly privateKeySource: GitHubAppPrivateKeySource;
  };
  readonly now?: () => string;
  readonly nowMilliseconds?: () => number;
  readonly createId?: () => string;
}

/** Composes remote-read inventory only; no model, broker write, merge, or release port is reachable. */
export function createLocalFactoryExternalPullRequestDiscovery(
  options: LocalFactoryExternalPullRequestDiscoveryOptions
): LocalFactoryExternalPullRequestDiscoveryRuntime {
  const writerLease = acquireSqliteWriterLease(options.databasePath);
  const repositories = new RuntimeRepositoryOwner();
  try {
    const documents = new NodeFactoryDocumentCodec();
    const discoveryPolicy = documents.externalPullRequestDiscoveryPolicy(options.discoveryPolicy);
    const schedulePolicy = documents.schedulePolicy(options.schedulePolicy);
    if (
      discoveryPolicy.digest !== options.expectedDiscoveryPolicyDigest ||
      schedulePolicy.digest !== options.expectedSchedulePolicyDigest
    ) {
      throw new Error("External PR discovery policy changed after review.");
    }
    const databasePath = writerLease.databasePath;
    const journal = repositories.track(
      new SqliteFactoryExternalPullRequestDiscoveryRepository(databasePath, { documents })
    );
    const ownedPullRequests = repositories.track(
      new SqliteFactoryOwnedPullRequestIndex(databasePath)
    );
    const signer = new NodeGitHubAppJwtSigner(options.githubApp.privateKeySource);
    const tokenSource = new GitHubAppInstallationTokenSource({
      clientId: options.githubApp.clientId,
      installationId: options.githubApp.installationId,
      repositoryId: options.repositoryId,
      repositoryNumericId: options.repositoryNumericId,
      signer,
      api: new GitHubReadOnlyInstallationRestClient(),
      permissionProfile: "pull-request-reader",
      ...(options.nowMilliseconds === undefined ? {} : { now: options.nowMilliseconds })
    });
    const api = new GitHubRestClient({
      repositoryId: options.repositoryId,
      tokenSource,
      userAgent: "agentlab-factory-pr-reader"
    });
    const source = new GitHubExternalPullRequestSource({
      repositoryId: options.repositoryId,
      repositoryNumericId: options.repositoryNumericId,
      observerId: options.observerId,
      api
    });
    const service = new FactoryExternalPullRequestDiscoveryService({
      repositoryId: options.repositoryId,
      observerId: options.observerId,
      discoveryPolicy,
      schedulePolicy,
      source,
      ownedPullRequests,
      repository: journal,
      artifacts: new FileFactoryArtifactStore(options.artifactRoot),
      documents,
      now: options.now ?? (() => new Date().toISOString()),
      createId: options.createId ?? randomUUID
    });
    return new LocalFactoryExternalPullRequestDiscoveryCoordinator({
      service,
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
      throw new AggregateError(failures, "External PR discovery construction and cleanup failed.");
    }
    throw error;
  }
}

export function createConfiguredLocalFactoryExternalPullRequestDiscovery(
  config: LocalFactoryExternalPullRequestDiscoveryConfig
): LocalFactoryExternalPullRequestDiscoveryRuntime {
  return createLocalFactoryExternalPullRequestDiscovery({
    databasePath: config.databasePath,
    artifactRoot: config.artifactRoot,
    repositoryId: config.repositoryId,
    repositoryNumericId: config.repositoryNumericId,
    observerId: config.observerId,
    discoveryPolicy: config.discoveryPolicy,
    expectedDiscoveryPolicyDigest: config.expectedDiscoveryPolicyDigest,
    schedulePolicy: config.schedulePolicy,
    expectedSchedulePolicyDigest: config.expectedSchedulePolicyDigest,
    githubApp: {
      clientId: config.githubApp.clientId,
      installationId: config.githubApp.installationId,
      privateKeySource: new FileGitHubAppPrivateKeySource(config.githubApp.privateKeyPath)
    }
  });
}

export {
  loadLocalFactoryExternalPullRequestDiscoveryConfig,
  type LocalFactoryExternalPullRequestDiscoveryConfig
} from "./infrastructure/filesystem/local-factory-external-pull-request-discovery-config.js";
export type {
  FactoryExternalPullRequestDiscoveryPreflight,
  FactoryExternalPullRequestDiscoveryTickReport
} from "./application/factory-external-pull-request-discovery-service.js";
export type {
  FactoryExternalPullRequestDiscoveryCommandPort,
  LocalFactoryExternalPullRequestDiscoveryRuntime
} from "./application/local-factory-external-pull-request-discovery-coordinator.js";
export type { GitHubAppPrivateKeySource } from "./infrastructure/github/github-app-jwt.js";
