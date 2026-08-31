import { randomUUID } from "node:crypto";

import { factoryCostPolicySchema, type FactoryCostPolicy } from "@agentlab/contracts";

import { FactoryBrokerOperator } from "./application/factory-broker-operator.js";
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
import { FactoryPullRequestObservationService } from "./application/factory-pull-request-observation-service.js";
import { FactoryPullRequestRepairAdmissionService } from "./application/factory-pull-request-repair-admission-service.js";
import { FactoryPolicyEngine, defaultFactoryPolicyBundle } from "./domain/factory-policy.js";
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
import { SqliteFactoryPullRequestDispatchRepository } from "./infrastructure/persistence/sqlite-factory-pull-request-dispatch-repository.js";
import { SqliteFactoryRepository } from "./infrastructure/persistence/sqlite-factory-repository.js";
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
    const databasePath = writerLease.databasePath;
    const conversations = repositories.track(new SqliteConversationRepository(databasePath));
    const factory = repositories.track(new SqliteFactoryRepository(databasePath, { documents }));
    const dispatches = repositories.track(
      new SqliteFactoryPullRequestDispatchRepository(databasePath, { documents })
    );
    const artifacts = new FileFactoryArtifactStore(options.artifactRoot);
    const costPolicy = factoryCostPolicySchema.parse(
      options.costPolicy ?? defaultFactoryPolicyBundle.costPolicy
    );
    const policyBundle = encodeCanonicalDocument({ ...defaultFactoryPolicyBundle, costPolicy });
    const policy = new FactoryPolicyEngine(policyBundle.digest, policyBundle.value);
    const controlPlaneCredential = createFactoryEvidenceCredential();
    const brokerCredential = createFactoryEvidenceCredential();
    const now = options.now ?? (() => new Date().toISOString());
    const createId = options.createId ?? randomUUID;
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
      now,
      createId
    });
    const pullRequestObservations = new FactoryPullRequestObservationService({
      dispatches,
      tasks: factory,
      controls: factory,
      evidenceIngress,
      evidenceCredentials: { prBroker: brokerCredential },
      artifacts,
      documents,
      remote: pullRequestObserver,
      now,
      createId
    });
    const pullRequestRepairAdmissions = new FactoryPullRequestRepairAdmissionService({
      dispatches,
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
    const operator = new FactoryBrokerOperator({
      repositoryId: options.repositoryId,
      policyBundleDigest: policyBundle.digest,
      costPolicyConfigured: policyBundle.value.costPolicy.rules.length > 0,
      remote,
      controls: factory,
      pullRequests,
      pullRequestObservations,
      pullRequestRepairAdmissions
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
    ...(config.schemaVersion === "agentlab.local-factory-broker.v2"
      ? { costPolicy: config.costPolicy }
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
export {
  loadLocalFactoryBrokerConfig,
  type LocalFactoryBrokerConfig
} from "./infrastructure/filesystem/local-factory-broker-config.js";
export type { GitHubAppPrivateKeySource } from "./infrastructure/github/github-app-jwt.js";
