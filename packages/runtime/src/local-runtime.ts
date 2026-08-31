import { randomUUID } from "node:crypto";

import { AgentLabCommands } from "./application/agentlab-commands.js";
import { cleanupFailedRuntimeConstruction } from "./application/local-runtime-construction.js";
import { ownAgentLabCommands } from "./application/owned-agentlab-commands.js";
import { RuntimeTaskOwner } from "./application/runtime-task-owner.js";
import { RuntimeResourceOwner } from "./application/runtime-resource-owner.js";
import { ConversationService } from "./application/conversation-service.js";
import {
  LocalRuntimeCoordinator,
  type LocalAgentLabRuntime
} from "./application/local-runtime-coordinator.js";
import type {
  ManagedPseudoTerminalFactory,
  ManagedTerminalHistoryReader,
  PseudoTerminalFactory,
  TerminalHistoryReader
} from "./domain/terminal.js";
import type { ProviderCatalog, ProviderCatalogFactory } from "./domain/agent-launcher.js";
import { LocalWorkspacePathResolver } from "./infrastructure/filesystem/local-workspace-path-resolver.js";
import { NodeFolderCompleter } from "./infrastructure/filesystem/node-folder-completer.js";
import { NodeCommandRunner } from "./infrastructure/process/command-runner.js";
import {
  isUnconfirmedDatabaseInitializationError,
  SqliteConversationRepository
} from "./infrastructure/persistence/sqlite-conversation-repository.js";
import { acquireSqliteWriterLease } from "./infrastructure/persistence/sqlite-writer-lease.js";
import { agentLaunchers } from "./infrastructure/providers/agent-launchers.js";
import { BinaryLocator } from "./infrastructure/providers/binary-locator.js";
import {
  LocalProviderCatalog,
  ProviderCapabilityCache
} from "./infrastructure/providers/local-provider-catalog.js";
import { createProviderDiscoveries } from "./infrastructure/providers/provider-discoveries.js";
import { BunTerminalFactory } from "./infrastructure/terminal/bun-terminal.js";
import {
  adaptLegacyTerminalFactory,
  adaptLegacyTerminalHistoryReader
} from "./infrastructure/terminal/legacy-terminal-adapter.js";
import { TmuxTerminalHistoryReader } from "./infrastructure/terminal/terminal-history.js";
import { TmuxSessionRuntime } from "./infrastructure/tmux/tmux-session-runtime.js";
import { TmuxCaptainPolicyRenderer } from "./infrastructure/tmux/captain-policy.js";
import { assertSupportedTmuxVersion } from "./infrastructure/tmux/tmux-version.js";

export { loadLocalConfig, type LocalAppConfig } from "./infrastructure/filesystem/local-config.js";
export { maximumTerminalDimension } from "./application/session-terminal.js";
export type {
  BufferedTerminalRelease,
  SessionTerminal,
  SessionTerminalCallbacks
} from "./application/session-terminal.js";
export type {
  Disposable,
  ManagedPseudoTerminal,
  ManagedPseudoTerminalFactory,
  ManagedTerminalHistoryReader,
  ManagedTerminalResource,
  ManagedTerminalResourceOwner,
  PseudoTerminal,
  PseudoTerminalFactory,
  TerminalHistoryReader,
  TerminalDimensions
} from "./domain/terminal.js";
export type { SessionAttachmentTarget } from "./domain/session-runtime.js";
export type {
  LocalAgentLabRuntime,
  OpenSessionTerminalInput
} from "./application/local-runtime-coordinator.js";

export type { AgentLabCommandPort } from "./application/agentlab-commands.js";
export type {
  WorkspaceInspection,
  WorkspacePreparation
} from "./application/conversation-operations.js";

export interface LocalAgentLabOptions {
  readonly databasePath: string;
  /** Name-only compatibility seam; accepted only for migrated legacy-name sessions. */
  readonly terminalFactory?: PseudoTerminalFactory;
  /** Name-only compatibility seam; accepted only for migrated legacy-name sessions. */
  readonly terminalHistory?: TerminalHistoryReader;
  /** Exact target-aware extension seam for nonce-owned managed sessions. */
  readonly managedTerminalFactory?: ManagedPseudoTerminalFactory;
  /** Exact target-aware extension seam for nonce-owned managed sessions. */
  readonly managedTerminalHistory?: ManagedTerminalHistoryReader;
}

/** Composes the local application with concrete persistence, provider, tmux, and PTY adapters. */
export function createLocalAgentLab(options: LocalAgentLabOptions): LocalAgentLabRuntime {
  assertTerminalOptions(options);
  assertSupportedTmuxVersion();
  const writerLease = acquireSqliteWriterLease(options.databasePath);
  let repository: SqliteConversationRepository | null = null;
  try {
    const resourceOwner = new RuntimeResourceOwner();
    const runner = new NodeCommandRunner({ resourceOwner });
    repository = new SqliteConversationRepository(writerLease.databasePath);
    const sessions = new TmuxSessionRuntime(runner);
    const commandTasks = new RuntimeTaskOwner();
    const providers = providerCatalogFactory(runner, commandTasks, resourceOwner);
    const workspacePaths = new LocalWorkspacePathResolver(undefined, undefined, {
      operationOwner: commandTasks
    });
    const conversations = new ConversationService({
      repository,
      providers,
      sessions,
      workspacePaths,
      captainPolicy: new TmuxCaptainPolicyRenderer(),
      now: () => new Date(),
      createId: randomUUID,
      createOwnershipNonce: randomUUID
    });
    const commandHandler = new AgentLabCommands(
      conversations,
      new NodeFolderCompleter(undefined, undefined, undefined, {
        operationOwner: commandTasks
      })
    );
    const commands = ownAgentLabCommands(commandHandler, commandTasks);
    const terminalFactory =
      options.managedTerminalFactory ??
      (options.terminalFactory === undefined
        ? new BunTerminalFactory()
        : adaptLegacyTerminalFactory(options.terminalFactory));
    const terminalHistory =
      options.managedTerminalHistory ??
      (options.terminalHistory === undefined
        ? new TmuxTerminalHistoryReader(runner)
        : adaptLegacyTerminalHistoryReader(options.terminalHistory));
    const readiness = commandTasks.initialize(() => conversations.reconcilePending());
    void readiness.catch(() => undefined);

    return new LocalRuntimeCoordinator({
      commands,
      commandHandler,
      conversations,
      tasks: commandTasks,
      terminalFactory,
      terminalHistory,
      repository,
      writerLease,
      resourceOwner
    });
  } catch (error: unknown) {
    const failures: unknown[] = [
      error,
      ...cleanupFailedRuntimeConstruction(
        repository,
        writerLease,
        !isUnconfirmedDatabaseInitializationError(error)
      )
    ];
    if (failures.length > 1) {
      throw new AggregateError(failures, "Runtime construction and cleanup failed.");
    }
    throw error;
  }
}

function assertTerminalOptions(options: LocalAgentLabOptions): void {
  if (options.terminalFactory !== undefined && options.managedTerminalFactory !== undefined) {
    throw new Error("Configure either terminalFactory or managedTerminalFactory, not both.");
  }
  if (options.terminalHistory !== undefined && options.managedTerminalHistory !== undefined) {
    throw new Error("Configure either terminalHistory or managedTerminalHistory, not both.");
  }
}

function providerCatalogFactory(
  runner: NodeCommandRunner,
  operationOwner: RuntimeTaskOwner,
  resourceOwner: RuntimeResourceOwner
): ProviderCatalogFactory {
  const maximumCatalogs = 64;
  const catalogs = new Map<string, ProviderCatalog>();
  const cache = new ProviderCapabilityCache();
  const discoveries = createProviderDiscoveries(runner, resourceOwner);
  const locator = new BinaryLocator(runner);
  return {
    forWorkspace(workspace) {
      let catalog = catalogs.get(workspace);
      if (catalog === undefined) {
        if (catalogs.size >= maximumCatalogs) {
          const oldest = catalogs.keys().next().value;
          if (oldest !== undefined) catalogs.delete(oldest);
        }
        catalog = new LocalProviderCatalog(agentLaunchers, discoveries, locator, runner, {
          workspace,
          cache,
          operationOwner
        });
        catalogs.set(workspace, catalog);
      } else {
        catalogs.delete(workspace);
        catalogs.set(workspace, catalog);
      }
      return catalog;
    }
  };
}
