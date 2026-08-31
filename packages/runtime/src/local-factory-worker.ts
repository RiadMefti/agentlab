import { randomUUID } from "node:crypto";
import { dirname } from "node:path";

import { factoryCostPolicySchema, type FactoryCostPolicy } from "@agentlab/contracts";

import { ArtifactFactorySkillSource } from "./application/artifact-factory-skill-source.js";
import { FactoryControlPlane } from "./application/factory-control-plane.js";
import {
  createFactoryEvidenceCredential,
  FactoryEvidenceIngress
} from "./application/factory-evidence-ingress.js";
import { FactoryExecutionAdmissionService } from "./application/factory-execution-admission-service.js";
import { FactoryExecutionRecoveryService } from "./application/factory-execution-recovery-service.js";
import { FactoryExecutionService } from "./application/factory-execution-service.js";
import { FactoryPreparationMaterializer } from "./application/factory-preparation-materializer.js";
import { FactoryPreparationService } from "./application/factory-preparation-service.js";
import { FactoryPullRequestRepairExecutionService } from "./application/factory-pull-request-repair-execution-service.js";
import { FactoryPullRequestRepairRecoveryService } from "./application/factory-pull-request-repair-recovery-service.js";
import {
  FactoryWorkerOperator,
  validateFactoryWorkerInventory
} from "./application/factory-worker-operator.js";
import { FactoryWorkerTaskRunner } from "./application/factory-worker-task-runner.js";
import {
  LocalFactoryWorkerCoordinator,
  type LocalFactoryWorkerRuntime
} from "./application/local-factory-worker-coordinator.js";
import { cleanupFailedRuntimeConstruction } from "./application/local-runtime-construction.js";
import { RuntimeRepositoryOwner } from "./application/runtime-repository-owner.js";
import { RuntimeResourceOwner } from "./application/runtime-resource-owner.js";
import { RuntimeTaskOwner } from "./application/runtime-task-owner.js";
import { FactoryCostAccountant } from "./domain/factory-cost-accounting.js";
import type { FactoryGateDefinition } from "./domain/factory-gate.js";
import { FactoryPolicyEngine, defaultFactoryPolicyBundle } from "./domain/factory-policy.js";
import { FileFactoryArtifactStore } from "./infrastructure/filesystem/file-factory-artifact-store.js";
import { factoryPathsOverlap } from "./infrastructure/filesystem/factory-workspace-paths.js";
import { GitFactoryRepositoryRevisionReader } from "./infrastructure/filesystem/git-factory-repository-revision.js";
import { GitFactoryWorkspaceManager } from "./infrastructure/filesystem/git-factory-workspace.js";
import type { LocalFactoryWorkerConfig } from "./infrastructure/filesystem/local-factory-worker-config.js";
import {
  encodeCanonicalDocument,
  NodeFactoryDocumentCodec
} from "./infrastructure/persistence/canonical-factory-documents.js";
import { SqliteConversationRepository } from "./infrastructure/persistence/sqlite-conversation-repository.js";
import { isUnconfirmedDatabaseInitializationError } from "./infrastructure/persistence/sqlite-database.js";
import { SqliteFactoryExecutionRepository } from "./infrastructure/persistence/sqlite-factory-execution-repository.js";
import { SqliteFactoryPullRequestDispatchRepository } from "./infrastructure/persistence/sqlite-factory-pull-request-dispatch-repository.js";
import { SqliteFactoryPullRequestRepairExecutionRepository } from "./infrastructure/persistence/sqlite-factory-pull-request-repair-execution-repository.js";
import { SqliteFactoryPullRequestUpdateRepository } from "./infrastructure/persistence/sqlite-factory-pull-request-update-repository.js";
import { SqliteFactoryPreparationRepository } from "./infrastructure/persistence/sqlite-factory-preparation-repository.js";
import { SqliteFactoryRepository } from "./infrastructure/persistence/sqlite-factory-repository.js";
import { SqliteFactoryTaskMaterializer } from "./infrastructure/persistence/sqlite-factory-task-materializer.js";
import { acquireSqliteWriterLease } from "./infrastructure/persistence/sqlite-writer-lease.js";
import { BubblewrapFactoryGateSandbox } from "./infrastructure/process/bubblewrap-factory-gate-sandbox.js";
import { NodeCommandRunner } from "./infrastructure/process/command-runner.js";
import { LocalFactoryGateExecutor } from "./infrastructure/process/local-factory-gate-executor.js";
import { LocalFactoryWorkerHostInspector } from "./infrastructure/process/local-factory-worker-host-inspector.js";
import { SystemdFactoryProcessIsolator } from "./infrastructure/process/systemd-factory-process-isolator.js";
import { LocalFactoryAgentExecutor } from "./infrastructure/providers/local-factory-agent-executor.js";
import {
  PinnedFactoryAgentProviderResolver,
  type FactoryAgentProviderBinding
} from "./infrastructure/providers/pinned-factory-agent-provider-resolver.js";
import { LocalFactoryPreparationRecovery } from "./infrastructure/recovery/local-factory-preparation-recovery.js";
import { LocalFactoryWorkspaceRecovery } from "./infrastructure/recovery/local-factory-workspace-recovery.js";

const controlPlaneActorId = "agentlab-policy";

export interface LocalFactoryWorkerOptions {
  readonly databasePath: string;
  readonly artifactRoot: string;
  readonly workspaceRoot: string;
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
  readonly costPolicy?: FactoryCostPolicy;
  readonly hostEnvironment?: NodeJS.ProcessEnv;
  readonly now?: () => string;
  readonly createId?: () => string;
}

/** Composes only the local execution plane; no GitHub, tmux, or interactive adapter is reachable. */
export function createLocalFactoryWorker(
  options: LocalFactoryWorkerOptions
): LocalFactoryWorkerRuntime {
  const costPolicy = factoryCostPolicySchema.parse(
    options.costPolicy ?? defaultFactoryPolicyBundle.costPolicy
  );
  if (factoryPathsOverlap(options.artifactRoot, options.workspaceRoot)) {
    throw new Error("Factory artifact and worktree roots must not overlap.");
  }
  validateFactoryWorkerInventory(
    options.providers.map(({ provider }) => provider),
    options.gates.map(({ id }) => id)
  );
  const writerLease = acquireSqliteWriterLease(options.databasePath);
  const repositories = new RuntimeRepositoryOwner();
  try {
    if (writerLease.databasePath === ":memory:") {
      throw new Error("The local factory worker requires a durable SQLite database.");
    }
    const documents = new NodeFactoryDocumentCodec();
    const databasePath = writerLease.databasePath;
    const conversations = repositories.track(new SqliteConversationRepository(databasePath));
    const factory = repositories.track(new SqliteFactoryRepository(databasePath, { documents }));
    const preparations = repositories.track(
      new SqliteFactoryPreparationRepository(databasePath, { documents })
    );
    const materializations = repositories.track(
      new SqliteFactoryTaskMaterializer(databasePath, { documents })
    );
    const executions = repositories.track(
      new SqliteFactoryExecutionRepository(databasePath, { documents })
    );
    const pullRequestDispatches = repositories.track(
      new SqliteFactoryPullRequestDispatchRepository(databasePath, { documents })
    );
    const pullRequestRepairs = repositories.track(
      new SqliteFactoryPullRequestRepairExecutionRepository(databasePath, { documents })
    );
    const pullRequestUpdates = repositories.track(
      new SqliteFactoryPullRequestUpdateRepository(databasePath, { documents })
    );
    const artifacts = new FileFactoryArtifactStore(options.artifactRoot);
    const policyBundle = encodeCanonicalDocument({ ...defaultFactoryPolicyBundle, costPolicy });
    const policy = new FactoryPolicyEngine(policyBundle.digest, policyBundle.value);
    const costAccountant = new FactoryCostAccountant(policyBundle.digest, costPolicy);
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
    const recoveryOptions = {
      root: options.workspaceRoot,
      gitExecutable: options.gitExecutable,
      flockExecutable: options.flockExecutable,
      systemctlExecutable: options.systemd.controlExecutable,
      hostEnvironment
    };
    const preparationRecovery = new LocalFactoryPreparationRecovery(runner, recoveryOptions);
    const workspaceRecovery = new LocalFactoryWorkspaceRecovery(runner, recoveryOptions);
    const revisions = new GitFactoryRepositoryRevisionReader(runner, {
      gitExecutable: options.gitExecutable,
      flockExecutable: options.flockExecutable
    });
    const gateSandbox = new BubblewrapFactoryGateSandbox({
      executable: options.sandbox.bubblewrapExecutable,
      runtimeRoots: options.sandbox.runtimeRoots
    });
    const gates = new LocalFactoryGateExecutor(
      options.gates,
      gateSandbox,
      processIsolator,
      runner,
      { now }
    );
    const skills = new ArtifactFactorySkillSource(artifacts, documents);
    const controlPlaneCredential = createFactoryEvidenceCredential();
    const executionObserverCredential = createFactoryEvidenceCredential();
    const gateObserverCredential = createFactoryEvidenceCredential();
    const evidenceIngress = new FactoryEvidenceIngress({
      tasks: factory,
      evidence: factory,
      artifacts,
      documents,
      policyBundleDigest: policyBundle.digest,
      bindings: [
        { credential: controlPlaneCredential, channel: "control-plane" },
        { credential: executionObserverCredential, channel: "execution-observer" },
        { credential: gateObserverCredential, channel: "gate-observer" }
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
    const preparation = new FactoryPreparationService({
      preparations,
      conversations,
      artifacts,
      documents,
      policy,
      skills,
      workspaces,
      agents,
      providers,
      recovery: preparationRecovery,
      now,
      createId,
      controlPlaneActorId
    });
    const materializer = new FactoryPreparationMaterializer({
      preparations,
      tasks: factory,
      conversations,
      materializations,
      artifacts,
      documents,
      policy,
      policyBundle,
      now,
      createId,
      controlPlaneActorId
    });
    const admission = new FactoryExecutionAdmissionService({
      tasks: factory,
      conversations,
      revisions,
      controlPlane
    });
    const executionRecovery = new FactoryExecutionRecoveryService({
      executions,
      tasks: factory,
      evidence: factory,
      conversations,
      controlPlane,
      workspaces: workspaceRecovery,
      documents,
      now,
      createId,
      controlPlaneActorId
    });
    const execution = new FactoryExecutionService({
      executions,
      recovery: executionRecovery,
      tasks: factory,
      evidence: factory,
      conversations,
      controlPlane,
      evidenceIngress,
      evidenceCredentials: {
        controlPlane: controlPlaneCredential,
        executionObserver: executionObserverCredential,
        gateObserver: gateObserverCredential
      },
      artifacts,
      documents,
      policy,
      skills,
      workspaces,
      agents,
      providers,
      gates,
      now,
      createId,
      controlPlaneActorId
    });
    const pullRequestRepairRecovery = new FactoryPullRequestRepairRecoveryService({
      executions: pullRequestRepairs,
      tasks: factory,
      evidence: factory,
      conversations,
      controlPlane,
      workspaces: workspaceRecovery,
      documents,
      now,
      createId,
      controlPlaneActorId
    });
    const pullRequestRepair = new FactoryPullRequestRepairExecutionService({
      executions: pullRequestRepairs,
      recovery: pullRequestRepairRecovery,
      dispatches: pullRequestDispatches,
      updates: pullRequestUpdates,
      tasks: factory,
      evidence: factory,
      conversations,
      controlPlane,
      evidenceIngress,
      evidenceCredentials: {
        controlPlane: controlPlaneCredential,
        executionObserver: executionObserverCredential,
        gateObserver: gateObserverCredential
      },
      artifacts,
      documents,
      policy,
      skills,
      workspaces,
      agents,
      providers,
      gates,
      now,
      createId,
      controlPlaneActorId
    });
    const host = new LocalFactoryWorkerHostInspector(runner, {
      workingDirectory: dirname(databasePath),
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
      hostEnvironment
    });
    const operator = new FactoryWorkerOperator({
      policyBundleDigest: policyBundle.digest,
      costPolicyConfigured: costPolicy.rules.length > 0,
      configuredProviders: options.providers.map(({ provider }) => provider),
      gateIds: gates.availableGateIds(),
      controls: factory,
      host,
      preparation,
      materializer,
      admission,
      execution,
      executionRecovery,
      pullRequestRepair,
      pullRequestRepairRecovery
    });
    const taskRunner = new FactoryWorkerTaskRunner({
      policyBundleDigest: policyBundle.digest,
      preparations,
      tasks: factory,
      executions,
      worker: operator
    });
    return new LocalFactoryWorkerCoordinator({
      operator,
      taskRunner,
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
      throw new AggregateError(failures, "Factory worker construction and cleanup failed.");
    }
    throw error;
  }
}

export function createConfiguredLocalFactoryWorker(
  config: LocalFactoryWorkerConfig
): LocalFactoryWorkerRuntime {
  return createLocalFactoryWorker({
    databasePath: config.databasePath,
    artifactRoot: config.artifactRoot,
    workspaceRoot: config.workspaceRoot,
    gitExecutable: config.gitExecutable,
    flockExecutable: config.flockExecutable,
    systemd: config.systemd,
    sandbox: config.sandbox,
    providers: config.providers,
    gates: config.gates,
    costPolicy: config.costPolicy
  });
}

export type {
  FactoryWorkerCommandPort,
  LocalFactoryWorkerRuntime
} from "./application/local-factory-worker-coordinator.js";
export type { FactoryWorkerPreflight } from "./application/factory-worker-operator.js";
export type { FactoryWorkerTaskRunReport } from "./application/factory-worker-task-runner.js";
export type { FactoryPullRequestRepairExecutionOutcome } from "./application/factory-pull-request-repair-execution-service.js";
export type { FactoryGateDefinition } from "./domain/factory-gate.js";
export {
  loadLocalFactoryWorkerConfig,
  type LocalFactoryWorkerConfig
} from "./infrastructure/filesystem/local-factory-worker-config.js";
export type { FactoryAgentProviderBinding } from "./infrastructure/providers/pinned-factory-agent-provider-resolver.js";
