import { AgentLabCommands, type AgentLabCommandPort } from "./application/agentlab-commands.js";
import { RuntimeTaskOwner, ownAgentLabCommands } from "./application/runtime-task-owner.js";
import { ConversationService } from "./application/conversation-service.js";
import {
  AttachedSessionTerminal,
  OrderedSessionTerminalCallbacks,
  SessionTerminalOwner,
  parseTerminalDimensions,
  type SessionTerminal,
  type SessionTerminalCallbacks
} from "./application/session-terminal.js";
import type { PseudoTerminalFactory, TerminalHistoryReader } from "./domain/terminal.js";
import type { ProviderCatalog, ProviderCatalogFactory } from "./domain/agent-launcher.js";
import { LocalWorkspacePathResolver } from "./infrastructure/filesystem/local-workspace-path-resolver.js";
import { NodeFolderCompleter } from "./infrastructure/filesystem/node-folder-completer.js";
import { NodeCommandRunner } from "./infrastructure/process/command-runner.js";
import { SqliteConversationRepository } from "./infrastructure/persistence/sqlite-conversation-repository.js";
import { agentLaunchers } from "./infrastructure/providers/agent-launchers.js";
import { BinaryLocator } from "./infrastructure/providers/binary-locator.js";
import {
  LocalProviderCatalog,
  ProviderCapabilityCache
} from "./infrastructure/providers/local-provider-catalog.js";
import { createProviderDiscoveries } from "./infrastructure/providers/provider-discoveries.js";
import { BunTerminalFactory } from "./infrastructure/terminal/bun-terminal.js";
import { TmuxTerminalHistoryReader } from "./infrastructure/terminal/terminal-history.js";
import { TmuxSessionRuntime } from "./infrastructure/tmux/tmux-session-runtime.js";

export { loadLocalConfig, type LocalAppConfig } from "./local-config.js";
export { maximumTerminalDimension } from "./application/session-terminal.js";
export type { SessionTerminal, SessionTerminalCallbacks } from "./application/session-terminal.js";

export type { AgentLabCommandPort } from "./application/agentlab-commands.js";
export type {
  WorkspaceInspection,
  WorkspacePreparation
} from "./application/conversation-service.js";

export interface OpenSessionTerminalInput {
  readonly conversationId: unknown;
  readonly sessionName: unknown;
  readonly columns: unknown;
  readonly rows: unknown;
  readonly callbacks: SessionTerminalCallbacks;
}

export interface LocalAgentLabRuntime {
  readonly commands: AgentLabCommandPort;
  openTerminal(input: OpenSessionTerminalInput): Promise<{
    readonly history: string;
    readonly terminal: SessionTerminal;
    readonly releaseBufferedOutput: () => void;
  }>;
  close(): Promise<void>;
}

export interface LocalAgentLabOptions {
  readonly databasePath: string;
  readonly terminalFactory?: PseudoTerminalFactory;
  readonly terminalHistory?: TerminalHistoryReader;
}

/** Composes the local application with concrete persistence, provider, tmux, and PTY adapters. */
export function createLocalAgentLab(options: LocalAgentLabOptions): LocalAgentLabRuntime {
  const runner = new NodeCommandRunner();
  const repository = new SqliteConversationRepository(options.databasePath);
  const sessions = new TmuxSessionRuntime(runner);
  const providers = providerCatalogFactory(runner);
  const workspacePaths = new LocalWorkspacePathResolver();
  const conversations = new ConversationService({
    repository,
    providers,
    sessions,
    workspacePaths
  });
  const commandTasks = new RuntimeTaskOwner();
  const commandHandler = new AgentLabCommands(conversations, new NodeFolderCompleter());
  const commands = ownAgentLabCommands(commandHandler, commandTasks);
  const terminalFactory = options.terminalFactory ?? new BunTerminalFactory();
  const terminalHistory =
    options.terminalHistory ?? new TmuxTerminalHistoryReader(new NodeCommandRunner());
  const terminalOwner = new SessionTerminalOwner();
  const lifecycle = new RuntimeLifecycle();

  return {
    commands,
    openTerminal(input) {
      return commandTasks.run(async () => {
        lifecycle.assertOpen();
        const target = await commandHandler.requireAttachableSession(
          input.conversationId,
          input.sessionName
        );
        const dimensions = parseTerminalDimensions(input.columns, input.rows);
        const history = await terminalHistory.read(target.sessionName);
        lifecycle.assertOpen();
        const orderedCallbacks = new OrderedSessionTerminalCallbacks(input.callbacks);
        const process = terminalFactory.attach(
          target.sessionName,
          target.workspacePath,
          dimensions
        );
        const ownership: { terminal: AttachedSessionTerminal | null } = { terminal: null };
        const terminal = new AttachedSessionTerminal(process, orderedCallbacks, () => {
          if (ownership.terminal !== null) terminalOwner.release(ownership.terminal);
        });
        ownership.terminal = terminal;
        if (!terminal.closed) terminalOwner.track(terminal);
        return {
          history,
          terminal,
          releaseBufferedOutput() {
            orderedCallbacks.release();
          }
        };
      });
    },
    close() {
      if (!lifecycle.beginClose()) return lifecycle.closed;
      return lifecycle.finishClose(async () => {
        const failures: unknown[] = [];
        let commandsDrained = false;
        try {
          await commandTasks.stopAndDrain();
          commandsDrained = true;
        } catch (error: unknown) {
          failures.push(error);
        }
        // Admitted commands may still own both resources after a drain deadline. Leaving them
        // open is safer than racing a live task; normal bounded operations always take this path.
        if (commandsDrained) {
          try {
            terminalOwner.closeAll();
          } catch (error: unknown) {
            failures.push(error);
          }
          try {
            repository.close();
          } catch (error: unknown) {
            failures.push(error);
          }
        }
        if (failures.length > 0) {
          throw new AggregateError(failures, "The agentlab runtime could not close cleanly.");
        }
      });
    }
  };
}

function providerCatalogFactory(runner: NodeCommandRunner): ProviderCatalogFactory {
  const catalogs = new Map<string, ProviderCatalog>();
  const cache = new ProviderCapabilityCache();
  const discoveries = createProviderDiscoveries(runner);
  const locator = new BinaryLocator(runner);
  return {
    forWorkspace(workspace) {
      let catalog = catalogs.get(workspace);
      if (catalog === undefined) {
        catalog = new LocalProviderCatalog(agentLaunchers, discoveries, locator, runner, {
          workspace,
          cache
        });
        catalogs.set(workspace, catalog);
      }
      return catalog;
    }
  };
}

class RuntimeLifecycle {
  #closed = false;
  #closePromise: Promise<void> | null = null;

  public assertOpen(): void {
    if (this.#closed) throw new Error("The agentlab runtime is closed.");
  }

  public beginClose(): boolean {
    if (this.#closed) return false;
    this.#closed = true;
    return true;
  }

  public get closed(): Promise<void> {
    return this.#closePromise ?? Promise.resolve();
  }

  public finishClose(close: () => Promise<void>): Promise<void> {
    this.#closePromise ??= close();
    return this.#closePromise;
  }
}
