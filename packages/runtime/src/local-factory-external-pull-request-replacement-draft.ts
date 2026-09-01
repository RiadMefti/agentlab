import { randomUUID } from "node:crypto";

import type {
  FactoryExternalPullRequestRepairQualificationPolicy,
  FactoryExternalPullRequestReplacementDraftPolicy,
  FactoryRoleIdentityPolicy,
  Sha256Digest
} from "@agentlab/contracts";

import { FactoryExternalPullRequestReplacementDraftService } from "./application/factory-external-pull-request-replacement-draft-service.js";
import {
  LocalFactoryExternalPullRequestReplacementDraftCoordinator,
  type LocalFactoryExternalPullRequestReplacementDraftRuntime
} from "./application/local-factory-external-pull-request-replacement-draft-coordinator.js";
import { cleanupFailedRuntimeConstruction } from "./application/local-runtime-construction.js";
import { RuntimeRepositoryOwner } from "./application/runtime-repository-owner.js";
import { RuntimeResourceOwner } from "./application/runtime-resource-owner.js";
import { RuntimeTaskOwner } from "./application/runtime-task-owner.js";
import { FileFactoryArtifactStore } from "./infrastructure/filesystem/file-factory-artifact-store.js";
import type { LocalFactoryExternalPullRequestReplacementDraftConfig } from "./infrastructure/filesystem/local-factory-external-pull-request-replacement-draft-config.js";
import { FileGitHubAppPrivateKeySource } from "./infrastructure/github/file-github-app-private-key-source.js";
import { GitHubAppInstallationRestClient } from "./infrastructure/github/github-app-installation-client.js";
import { GitHubAppInstallationTokenSource } from "./infrastructure/github/github-app-installation-token-source.js";
import {
  NodeGitHubAppJwtSigner,
  type GitHubAppPrivateKeySource
} from "./infrastructure/github/github-app-jwt.js";
import { GitHubExternalPullRequestReplacementDraftBroker } from "./infrastructure/github/github-external-pull-request-replacement-draft-broker.js";
import { GitHubRestClient } from "./infrastructure/github/github-rest-client.js";
import { NodeFactoryDocumentCodec } from "./infrastructure/persistence/canonical-factory-documents.js";
import { isUnconfirmedDatabaseInitializationError } from "./infrastructure/persistence/sqlite-database.js";
import { SqliteFactoryControlStateReader } from "./infrastructure/persistence/sqlite-factory-control-state-reader.js";
import { SqliteFactoryExternalPullRequestReplacementDraftRepository } from "./infrastructure/persistence/sqlite-factory-external-pull-request-replacement-draft-repository.js";
import { acquireSqliteWriterLease } from "./infrastructure/persistence/sqlite-writer-lease.js";
import { NodeCommandRunner } from "./infrastructure/process/command-runner.js";

export interface LocalFactoryExternalPullRequestReplacementDraftOptions {
  readonly databasePath: string;
  readonly artifactRoot: string;
  readonly temporaryRoot: string;
  readonly repositoryRoot: string;
  readonly repositoryId: string;
  readonly repositoryNumericId: number;
  readonly publicationPolicy: FactoryExternalPullRequestReplacementDraftPolicy;
  readonly expectedPublicationPolicyDigest: Sha256Digest;
  readonly qualificationPolicy: FactoryExternalPullRequestRepairQualificationPolicy;
  readonly expectedQualificationPolicyDigest: Sha256Digest;
  readonly roleIdentityPolicy: FactoryRoleIdentityPolicy;
  readonly expectedRoleIdentityPolicyDigest: Sha256Digest;
  readonly gitExecutable: string;
  readonly githubApp: {
    readonly clientId: string;
    readonly installationId: number;
    readonly publisherUserId: number;
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

/** Composes only the replacement-draft broker; no model, gate, merge, or release adapter. */
export function createLocalFactoryExternalPullRequestReplacementDraft(
  options: LocalFactoryExternalPullRequestReplacementDraftOptions
): LocalFactoryExternalPullRequestReplacementDraftRuntime {
  const documents = new NodeFactoryDocumentCodec();
  const publicationPolicy = documents.externalPullRequestReplacementDraftPolicy(
    options.publicationPolicy
  );
  const qualificationPolicy = documents.externalPullRequestRepairQualificationPolicy(
    options.qualificationPolicy
  );
  const roleIdentityPolicy = documents.roleIdentityPolicy(options.roleIdentityPolicy);
  if (
    publicationPolicy.digest !== options.expectedPublicationPolicyDigest ||
    qualificationPolicy.digest !== options.expectedQualificationPolicyDigest ||
    roleIdentityPolicy.digest !== options.expectedRoleIdentityPolicyDigest ||
    publicationPolicy.value.repositoryId !== options.repositoryId ||
    qualificationPolicy.value.repositoryId !== options.repositoryId ||
    publicationPolicy.value.qualificationPolicyDigest !== qualificationPolicy.digest ||
    publicationPolicy.value.roleIdentityPolicyDigest !== roleIdentityPolicy.digest ||
    publicationPolicy.value.maximumPatchBytes !== qualificationPolicy.value.maximumPatchBytes ||
    publicationPolicy.value.publisherId !==
      `github-user/${String(options.githubApp.publisherUserId)}` ||
    publicationPolicy.value.brokerUserId === roleIdentityPolicy.value.worker.userId ||
    publicationPolicy.value.brokerUserId === roleIdentityPolicy.value.evalAttestor.userId
  )
    throw new Error("Replacement-draft composition material changed after review.");
  const userId = process.getuid?.();
  if (userId === undefined || userId !== publicationPolicy.value.brokerUserId || userId < 1) {
    throw new Error(
      "Replacement-draft broker process identity does not match its reviewed policy."
    );
  }
  const writerLease = acquireSqliteWriterLease(options.databasePath);
  const repositories = new RuntimeRepositoryOwner();
  try {
    if (writerLease.databasePath === ":memory:")
      throw new Error("Replacement-draft publication requires durable SQLite.");
    const repository = repositories.track(
      new SqliteFactoryExternalPullRequestReplacementDraftRepository(writerLease.databasePath, {
        documents
      })
    );
    const controls = repositories.track(
      new SqliteFactoryControlStateReader(writerLease.databasePath, { documents })
    );
    const artifacts = new FileFactoryArtifactStore(options.artifactRoot);
    const resources = new RuntimeResourceOwner();
    const runner = new NodeCommandRunner({ resourceOwner: resources });
    const signer = new NodeGitHubAppJwtSigner(options.githubApp.privateKeySource);
    const tokenSource = new GitHubAppInstallationTokenSource({
      clientId: options.githubApp.clientId,
      installationId: options.githubApp.installationId,
      repositoryId: options.repositoryId,
      repositoryNumericId: options.repositoryNumericId,
      signer,
      api: new GitHubAppInstallationRestClient(),
      permissionProfile: "pull-request-broker",
      ...(options.nowMilliseconds === undefined ? {} : { now: options.nowMilliseconds })
    });
    const api = new GitHubRestClient({ repositoryId: options.repositoryId, tokenSource });
    const remote = new GitHubExternalPullRequestReplacementDraftBroker(runner, {
      repositoryId: options.repositoryId,
      brokerId: publicationPolicy.value.brokerId,
      tokenSource,
      api,
      documents,
      gitExecutable: options.gitExecutable,
      temporaryRoot: options.temporaryRoot,
      maximumPatchBytes: publicationPolicy.value.maximumPatchBytes,
      publisherUserId: options.githubApp.publisherUserId,
      trustedStatusChecks: options.githubApp.trustedStatusChecks
    });
    const service = new FactoryExternalPullRequestReplacementDraftService({
      repositoryRoot: options.repositoryRoot,
      publicationPolicy,
      repository,
      controls,
      artifacts,
      documents,
      remote,
      now: options.now ?? (() => new Date().toISOString()),
      createId: options.createId ?? randomUUID
    });
    return new LocalFactoryExternalPullRequestReplacementDraftCoordinator({
      service,
      tasks: new RuntimeTaskOwner(),
      resources,
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
    if (failures.length > 1)
      throw new AggregateError(failures, "Replacement-draft broker construction failed.");
    throw error;
  }
}

export function createConfiguredLocalFactoryExternalPullRequestReplacementDraft(
  config: LocalFactoryExternalPullRequestReplacementDraftConfig
): LocalFactoryExternalPullRequestReplacementDraftRuntime {
  return createLocalFactoryExternalPullRequestReplacementDraft({
    ...config,
    githubApp: {
      ...config.githubApp,
      privateKeySource: new FileGitHubAppPrivateKeySource(config.githubApp.privateKeyPath)
    }
  });
}

export {
  loadLocalFactoryExternalPullRequestReplacementDraftConfig,
  type LocalFactoryExternalPullRequestReplacementDraftConfig
} from "./infrastructure/filesystem/local-factory-external-pull-request-replacement-draft-config.js";
export type {
  FactoryExternalPullRequestReplacementDraftPreflight,
  FactoryExternalPullRequestReplacementDraftTickReport
} from "./application/factory-external-pull-request-replacement-draft-service.js";
export type {
  FactoryExternalPullRequestReplacementDraftCommandPort,
  LocalFactoryExternalPullRequestReplacementDraftRuntime
} from "./application/local-factory-external-pull-request-replacement-draft-coordinator.js";
