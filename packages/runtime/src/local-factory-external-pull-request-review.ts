import { randomUUID } from "node:crypto";

import type {
  FactoryCostPolicy,
  FactoryExternalPullRequestReviewPolicy,
  FactoryRoleIdentityPolicy,
  FactorySkillPackage,
  Sha256Digest
} from "@agentlab/contracts";

import { ConfiguredFactorySkillSource } from "./application/configured-factory-skill-source.js";
import { FactoryExternalPullRequestReviewService } from "./application/factory-external-pull-request-review-service.js";
import {
  LocalFactoryExternalPullRequestReviewCoordinator,
  type LocalFactoryExternalPullRequestReviewRuntime
} from "./application/local-factory-external-pull-request-review-coordinator.js";
import { cleanupFailedRuntimeConstruction } from "./application/local-runtime-construction.js";
import { RuntimeRepositoryOwner } from "./application/runtime-repository-owner.js";
import { RuntimeResourceOwner } from "./application/runtime-resource-owner.js";
import { RuntimeTaskOwner } from "./application/runtime-task-owner.js";
import { FactoryCostAccountant } from "./domain/factory-cost-accounting.js";
import { assertFactoryProcessRoleIdentity } from "./domain/factory-role-identity.js";
import { FileFactoryArtifactStore } from "./infrastructure/filesystem/file-factory-artifact-store.js";
import { GitExternalPullRequestReviewWorkspaceManager } from "./infrastructure/filesystem/git-external-pull-request-review-workspace.js";
import { GitFactoryWorkspaceManager } from "./infrastructure/filesystem/git-factory-workspace.js";
import type { LocalFactoryExternalPullRequestReviewConfig } from "./infrastructure/filesystem/local-factory-external-pull-request-review-config.js";
import {
  encodeCanonicalDocument,
  NodeFactoryDocumentCodec
} from "./infrastructure/persistence/canonical-factory-documents.js";
import { isUnconfirmedDatabaseInitializationError } from "./infrastructure/persistence/sqlite-database.js";
import { SqliteFactoryExternalPullRequestReviewRepository } from "./infrastructure/persistence/sqlite-factory-external-pull-request-review-repository.js";
import { acquireSqliteWriterLease } from "./infrastructure/persistence/sqlite-writer-lease.js";
import { NodeCommandRunner } from "./infrastructure/process/command-runner.js";
import { SystemdFactoryProcessIsolator } from "./infrastructure/process/systemd-factory-process-isolator.js";
import { LocalFactoryAgentExecutor } from "./infrastructure/providers/local-factory-agent-executor.js";
import {
  PinnedFactoryAgentProviderResolver,
  type FactoryAgentProviderBinding
} from "./infrastructure/providers/pinned-factory-agent-provider-resolver.js";
import { LocalFactoryWorkspaceRecovery } from "./infrastructure/recovery/local-factory-workspace-recovery.js";

export interface LocalFactoryExternalPullRequestReviewOptions {
  readonly databasePath: string;
  readonly artifactRoot: string;
  readonly workspaceRoot: string;
  readonly repositoryRoot: string;
  readonly repositoryId: string;
  readonly reviewPolicy: FactoryExternalPullRequestReviewPolicy;
  readonly expectedReviewPolicyDigest: Sha256Digest;
  readonly costPolicy: FactoryCostPolicy;
  readonly expectedCostPolicyDigest: Sha256Digest;
  readonly roleIdentityPolicy: FactoryRoleIdentityPolicy;
  readonly expectedRoleIdentityPolicyDigest: Sha256Digest;
  readonly skillPackages: readonly FactorySkillPackage[];
  readonly gitExecutable: string;
  readonly flockExecutable: string;
  readonly systemd: {
    readonly runExecutable: string;
    readonly controlExecutable: string;
    readonly environmentExecutable: string;
    readonly version: string;
  };
  readonly providers: readonly FactoryAgentProviderBinding[];
  readonly hostEnvironment?: NodeJS.ProcessEnv;
  readonly now?: () => string;
  readonly createId?: () => string;
}

/** Composes local review production only; no remote repository credential or write port exists. */
export function createLocalFactoryExternalPullRequestReview(
  options: LocalFactoryExternalPullRequestReviewOptions
): LocalFactoryExternalPullRequestReviewRuntime {
  const documents = new NodeFactoryDocumentCodec();
  const reviewPolicy = documents.externalPullRequestReviewPolicy(options.reviewPolicy);
  const costPolicy = encodeCanonicalDocument(options.costPolicy);
  const roleIdentityPolicy = documents.roleIdentityPolicy(options.roleIdentityPolicy);
  if (
    reviewPolicy.digest !== options.expectedReviewPolicyDigest ||
    costPolicy.digest !== options.expectedCostPolicyDigest ||
    roleIdentityPolicy.digest !== options.expectedRoleIdentityPolicyDigest
  ) {
    throw new Error("External PR review policy material changed after administrator review.");
  }
  if (
    reviewPolicy.value.repositoryId !== options.repositoryId ||
    reviewPolicy.value.discoveryPolicyDigest.length === 0
  ) {
    throw new Error("External PR review policy does not match its repository authority.");
  }
  assertFactoryProcessRoleIdentity(roleIdentityPolicy.value, "worker", process.getuid?.());

  const writerLease = acquireSqliteWriterLease(options.databasePath);
  const repositories = new RuntimeRepositoryOwner();
  try {
    if (writerLease.databasePath === ":memory:") {
      throw new Error("External PR review requires a durable SQLite database.");
    }
    const journal = repositories.track(
      new SqliteFactoryExternalPullRequestReviewRepository(writerLease.databasePath, { documents })
    );
    const artifacts = new FileFactoryArtifactStore(options.artifactRoot);
    const resources = new RuntimeResourceOwner();
    const runner = new NodeCommandRunner({ resourceOwner: resources });
    const now = options.now ?? (() => new Date().toISOString());
    const createId = options.createId ?? randomUUID;
    const hostEnvironment = options.hostEnvironment ?? process.env;
    const processIsolator = new SystemdFactoryProcessIsolator({
      executable: options.systemd.runExecutable,
      environmentExecutable: options.systemd.environmentExecutable,
      version: options.systemd.version,
      hostEnvironment
    });
    const providers = new PinnedFactoryAgentProviderResolver(runner, {
      bindings: options.providers
    });
    const agents = new LocalFactoryAgentExecutor(runner, {
      now,
      processIsolator,
      costAccountant: new FactoryCostAccountant(costPolicy.digest, costPolicy.value),
      hostEnvironment
    });
    const genericWorkspaces = new GitFactoryWorkspaceManager(runner, {
      root: options.workspaceRoot,
      gitExecutable: options.gitExecutable,
      flockExecutable: options.flockExecutable,
      createId,
      resourceOwner: resources
    });
    const workspaces = new GitExternalPullRequestReviewWorkspaceManager(runner, {
      gitExecutable: options.gitExecutable,
      flockExecutable: options.flockExecutable,
      workspaces: genericWorkspaces,
      artifacts
    });
    const recovery = new LocalFactoryWorkspaceRecovery(runner, {
      root: options.workspaceRoot,
      gitExecutable: options.gitExecutable,
      flockExecutable: options.flockExecutable,
      systemctlExecutable: options.systemd.controlExecutable,
      hostEnvironment
    });
    const service = new FactoryExternalPullRequestReviewService({
      repositoryRoot: options.repositoryRoot,
      reviewPolicy,
      costPolicyDigest: costPolicy.digest,
      repository: journal,
      artifacts,
      documents,
      skills: new ConfiguredFactorySkillSource(options.skillPackages, artifacts, documents),
      workspaces,
      recovery,
      agents,
      providers,
      now,
      createId
    });
    return new LocalFactoryExternalPullRequestReviewCoordinator({
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
    if (failures.length > 1) {
      throw new AggregateError(failures, "External PR review construction and cleanup failed.");
    }
    throw error;
  }
}

export function createConfiguredLocalFactoryExternalPullRequestReview(
  config: LocalFactoryExternalPullRequestReviewConfig
): LocalFactoryExternalPullRequestReviewRuntime {
  return createLocalFactoryExternalPullRequestReview({
    ...config,
    reviewPolicy: config.reviewPolicy,
    costPolicy: config.costPolicy,
    roleIdentityPolicy: config.roleIdentityPolicy,
    skillPackages: config.skillPackages
  });
}

export {
  loadLocalFactoryExternalPullRequestReviewConfig,
  type LocalFactoryExternalPullRequestReviewConfig
} from "./infrastructure/filesystem/local-factory-external-pull-request-review-config.js";
export type {
  FactoryExternalPullRequestReviewPreflight,
  FactoryExternalPullRequestReviewTickReport
} from "./application/factory-external-pull-request-review-service.js";
export type {
  FactoryExternalPullRequestReviewCommandPort,
  LocalFactoryExternalPullRequestReviewRuntime
} from "./application/local-factory-external-pull-request-review-coordinator.js";
