import { randomUUID } from "node:crypto";

import type {
  FactoryCostPolicy,
  FactoryExternalPullRequestRepairAdmissionPolicy,
  FactoryExternalPullRequestRepairExecutionPolicy,
  FactoryRoleIdentityPolicy,
  FactorySkillPackage,
  Sha256Digest
} from "@agentlab/contracts";

import { ConfiguredFactorySkillSource } from "./application/configured-factory-skill-source.js";
import { FactoryExternalPullRequestRepairExecutionService } from "./application/factory-external-pull-request-repair-execution-service.js";
import {
  LocalFactoryExternalPullRequestRepairExecutionCoordinator,
  type LocalFactoryExternalPullRequestRepairExecutionRuntime
} from "./application/local-factory-external-pull-request-repair-execution-coordinator.js";
import { cleanupFailedRuntimeConstruction } from "./application/local-runtime-construction.js";
import { RuntimeRepositoryOwner } from "./application/runtime-repository-owner.js";
import { RuntimeResourceOwner } from "./application/runtime-resource-owner.js";
import { RuntimeTaskOwner } from "./application/runtime-task-owner.js";
import { FactoryCostAccountant } from "./domain/factory-cost-accounting.js";
import { assertFactoryProcessRoleIdentity } from "./domain/factory-role-identity.js";
import { FileFactoryArtifactStore } from "./infrastructure/filesystem/file-factory-artifact-store.js";
import { GitExternalPullRequestRepairWorkspaceManager } from "./infrastructure/filesystem/git-external-pull-request-repair-workspace.js";
import { GitExternalPullRequestReviewWorkspaceManager } from "./infrastructure/filesystem/git-external-pull-request-review-workspace.js";
import { GitFactoryWorkspaceManager } from "./infrastructure/filesystem/git-factory-workspace.js";
import type { LocalFactoryExternalPullRequestRepairExecutionConfig } from "./infrastructure/filesystem/local-factory-external-pull-request-repair-execution-config.js";
import {
  encodeCanonicalDocument,
  NodeFactoryDocumentCodec
} from "./infrastructure/persistence/canonical-factory-documents.js";
import { isUnconfirmedDatabaseInitializationError } from "./infrastructure/persistence/sqlite-database.js";
import { SqliteFactoryControlStateReader } from "./infrastructure/persistence/sqlite-factory-control-state-reader.js";
import { SqliteFactoryExternalPullRequestRepairExecutionRepository } from "./infrastructure/persistence/sqlite-factory-external-pull-request-repair-execution-repository.js";
import { acquireSqliteWriterLease } from "./infrastructure/persistence/sqlite-writer-lease.js";
import { NodeCommandRunner } from "./infrastructure/process/command-runner.js";
import { SystemdFactoryProcessIsolator } from "./infrastructure/process/systemd-factory-process-isolator.js";
import { LocalFactoryAgentExecutor } from "./infrastructure/providers/local-factory-agent-executor.js";
import {
  PinnedFactoryAgentProviderResolver,
  type FactoryAgentProviderBinding
} from "./infrastructure/providers/pinned-factory-agent-provider-resolver.js";
import { LocalFactoryWorkspaceRecovery } from "./infrastructure/recovery/local-factory-workspace-recovery.js";

export interface LocalFactoryExternalPullRequestRepairExecutionOptions {
  readonly databasePath: string;
  readonly artifactRoot: string;
  readonly workspaceRoot: string;
  readonly repositoryRoot: string;
  readonly repositoryId: string;
  readonly executionPolicy: FactoryExternalPullRequestRepairExecutionPolicy;
  readonly expectedExecutionPolicyDigest: Sha256Digest;
  readonly admissionPolicy: FactoryExternalPullRequestRepairAdmissionPolicy;
  readonly expectedAdmissionPolicyDigest: Sha256Digest;
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

/** Composes one credentialless repair worker; no GitHub or remote-write port exists. */
export function createLocalFactoryExternalPullRequestRepairExecution(
  options: LocalFactoryExternalPullRequestRepairExecutionOptions
): LocalFactoryExternalPullRequestRepairExecutionRuntime {
  const documents = new NodeFactoryDocumentCodec();
  const executionPolicy = documents.externalPullRequestRepairExecutionPolicy(
    options.executionPolicy
  );
  const admissionPolicy = documents.externalPullRequestRepairAdmissionPolicy(
    options.admissionPolicy
  );
  const costPolicy = encodeCanonicalDocument(options.costPolicy);
  const roleIdentityPolicy = documents.roleIdentityPolicy(options.roleIdentityPolicy);
  if (
    executionPolicy.digest !== options.expectedExecutionPolicyDigest ||
    admissionPolicy.digest !== options.expectedAdmissionPolicyDigest ||
    costPolicy.digest !== options.expectedCostPolicyDigest ||
    roleIdentityPolicy.digest !== options.expectedRoleIdentityPolicyDigest ||
    executionPolicy.value.repositoryId !== options.repositoryId ||
    admissionPolicy.value.repositoryId !== options.repositoryId ||
    admissionPolicy.value.repairExecutionPolicyDigest !== executionPolicy.digest ||
    executionPolicy.value.costPolicyDigest !== costPolicy.digest ||
    executionPolicy.value.roleIdentityPolicyDigest !== roleIdentityPolicy.digest ||
    admissionPolicy.value.costPolicyDigest !== costPolicy.digest ||
    admissionPolicy.value.roleIdentityPolicyDigest !== roleIdentityPolicy.digest ||
    executionPolicy.value.gateProfileDigest !== admissionPolicy.value.gateProfileDigest ||
    executionPolicy.value.repairerProfile.skillDigests.join("\0") !==
      admissionPolicy.value.skillPackageDigests.join("\0") ||
    executionPolicy.value.maximumChangedFiles > admissionPolicy.value.maximumChangedFiles ||
    executionPolicy.value.maximumChangedLines > admissionPolicy.value.maximumChangedLines
  ) {
    throw new Error("External repair worker policy material changed after administrator review.");
  }
  assertFactoryProcessRoleIdentity(roleIdentityPolicy.value, "worker", process.getuid?.());

  const writerLease = acquireSqliteWriterLease(options.databasePath);
  const repositories = new RuntimeRepositoryOwner();
  try {
    if (writerLease.databasePath === ":memory:") {
      throw new Error("External repair worker requires a durable SQLite database.");
    }
    const now = options.now ?? (() => new Date().toISOString());
    const createId = options.createId ?? randomUUID;
    const journal = repositories.track(
      new SqliteFactoryExternalPullRequestRepairExecutionRepository(writerLease.databasePath, {
        documents,
        now
      })
    );
    const controls = repositories.track(
      new SqliteFactoryControlStateReader(writerLease.databasePath, { documents })
    );
    const artifacts = new FileFactoryArtifactStore(options.artifactRoot);
    const resources = new RuntimeResourceOwner();
    const runner = new NodeCommandRunner({ resourceOwner: resources });
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
    const sourceWorkspaces = new GitExternalPullRequestReviewWorkspaceManager(runner, {
      gitExecutable: options.gitExecutable,
      flockExecutable: options.flockExecutable,
      workspaces: genericWorkspaces,
      artifacts
    });
    const workspaces = new GitExternalPullRequestRepairWorkspaceManager(
      sourceWorkspaces,
      genericWorkspaces
    );
    const recovery = new LocalFactoryWorkspaceRecovery(runner, {
      root: options.workspaceRoot,
      gitExecutable: options.gitExecutable,
      flockExecutable: options.flockExecutable,
      systemctlExecutable: options.systemd.controlExecutable,
      hostEnvironment
    });
    const service = new FactoryExternalPullRequestRepairExecutionService({
      repositoryRoot: options.repositoryRoot,
      admissionPolicy,
      executionPolicy,
      repository: journal,
      controls,
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
    return new LocalFactoryExternalPullRequestRepairExecutionCoordinator({
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
      throw new AggregateError(failures, "External repair worker construction failed.");
    }
    throw error;
  }
}

export function createConfiguredLocalFactoryExternalPullRequestRepairExecution(
  config: LocalFactoryExternalPullRequestRepairExecutionConfig
): LocalFactoryExternalPullRequestRepairExecutionRuntime {
  return createLocalFactoryExternalPullRequestRepairExecution({ ...config });
}

export {
  loadLocalFactoryExternalPullRequestRepairExecutionConfig,
  type LocalFactoryExternalPullRequestRepairExecutionConfig
} from "./infrastructure/filesystem/local-factory-external-pull-request-repair-execution-config.js";
export type {
  FactoryExternalPullRequestRepairExecutionPreflight,
  FactoryExternalPullRequestRepairExecutionTickReport
} from "./application/factory-external-pull-request-repair-execution-service.js";
export type {
  FactoryExternalPullRequestRepairExecutionCommandPort,
  LocalFactoryExternalPullRequestRepairExecutionRuntime
} from "./application/local-factory-external-pull-request-repair-execution-coordinator.js";
