import { randomUUID } from "node:crypto";

import {
  factoryCostPolicySchema,
  factoryMaintenanceDiscoveryPolicySchema,
  factoryPreparationAuthorityGrantSchema,
  factorySchedulePolicySchema,
  type FactoryCostPolicy,
  type FactoryMaintenanceDiscoveryPolicy,
  type FactoryPreparationAuthorityGrant,
  type FactoryRoleIdentityPolicy,
  type FactorySchedulePolicy,
  type FactorySkillPackage,
  type Sha256Digest
} from "@agentlab/contracts";

import { FactoryMaintenanceDiscoveryIntake } from "./application/factory-maintenance-discovery-intake.js";
import { FactoryMaintenanceDiscoveryService } from "./application/factory-maintenance-discovery-service.js";
import { FactoryMaintenanceDiscoverySkill } from "./application/factory-maintenance-discovery-skill.js";
import {
  LocalFactoryMaintenanceDiscoveryCoordinator,
  type LocalFactoryMaintenanceDiscoveryRuntime
} from "./application/local-factory-maintenance-discovery-coordinator.js";
import { cleanupFailedRuntimeConstruction } from "./application/local-runtime-construction.js";
import { FactoryPreparationIntakeService } from "./application/factory-preparation-intake-service.js";
import { RuntimeRepositoryOwner } from "./application/runtime-repository-owner.js";
import { RuntimeResourceOwner } from "./application/runtime-resource-owner.js";
import { RuntimeTaskOwner } from "./application/runtime-task-owner.js";
import { FactorySkillPackagePublisher } from "./application/factory-skill-package-publisher.js";
import { FactoryCostAccountant } from "./domain/factory-cost-accounting.js";
import { FactoryPreparationAuthorityIssuer } from "./domain/factory-preparation-authority.js";
import { FactoryPolicyEngine, defaultFactoryPolicyBundle } from "./domain/factory-policy.js";
import { assertFactoryProcessRoleIdentity } from "./domain/factory-role-identity.js";
import type { FactoryGateDefinition } from "./domain/factory-gate.js";
import { FileFactoryArtifactStore } from "./infrastructure/filesystem/file-factory-artifact-store.js";
import { GitFactoryMaintenanceEvidenceInventory } from "./infrastructure/filesystem/git-factory-maintenance-evidence-inventory.js";
import { GitFactoryRepositoryRevisionReader } from "./infrastructure/filesystem/git-factory-repository-revision.js";
import { GitFactoryWorkspaceManager } from "./infrastructure/filesystem/git-factory-workspace.js";
import type { LocalFactoryMaintenanceDiscoveryConfig } from "./infrastructure/filesystem/local-factory-maintenance-discovery-config.js";
import { factoryPathsOverlap } from "./infrastructure/filesystem/factory-workspace-paths.js";
import {
  encodeCanonicalDocument,
  NodeFactoryDocumentCodec
} from "./infrastructure/persistence/canonical-factory-documents.js";
import { CanonicalFactoryIntakeDeduplicator } from "./infrastructure/persistence/canonical-factory-intake-deduplicator.js";
import { SqliteConversationRepository } from "./infrastructure/persistence/sqlite-conversation-repository.js";
import { isUnconfirmedDatabaseInitializationError } from "./infrastructure/persistence/sqlite-database.js";
import { SqliteFactoryMaintenanceDiscoveryRepository } from "./infrastructure/persistence/sqlite-factory-maintenance-discovery-repository.js";
import { SqliteFactoryPreparationRepository } from "./infrastructure/persistence/sqlite-factory-preparation-repository.js";
import { SqliteFactoryRepository } from "./infrastructure/persistence/sqlite-factory-repository.js";
import { acquireSqliteWriterLease } from "./infrastructure/persistence/sqlite-writer-lease.js";
import { NodeCommandRunner } from "./infrastructure/process/command-runner.js";
import { LocalFactoryWorkerHostInspector } from "./infrastructure/process/local-factory-worker-host-inspector.js";
import { SystemdFactoryProcessIsolator } from "./infrastructure/process/systemd-factory-process-isolator.js";
import { LocalFactoryAgentExecutor } from "./infrastructure/providers/local-factory-agent-executor.js";
import {
  PinnedFactoryAgentProviderResolver,
  type FactoryAgentProviderBinding
} from "./infrastructure/providers/pinned-factory-agent-provider-resolver.js";
import { LocalFactoryWorkspaceRecovery } from "./infrastructure/recovery/local-factory-workspace-recovery.js";

const intakeControlPlaneActorId = "agentlab-maintenance-intake-policy";

export interface LocalFactoryMaintenanceDiscoveryOptions {
  readonly databasePath: string;
  readonly artifactRoot: string;
  readonly workspaceRoot: string;
  readonly repositoryRoot: string;
  readonly repositoryId: string;
  readonly conversationId: string;
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
  readonly gates: readonly FactoryGateDefinition[];
  readonly costPolicy: FactoryCostPolicy;
  readonly schedulePolicy: FactorySchedulePolicy;
  readonly roleIdentityPolicy: FactoryRoleIdentityPolicy;
  readonly expectedRoleIdentityPolicyDigest: Sha256Digest;
  readonly discoveryPolicy: FactoryMaintenanceDiscoveryPolicy;
  readonly discoverySkillPackage: FactorySkillPackage;
  readonly preparationGrant: FactoryPreparationAuthorityGrant;
  readonly preparationSkillPackages: readonly FactorySkillPackage[];
  readonly authorityLifetimeSeconds: number;
  readonly hostEnvironment?: NodeJS.ProcessEnv;
  readonly now?: () => string;
  readonly createId?: () => string;
}

/** Composes only credentialless discovery and scheduled intake; no broker or remote write is reachable. */
export function createLocalFactoryMaintenanceDiscovery(
  options: LocalFactoryMaintenanceDiscoveryOptions
): LocalFactoryMaintenanceDiscoveryRuntime {
  const documents = new NodeFactoryDocumentCodec();
  const costPolicy = factoryCostPolicySchema.parse(options.costPolicy);
  const schedulePolicy = documents.schedulePolicy(
    factorySchedulePolicySchema.parse(options.schedulePolicy)
  );
  const roleIdentityPolicy = documents.roleIdentityPolicy(options.roleIdentityPolicy);
  if (roleIdentityPolicy.digest !== options.expectedRoleIdentityPolicyDigest) {
    throw new Error("Maintenance discovery role identity policy changed after review.");
  }
  assertFactoryProcessRoleIdentity(roleIdentityPolicy.value, "worker", process.getuid?.());
  const discoveryPolicy = documents.maintenanceDiscoveryPolicy(
    factoryMaintenanceDiscoveryPolicySchema.parse(options.discoveryPolicy)
  );
  const preparationGrant = factoryPreparationAuthorityGrantSchema.parse(options.preparationGrant);
  const preparationGrantDocument = encodeCanonicalDocument(preparationGrant);
  if (options.authorityLifetimeSeconds > preparationGrant.maximumAuthorityLifetimeSeconds) {
    throw new Error(
      "Maintenance discovery authority lifetime exceeds the reviewed preparation grant."
    );
  }
  validatePolicyRelationship(discoveryPolicy.value, preparationGrant, options.providers);
  for (const [left, right, message] of [
    [
      options.artifactRoot,
      options.workspaceRoot,
      "Discovery artifact and workspace roots must not overlap."
    ],
    [
      options.artifactRoot,
      options.repositoryRoot,
      "Discovery artifact and repository roots must not overlap."
    ],
    [
      options.workspaceRoot,
      options.repositoryRoot,
      "Discovery workspace and repository roots must not overlap."
    ],
    [
      options.databasePath,
      options.repositoryRoot,
      "Discovery database must remain outside the repository."
    ],
    [
      options.databasePath,
      options.artifactRoot,
      "Discovery database must remain outside the artifact root."
    ]
  ] as const) {
    if (factoryPathsOverlap(left, right)) throw new Error(message);
  }
  const writerLease = acquireSqliteWriterLease(options.databasePath);
  const repositories = new RuntimeRepositoryOwner();
  try {
    if (writerLease.databasePath === ":memory:") {
      throw new Error("Maintenance discovery requires durable SQLite.");
    }
    const databasePath = writerLease.databasePath;
    const conversations = repositories.track(new SqliteConversationRepository(databasePath));
    const controls = repositories.track(new SqliteFactoryRepository(databasePath, { documents }));
    const preparations = repositories.track(
      new SqliteFactoryPreparationRepository(databasePath, { documents })
    );
    const discoveries = repositories.track(
      new SqliteFactoryMaintenanceDiscoveryRepository(databasePath, { documents })
    );
    const artifacts = new FileFactoryArtifactStore(options.artifactRoot);
    const policyBundle = encodeCanonicalDocument({ ...defaultFactoryPolicyBundle, costPolicy });
    const policy = new FactoryPolicyEngine(policyBundle.digest, policyBundle.value);
    const costAccountant = new FactoryCostAccountant(policyBundle.digest, costPolicy);
    const authorityIssuer = new FactoryPreparationAuthorityIssuer(
      documents,
      policy,
      preparationGrant
    );
    const preparationSkills = new FactorySkillPackagePublisher(
      documents,
      artifacts,
      preparationGrant,
      options.preparationSkillPackages
    );
    const createId = options.createId ?? randomUUID;
    const now = options.now ?? (() => new Date().toISOString());
    const intakeService = new FactoryPreparationIntakeService(
      documents,
      authorityIssuer,
      preparations,
      artifacts,
      { controlPlaneActorId: intakeControlPlaneActorId, createEventId: createId }
    );
    const intake = new FactoryMaintenanceDiscoveryIntake({
      repositoryId: options.repositoryId,
      conversationId: options.conversationId,
      authorityLifetimeSeconds: options.authorityLifetimeSeconds,
      preparations,
      deduplicator: new CanonicalFactoryIntakeDeduplicator(),
      preparationSkills,
      authorityIssuer,
      intake: intakeService,
      createId
    });
    const discoverySkill = new FactoryMaintenanceDiscoverySkill(
      documents,
      artifacts,
      discoveryPolicy.value,
      options.discoverySkillPackage
    );
    const resources = new RuntimeResourceOwner();
    const runner = new NodeCommandRunner({ resourceOwner: resources });
    const hostEnvironment = options.hostEnvironment ?? process.env;
    const providers = new PinnedFactoryAgentProviderResolver(runner, {
      bindings: options.providers
    });
    const agents = new LocalFactoryAgentExecutor(runner, {
      now,
      processIsolator: new SystemdFactoryProcessIsolator({
        executable: options.systemd.runExecutable,
        environmentExecutable: options.systemd.environmentExecutable,
        version: options.systemd.version,
        hostEnvironment
      }),
      costAccountant,
      hostEnvironment
    });
    const workspaces = new GitFactoryWorkspaceManager(runner, {
      root: options.workspaceRoot,
      gitExecutable: options.gitExecutable,
      flockExecutable: options.flockExecutable,
      createId,
      resourceOwner: resources
    });
    const recovery = new LocalFactoryWorkspaceRecovery(runner, {
      root: options.workspaceRoot,
      gitExecutable: options.gitExecutable,
      flockExecutable: options.flockExecutable,
      systemctlExecutable: options.systemd.controlExecutable,
      hostEnvironment
    });
    const revisions = new GitFactoryRepositoryRevisionReader(runner, {
      gitExecutable: options.gitExecutable,
      flockExecutable: options.flockExecutable
    });
    const host = new LocalFactoryWorkerHostInspector(runner, {
      workingDirectory: options.repositoryRoot,
      artifactRoot: options.artifactRoot,
      workspaceRoot: options.workspaceRoot,
      gitExecutable: options.gitExecutable,
      flockExecutable: options.flockExecutable,
      systemdRunExecutable: options.systemd.runExecutable,
      systemdControlExecutable: options.systemd.controlExecutable,
      environmentExecutable: options.systemd.environmentExecutable,
      systemdVersion: options.systemd.version,
      bubblewrapExecutable: options.sandbox.bubblewrapExecutable,
      runtimeRoots: options.sandbox.runtimeRoots,
      gates: options.gates,
      configuredProviders: options.providers.map(({ provider }) => provider),
      providers,
      hostEnvironment,
      expectedWorkerUserId: roleIdentityPolicy.value.worker.userId
    });
    const discovery = new FactoryMaintenanceDiscoveryService({
      repositoryId: options.repositoryId,
      repositoryRoot: options.repositoryRoot,
      conversationId: options.conversationId,
      discoveryPolicy,
      schedulePolicy,
      factoryPolicyBundleDigest: policyBundle.digest,
      preparationGrantDigest: preparationGrantDocument.digest,
      roleIdentityPolicyDigest: roleIdentityPolicy.digest,
      controls,
      conversations,
      revisions,
      discoveries,
      artifacts,
      documents,
      skill: discoverySkill,
      intake,
      host,
      providers,
      agents,
      workspaces,
      recovery,
      evidenceInventory: new GitFactoryMaintenanceEvidenceInventory(runner, {
        gitExecutable: options.gitExecutable,
        flockExecutable: options.flockExecutable
      }),
      now,
      createId
    });
    return new LocalFactoryMaintenanceDiscoveryCoordinator({
      discovery,
      tasks: new RuntimeTaskOwner(),
      resources,
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
      throw new AggregateError(failures, "Maintenance discovery construction and cleanup failed.");
    }
    throw error;
  }
}

export function createConfiguredLocalFactoryMaintenanceDiscovery(
  config: LocalFactoryMaintenanceDiscoveryConfig
): LocalFactoryMaintenanceDiscoveryRuntime {
  const worker = config.workerConfig;
  return createLocalFactoryMaintenanceDiscovery({
    databasePath: worker.databasePath,
    artifactRoot: worker.artifactRoot,
    workspaceRoot: worker.workspaceRoot,
    repositoryRoot: config.repositoryRoot,
    repositoryId: config.repositoryId,
    conversationId: config.conversationId,
    gitExecutable: worker.gitExecutable,
    flockExecutable: worker.flockExecutable,
    systemd: worker.systemd,
    sandbox: worker.sandbox,
    providers: worker.providers,
    gates: worker.gates,
    costPolicy: worker.costPolicy,
    schedulePolicy: worker.schedulePolicy,
    roleIdentityPolicy: worker.roleIdentityPolicy,
    expectedRoleIdentityPolicyDigest: worker.expectedRoleIdentityPolicyDigest,
    discoveryPolicy: config.discoveryPolicy,
    discoverySkillPackage: config.discoverySkillPackage,
    preparationGrant: config.preparationGrant,
    preparationSkillPackages: config.preparationSkillPackages,
    authorityLifetimeSeconds: config.authorityLifetimeSeconds
  });
}

function validatePolicyRelationship(
  discovery: FactoryMaintenanceDiscoveryPolicy,
  grant: FactoryPreparationAuthorityGrant,
  providers: readonly FactoryAgentProviderBinding[]
): void {
  if (grant.maximumRiskTier !== "R1") {
    throw new Error("Autonomous maintenance discovery requires an R1 preparation ceiling.");
  }
  if (!providers.some(({ provider }) => provider === discovery.profile.provider)) {
    throw new Error("Maintenance discovery provider is not configured in the worker plane.");
  }
  if (
    discovery.allowedIncludePaths.some((path) => !grant.allowedIncludePaths.includes(path)) ||
    grant.protectedPaths.some((path) => !discovery.protectedPaths.includes(path))
  ) {
    throw new Error(
      "Maintenance discovery scope is not a conservative subset of preparation authority."
    );
  }
}

export type {
  FactoryMaintenanceDiscoveryPreflight,
  FactoryMaintenanceDiscoveryTickReport
} from "./application/factory-maintenance-discovery-service.js";
export type {
  FactoryMaintenanceDiscoveryCommandPort,
  LocalFactoryMaintenanceDiscoveryRuntime
} from "./application/local-factory-maintenance-discovery-coordinator.js";
export {
  loadLocalFactoryMaintenanceDiscoveryConfig,
  type LocalFactoryMaintenanceDiscoveryConfig
} from "./infrastructure/filesystem/local-factory-maintenance-discovery-config.js";
