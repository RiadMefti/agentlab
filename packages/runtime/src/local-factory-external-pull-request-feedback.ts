import { randomUUID } from "node:crypto";

import type { FactoryExternalPullRequestFeedbackPolicy, Sha256Digest } from "@agentlab/contracts";

import { FactoryExternalPullRequestFeedbackService } from "./application/factory-external-pull-request-feedback-service.js";
import {
  LocalFactoryExternalPullRequestFeedbackCoordinator,
  type LocalFactoryExternalPullRequestFeedbackRuntime
} from "./application/local-factory-external-pull-request-feedback-coordinator.js";
import { cleanupFailedRuntimeConstruction } from "./application/local-runtime-construction.js";
import { RuntimeRepositoryOwner } from "./application/runtime-repository-owner.js";
import { RuntimeTaskOwner } from "./application/runtime-task-owner.js";
import { FileFactoryArtifactStore } from "./infrastructure/filesystem/file-factory-artifact-store.js";
import type { LocalFactoryExternalPullRequestFeedbackConfig } from "./infrastructure/filesystem/local-factory-external-pull-request-feedback-config.js";
import { FileGitHubAppPrivateKeySource } from "./infrastructure/github/file-github-app-private-key-source.js";
import { GitHubAppInstallationTokenSource } from "./infrastructure/github/github-app-installation-token-source.js";
import { GitHubExternalPullRequestFeedbackPublisher } from "./infrastructure/github/github-external-pull-request-feedback-publisher.js";
import { GitHubFeedbackInstallationRestClient } from "./infrastructure/github/github-feedback-installation-client.js";
import {
  NodeGitHubAppJwtSigner,
  type GitHubAppPrivateKeySource
} from "./infrastructure/github/github-app-jwt.js";
import { GitHubRestClient } from "./infrastructure/github/github-rest-client.js";
import { NodeFactoryDocumentCodec } from "./infrastructure/persistence/canonical-factory-documents.js";
import { isUnconfirmedDatabaseInitializationError } from "./infrastructure/persistence/sqlite-database.js";
import { SqliteFactoryControlStateReader } from "./infrastructure/persistence/sqlite-factory-control-state-reader.js";
import { SqliteFactoryExternalPullRequestFeedbackRepository } from "./infrastructure/persistence/sqlite-factory-external-pull-request-feedback-repository.js";
import { acquireSqliteWriterLease } from "./infrastructure/persistence/sqlite-writer-lease.js";

export interface LocalFactoryExternalPullRequestFeedbackOptions {
  readonly databasePath: string;
  readonly artifactRoot: string;
  readonly repositoryId: string;
  readonly repositoryNumericId: number;
  readonly processUserId: number;
  readonly feedbackPolicy: FactoryExternalPullRequestFeedbackPolicy;
  readonly expectedFeedbackPolicyDigest: Sha256Digest;
  readonly githubApp: {
    readonly clientId: string;
    readonly installationId: number;
    readonly privateKeySource: GitHubAppPrivateKeySource;
  };
  readonly now?: () => string;
  readonly nowMilliseconds?: () => number;
  readonly createId?: () => string;
}

/** Composes feedback-only GitHub authority: no provider, workspace, branch write, merge, or release. */
export function createLocalFactoryExternalPullRequestFeedback(
  options: LocalFactoryExternalPullRequestFeedbackOptions
): LocalFactoryExternalPullRequestFeedbackRuntime {
  if (process.getuid?.() !== options.processUserId) {
    throw new Error("External PR feedback process does not match its reviewed POSIX user ID.");
  }
  const documents = new NodeFactoryDocumentCodec();
  const policy = documents.externalPullRequestFeedbackPolicy(options.feedbackPolicy);
  if (
    policy.digest !== options.expectedFeedbackPolicyDigest ||
    policy.value.repositoryId !== options.repositoryId
  ) {
    throw new Error("External PR feedback policy changed after administrator review.");
  }
  const writerLease = acquireSqliteWriterLease(options.databasePath);
  const repositories = new RuntimeRepositoryOwner();
  try {
    if (writerLease.databasePath === ":memory:") {
      throw new Error("External PR feedback publication requires a durable SQLite database.");
    }
    const journal = repositories.track(
      new SqliteFactoryExternalPullRequestFeedbackRepository(writerLease.databasePath, {
        documents
      })
    );
    const controls = repositories.track(
      new SqliteFactoryControlStateReader(writerLease.databasePath, { documents })
    );
    const signer = new NodeGitHubAppJwtSigner(options.githubApp.privateKeySource);
    const tokenSource = new GitHubAppInstallationTokenSource({
      clientId: options.githubApp.clientId,
      installationId: options.githubApp.installationId,
      repositoryId: options.repositoryId,
      repositoryNumericId: options.repositoryNumericId,
      signer,
      api: new GitHubFeedbackInstallationRestClient(),
      permissionProfile: "pull-request-feedback",
      ...(options.nowMilliseconds === undefined ? {} : { now: options.nowMilliseconds })
    });
    const publisher = new GitHubExternalPullRequestFeedbackPublisher({
      repositoryId: options.repositoryId,
      repositoryNumericId: options.repositoryNumericId,
      publisherId: policy.value.publisherId,
      publisherUserId: policy.value.publisherUserId,
      api: new GitHubRestClient({
        repositoryId: options.repositoryId,
        tokenSource,
        userAgent: "agentlab-factory-pr-feedback"
      })
    });
    const service = new FactoryExternalPullRequestFeedbackService({
      feedbackPolicy: policy,
      repository: journal,
      artifacts: new FileFactoryArtifactStore(options.artifactRoot),
      documents,
      publisher,
      controls,
      now: options.now ?? (() => new Date().toISOString()),
      createId: options.createId ?? randomUUID
    });
    return new LocalFactoryExternalPullRequestFeedbackCoordinator({
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
      throw new AggregateError(failures, "External PR feedback construction and cleanup failed.");
    }
    throw error;
  }
}

export function createConfiguredLocalFactoryExternalPullRequestFeedback(
  config: LocalFactoryExternalPullRequestFeedbackConfig
): LocalFactoryExternalPullRequestFeedbackRuntime {
  return createLocalFactoryExternalPullRequestFeedback({
    databasePath: config.databasePath,
    artifactRoot: config.artifactRoot,
    repositoryId: config.repositoryId,
    repositoryNumericId: config.repositoryNumericId,
    processUserId: config.processUserId,
    feedbackPolicy: config.feedbackPolicy,
    expectedFeedbackPolicyDigest: config.expectedFeedbackPolicyDigest,
    githubApp: {
      clientId: config.githubApp.clientId,
      installationId: config.githubApp.installationId,
      privateKeySource: new FileGitHubAppPrivateKeySource(config.githubApp.privateKeyPath)
    }
  });
}

export {
  loadLocalFactoryExternalPullRequestFeedbackConfig,
  type LocalFactoryExternalPullRequestFeedbackConfig
} from "./infrastructure/filesystem/local-factory-external-pull-request-feedback-config.js";
export type {
  FactoryExternalPullRequestFeedbackPreflight,
  FactoryExternalPullRequestFeedbackTickReport
} from "./application/factory-external-pull-request-feedback-service.js";
export type {
  FactoryExternalPullRequestFeedbackCommandPort,
  LocalFactoryExternalPullRequestFeedbackRuntime
} from "./application/local-factory-external-pull-request-feedback-coordinator.js";
export type { GitHubAppPrivateKeySource } from "./infrastructure/github/github-app-jwt.js";
