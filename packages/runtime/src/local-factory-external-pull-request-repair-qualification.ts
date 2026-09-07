import { randomUUID } from "node:crypto";

import type {
  FactoryCostPolicy,
  FactoryExternalPullRequestRepairExecutionPolicy,
  FactoryExternalPullRequestRepairQualificationPolicy,
  FactoryRoleIdentityPolicy,
  FactorySkillPackage,
  Sha256Digest
} from "@agentlab/contracts";

import { ConfiguredFactorySkillSource } from "./application/configured-factory-skill-source.js";
import { FactoryExternalPullRequestRepairQualificationService } from "./application/factory-external-pull-request-repair-qualification-service.js";
import {
  LocalFactoryExternalPullRequestRepairQualificationCoordinator,
  type LocalFactoryExternalPullRequestRepairQualificationRuntime
} from "./application/local-factory-external-pull-request-repair-qualification-coordinator.js";
import { cleanupFailedRuntimeConstruction } from "./application/local-runtime-construction.js";
import { RuntimeRepositoryOwner } from "./application/runtime-repository-owner.js";
import { RuntimeResourceOwner } from "./application/runtime-resource-owner.js";
import { RuntimeTaskOwner } from "./application/runtime-task-owner.js";
import { FactoryCostAccountant } from "./domain/factory-cost-accounting.js";
import type { FactoryGateDefinition } from "./domain/factory-gate.js";
import { assertFactoryProcessRoleIdentity } from "./domain/factory-role-identity.js";
import { FileFactoryArtifactStore } from "./infrastructure/filesystem/file-factory-artifact-store.js";
import { GitExternalPullRequestRepairQualificationWorkspaceManager } from "./infrastructure/filesystem/git-external-pull-request-repair-qualification-workspace.js";
import { GitFactoryWorkspaceManager } from "./infrastructure/filesystem/git-factory-workspace.js";
import type { LocalFactoryExternalPullRequestRepairQualificationConfig } from "./infrastructure/filesystem/local-factory-external-pull-request-repair-qualification-config.js";
import {
  encodeCanonicalDocument,
  NodeFactoryDocumentCodec
} from "./infrastructure/persistence/canonical-factory-documents.js";
import { isUnconfirmedDatabaseInitializationError } from "./infrastructure/persistence/sqlite-database.js";
import { SqliteFactoryControlStateReader } from "./infrastructure/persistence/sqlite-factory-control-state-reader.js";
import { SqliteFactoryExternalPullRequestRepairQualificationRepository } from "./infrastructure/persistence/sqlite-factory-external-pull-request-repair-qualification-repository.js";
import { acquireSqliteWriterLease } from "./infrastructure/persistence/sqlite-writer-lease.js";
import { BubblewrapFactoryGateSandbox } from "./infrastructure/process/bubblewrap-factory-gate-sandbox.js";
import { NodeCommandRunner } from "./infrastructure/process/command-runner.js";
import { LocalFactoryGateExecutor } from "./infrastructure/process/local-factory-gate-executor.js";
import { SystemdFactoryProcessIsolator } from "./infrastructure/process/systemd-factory-process-isolator.js";
import { LocalFactoryAgentExecutor } from "./infrastructure/providers/local-factory-agent-executor.js";
import {
  PinnedFactoryAgentProviderResolver,
  type FactoryAgentProviderBinding
} from "./infrastructure/providers/pinned-factory-agent-provider-resolver.js";
import { LocalFactoryWorkspaceRecovery } from "./infrastructure/recovery/local-factory-workspace-recovery.js";

export interface LocalFactoryExternalPullRequestRepairQualificationOptions {
  readonly databasePath: string;
  readonly artifactRoot: string;
  readonly workspaceRoot: string;
  readonly repositoryRoot: string;
  readonly repositoryId: string;
  readonly qualificationPolicy: FactoryExternalPullRequestRepairQualificationPolicy;
  readonly expectedQualificationPolicyDigest: Sha256Digest;
  readonly repairExecutionPolicy: FactoryExternalPullRequestRepairExecutionPolicy;
  readonly expectedRepairExecutionPolicyDigest: Sha256Digest;
  readonly costPolicy: FactoryCostPolicy;
  readonly expectedCostPolicyDigest: Sha256Digest;
  readonly roleIdentityPolicy: FactoryRoleIdentityPolicy;
  readonly expectedRoleIdentityPolicyDigest: Sha256Digest;
  readonly skillPackages: readonly FactorySkillPackage[];
  readonly gates: readonly FactoryGateDefinition[];
  readonly gitExecutable: string;
  readonly flockExecutable: string;
  readonly systemd: {
    readonly runExecutable: string;
    readonly controlExecutable: string;
    readonly environmentExecutable: string;
    readonly version: string;
  };
  readonly sandbox: {
    readonly bubblewrapExecutable: string;
    readonly runtimeRoots: readonly string[];
  };
  readonly providers: readonly FactoryAgentProviderBinding[];
  readonly hostEnvironment?: NodeJS.ProcessEnv;
  readonly now?: () => string;
  readonly createId?: () => string;
}

/** Composes strict gates and read-only reviewers without any GitHub or remote-write port. */
export function createLocalFactoryExternalPullRequestRepairQualification(
  options: LocalFactoryExternalPullRequestRepairQualificationOptions
): LocalFactoryExternalPullRequestRepairQualificationRuntime {
  const documents = new NodeFactoryDocumentCodec();
  const qualificationPolicy = documents.externalPullRequestRepairQualificationPolicy(
    options.qualificationPolicy
  );
  const repairExecutionPolicy = documents.externalPullRequestRepairExecutionPolicy(
    options.repairExecutionPolicy
  );
  const costPolicy = encodeCanonicalDocument(options.costPolicy);
  const roleIdentityPolicy = documents.roleIdentityPolicy(options.roleIdentityPolicy);
  const gateProfile = documents.externalPullRequestRepairGateProfile(
    qualificationPolicy.value.gateProfile
  );
  const skillDigests = options.skillPackages.map(
    (skillPackage) => documents.skillPackage(skillPackage).digest
  );
  const expectedSkillDigests = [
    ...new Set(
      qualificationPolicy.value.reviewerProfiles.flatMap(({ skillDigests }) => skillDigests)
    )
  ];
  if (
    qualificationPolicy.digest !== options.expectedQualificationPolicyDigest ||
    repairExecutionPolicy.digest !== options.expectedRepairExecutionPolicyDigest ||
    costPolicy.digest !== options.expectedCostPolicyDigest ||
    roleIdentityPolicy.digest !== options.expectedRoleIdentityPolicyDigest ||
    qualificationPolicy.value.repositoryId !== options.repositoryId ||
    repairExecutionPolicy.value.repositoryId !== options.repositoryId ||
    repairExecutionPolicy.value.qualificationPolicyDigest !== qualificationPolicy.digest ||
    qualificationPolicy.value.costPolicyDigest !== costPolicy.digest ||
    repairExecutionPolicy.value.costPolicyDigest !== costPolicy.digest ||
    qualificationPolicy.value.roleIdentityPolicyDigest !== roleIdentityPolicy.digest ||
    repairExecutionPolicy.value.roleIdentityPolicyDigest !== roleIdentityPolicy.digest ||
    qualificationPolicy.value.gateProfileDigest !== gateProfile.digest ||
    repairExecutionPolicy.value.gateProfileDigest !== gateProfile.digest ||
    options.gates.map(({ id }) => id).join("\0") !==
      qualificationPolicy.value.gateProfile.gates.map(({ id }) => id).join("\0") ||
    skillDigests.join("\0") !== expectedSkillDigests.join("\0") ||
    qualificationPolicy.value.reviewerProfiles.some(
      ({ id }) => id === repairExecutionPolicy.value.repairerProfile.id
    )
  ) {
    throw new Error("External repair qualification material changed after administrator review.");
  }
  assertFactoryProcessRoleIdentity(roleIdentityPolicy.value, "worker", process.getuid?.());

  const writerLease = acquireSqliteWriterLease(options.databasePath);
  const repositories = new RuntimeRepositoryOwner();
  try {
    if (writerLease.databasePath === ":memory:") {
      throw new Error("External repair qualification requires a durable SQLite database.");
    }
    const now = options.now ?? (() => new Date().toISOString());
    const createId = options.createId ?? randomUUID;
    const repository = repositories.track(
      new SqliteFactoryExternalPullRequestRepairQualificationRepository(writerLease.databasePath, {
        documents
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
    const workspaces = new GitExternalPullRequestRepairQualificationWorkspaceManager(
      genericWorkspaces,
      artifacts
    );
    const recovery = new LocalFactoryWorkspaceRecovery(runner, {
      root: options.workspaceRoot,
      gitExecutable: options.gitExecutable,
      flockExecutable: options.flockExecutable,
      systemctlExecutable: options.systemd.controlExecutable,
      hostEnvironment
    });
    const gates = new LocalFactoryGateExecutor(
      options.gates,
      new BubblewrapFactoryGateSandbox({
        executable: options.sandbox.bubblewrapExecutable,
        runtimeRoots: options.sandbox.runtimeRoots
      }),
      processIsolator,
      runner,
      { now }
    );
    const service = new FactoryExternalPullRequestRepairQualificationService({
      repositoryRoot: options.repositoryRoot,
      qualificationPolicy,
      repairExecutionPolicy,
      repository,
      controls,
      artifacts,
      documents,
      skills: new ConfiguredFactorySkillSource(options.skillPackages, artifacts, documents),
      workspaces,
      recovery,
      gates,
      agents,
      providers,
      now,
      createId
    });
    return new LocalFactoryExternalPullRequestRepairQualificationCoordinator({
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
      throw new AggregateError(failures, "External repair qualification construction failed.");
    }
    throw error;
  }
}

export function createConfiguredLocalFactoryExternalPullRequestRepairQualification(
  config: LocalFactoryExternalPullRequestRepairQualificationConfig
): LocalFactoryExternalPullRequestRepairQualificationRuntime {
  return createLocalFactoryExternalPullRequestRepairQualification({ ...config });
}

export {
  loadLocalFactoryExternalPullRequestRepairQualificationConfig,
  type LocalFactoryExternalPullRequestRepairQualificationConfig
} from "./infrastructure/filesystem/local-factory-external-pull-request-repair-qualification-config.js";
export type {
  FactoryExternalPullRequestRepairQualificationPreflight,
  FactoryExternalPullRequestRepairQualificationTickReport
} from "./application/factory-external-pull-request-repair-qualification-service.js";
export type {
  FactoryExternalPullRequestRepairQualificationCommandPort,
  LocalFactoryExternalPullRequestRepairQualificationRuntime
} from "./application/local-factory-external-pull-request-repair-qualification-coordinator.js";
