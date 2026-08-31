import { randomUUID } from "node:crypto";
import { isAbsolute, parse, resolve } from "node:path";

import {
  factoryCostPolicySchema,
  factoryPreparationAuthorityGrantSchema,
  type FactoryCostPolicy,
  type FactoryPreparationAuthorityGrant,
  type FactorySkillPackage
} from "@agentlab/contracts";

import { FactoryIntakeOperator } from "./application/factory-intake-operator.js";
import {
  LocalFactoryIntakeCoordinator,
  type LocalFactoryIntakeRuntime
} from "./application/local-factory-intake-coordinator.js";
import { cleanupFailedRuntimeConstruction } from "./application/local-runtime-construction.js";
import { FactoryPreparationIntakeService } from "./application/factory-preparation-intake-service.js";
import { RuntimeRepositoryOwner } from "./application/runtime-repository-owner.js";
import { RuntimeResourceOwner } from "./application/runtime-resource-owner.js";
import { RuntimeTaskOwner } from "./application/runtime-task-owner.js";
import { FactorySkillPackagePublisher } from "./application/factory-skill-package-publisher.js";
import { FactoryCostAccountant } from "./domain/factory-cost-accounting.js";
import { FactoryPreparationAuthorityIssuer } from "./domain/factory-preparation-authority.js";
import { FactoryPolicyEngine, defaultFactoryPolicyBundle } from "./domain/factory-policy.js";
import { FileFactoryArtifactStore } from "./infrastructure/filesystem/file-factory-artifact-store.js";
import { factoryPathsOverlap } from "./infrastructure/filesystem/factory-workspace-paths.js";
import { GitFactoryRepositoryRevisionReader } from "./infrastructure/filesystem/git-factory-repository-revision.js";
import type { LocalFactoryIntakeConfig } from "./infrastructure/filesystem/local-factory-intake-config.js";
import {
  encodeCanonicalDocument,
  NodeFactoryDocumentCodec
} from "./infrastructure/persistence/canonical-factory-documents.js";
import { CanonicalFactoryIntakeDeduplicator } from "./infrastructure/persistence/canonical-factory-intake-deduplicator.js";
import { SqliteConversationRepository } from "./infrastructure/persistence/sqlite-conversation-repository.js";
import { isUnconfirmedDatabaseInitializationError } from "./infrastructure/persistence/sqlite-database.js";
import { SqliteFactoryPreparationRepository } from "./infrastructure/persistence/sqlite-factory-preparation-repository.js";
import { acquireSqliteWriterLease } from "./infrastructure/persistence/sqlite-writer-lease.js";
import { NodeCommandRunner } from "./infrastructure/process/command-runner.js";

const intakeControlPlaneActorId = "agentlab-intake-policy";

export interface LocalFactoryIntakeOptions {
  readonly databasePath: string;
  readonly artifactRoot: string;
  readonly repositoryRoot: string;
  readonly repositoryId: string;
  readonly conversationId: string;
  readonly operatorId: string;
  readonly gitExecutable: string;
  readonly flockExecutable: string;
  readonly costPolicy: FactoryCostPolicy;
  readonly preparationGrant: FactoryPreparationAuthorityGrant;
  readonly skillPackages: readonly FactorySkillPackage[];
  readonly authorityLifetimeSeconds: number;
  readonly now?: () => string;
  readonly createId?: () => string;
}

/** Composes only local intake authority; no model, GitHub, scheduler, or broker is reachable. */
export function createLocalFactoryIntake(
  options: LocalFactoryIntakeOptions
): LocalFactoryIntakeRuntime {
  assertDedicatedPath(options.artifactRoot, "Factory artifact root");
  assertDedicatedPath(options.repositoryRoot, "Factory repository root");
  if (factoryPathsOverlap(options.artifactRoot, options.repositoryRoot)) {
    throw new Error("Factory artifact and repository roots must not overlap.");
  }
  const costPolicy = factoryCostPolicySchema.parse(options.costPolicy);
  const grant = factoryPreparationAuthorityGrantSchema.parse(options.preparationGrant);
  const writerLease = acquireSqliteWriterLease(options.databasePath);
  const repositories = new RuntimeRepositoryOwner();
  try {
    if (writerLease.databasePath === ":memory:") {
      throw new Error("The local factory intake requires a durable SQLite database.");
    }
    if (factoryPathsOverlap(writerLease.databasePath, options.repositoryRoot)) {
      throw new Error("Factory database must remain outside the source repository.");
    }
    if (factoryPathsOverlap(writerLease.databasePath, options.artifactRoot)) {
      throw new Error("Factory database must remain outside the artifact root.");
    }
    const documents = new NodeFactoryDocumentCodec();
    const conversations = repositories.track(
      new SqliteConversationRepository(writerLease.databasePath)
    );
    const preparations = repositories.track(
      new SqliteFactoryPreparationRepository(writerLease.databasePath, { documents })
    );
    const artifacts = new FileFactoryArtifactStore(options.artifactRoot);
    const policyBundle = encodeCanonicalDocument({ ...defaultFactoryPolicyBundle, costPolicy });
    const policy = new FactoryPolicyEngine(policyBundle.digest, policyBundle.value);
    const costAccounting = new FactoryCostAccountant(policyBundle.digest, costPolicy);
    const authorityIssuer = new FactoryPreparationAuthorityIssuer(documents, policy, grant);
    const skills = new FactorySkillPackagePublisher(
      documents,
      artifacts,
      grant,
      options.skillPackages
    );
    const resources = new RuntimeResourceOwner();
    const revisions = new GitFactoryRepositoryRevisionReader(
      new NodeCommandRunner({ resourceOwner: resources }),
      { gitExecutable: options.gitExecutable, flockExecutable: options.flockExecutable }
    );
    const createId = options.createId ?? randomUUID;
    const intake = new FactoryPreparationIntakeService(
      documents,
      authorityIssuer,
      preparations,
      artifacts,
      { controlPlaneActorId: intakeControlPlaneActorId, createEventId: createId }
    );
    const operator = new FactoryIntakeOperator({
      repositoryId: options.repositoryId,
      repositoryRoot: options.repositoryRoot,
      conversationId: options.conversationId,
      operatorId: options.operatorId,
      authorityLifetimeSeconds: options.authorityLifetimeSeconds,
      policyBundleDigest: policyBundle.digest,
      grant,
      supportedProviders: ["codex", "claude"],
      conversations,
      revisions,
      preparations,
      deduplicator: new CanonicalFactoryIntakeDeduplicator(),
      skills,
      authorityIssuer,
      intake,
      costAccounting,
      now: options.now ?? (() => new Date().toISOString()),
      createId
    });
    return new LocalFactoryIntakeCoordinator({
      operator,
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
      throw new AggregateError(failures, "Factory intake construction and cleanup failed.");
    }
    throw error;
  }
}

export function createConfiguredLocalFactoryIntake(
  config: LocalFactoryIntakeConfig
): LocalFactoryIntakeRuntime {
  return createLocalFactoryIntake({
    databasePath: config.databasePath,
    artifactRoot: config.artifactRoot,
    repositoryRoot: config.repositoryRoot,
    repositoryId: config.repositoryId,
    conversationId: config.conversationId,
    operatorId: config.operatorId,
    gitExecutable: config.gitExecutable,
    flockExecutable: config.flockExecutable,
    costPolicy: config.costPolicy,
    preparationGrant: config.preparationGrant,
    skillPackages: config.skillPackages,
    authorityLifetimeSeconds: config.authorityLifetimeSeconds
  });
}

function assertDedicatedPath(value: string, label: string): void {
  if (
    !isAbsolute(value) ||
    value.includes("\0") ||
    resolve(value) !== value ||
    value === parse(value).root
  ) {
    throw new Error(`${label} must be a normalized, dedicated non-root path.`);
  }
}

export type {
  FactoryIntakeCommandPort,
  LocalFactoryIntakeRuntime
} from "./application/local-factory-intake-coordinator.js";
export type {
  FactoryIntakePreflight,
  FactoryIntakeRegistrationResult
} from "./application/factory-intake-operator.js";
export {
  loadLocalFactoryIntakeConfig,
  type LocalFactoryIntakeConfig
} from "./infrastructure/filesystem/local-factory-intake-config.js";
export { loadLocalFactoryIntakeSubmission } from "./infrastructure/filesystem/local-factory-intake-submission.js";
