import type { ConversationRepository } from "../domain/conversation-repository.js";
import type { SessionAttachmentTarget } from "../domain/session-runtime.js";
import type {
  ManagedPseudoTerminalFactory,
  ManagedTerminalHistoryReader
} from "../domain/terminal.js";
import type { WriterLease } from "../domain/writer-lease.js";
import type { AgentLabCommandPort } from "./agentlab-commands.js";
import type { RuntimeTaskOwner } from "./runtime-task-owner.js";
import { RuntimeResourceOwner } from "./runtime-resource-owner.js";
import {
  AttachedSessionTerminal,
  OrderedSessionTerminalCallbacks,
  parseTerminalDimensions,
  type BufferedTerminalRelease,
  type SessionTerminal,
  type SessionTerminalCallbacks
} from "./session-terminal.js";

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
    readonly releaseBufferedOutput: () => BufferedTerminalRelease;
  }>;
  close(): Promise<void>;
}

export interface LocalRuntimeCoordinatorDependencies {
  readonly commands: AgentLabCommandPort;
  readonly commandHandler: {
    requireAttachableSession(
      conversationId: unknown,
      sessionName: unknown
    ): Promise<{
      readonly conversationId: string;
      readonly sessionName: string;
      readonly workspacePath: string;
    }>;
  };
  readonly conversations: {
    assertSessionAttachable(
      conversationId: string,
      sessionName: string
    ): Promise<SessionAttachmentTarget>;
  };
  readonly tasks: RuntimeTaskOwner;
  readonly terminalFactory: ManagedPseudoTerminalFactory;
  readonly terminalHistory: ManagedTerminalHistoryReader;
  readonly repository: ConversationRepository;
  readonly writerLease: WriterLease;
  readonly resourceOwner?: RuntimeResourceOwner;
}

/** Owns public command admission, terminal attachment, and retryable resource finalization. */
export class LocalRuntimeCoordinator implements LocalAgentLabRuntime {
  public readonly commands: AgentLabCommandPort;
  readonly #commandHandler: LocalRuntimeCoordinatorDependencies["commandHandler"];
  readonly #conversations: LocalRuntimeCoordinatorDependencies["conversations"];
  readonly #tasks: RuntimeTaskOwner;
  readonly #terminalFactory: ManagedPseudoTerminalFactory;
  readonly #terminalHistory: ManagedTerminalHistoryReader;
  readonly #repository: ConversationRepository;
  readonly #writerLease: WriterLease;
  readonly #resources: RuntimeResourceOwner;
  #closeInFlight: Promise<void> | null = null;
  #resourcesClosed = false;
  #repositoryClosed = false;
  #leaseClosed = false;

  public constructor(dependencies: LocalRuntimeCoordinatorDependencies) {
    this.commands = dependencies.commands;
    this.#commandHandler = dependencies.commandHandler;
    this.#conversations = dependencies.conversations;
    this.#tasks = dependencies.tasks;
    this.#terminalFactory = dependencies.terminalFactory;
    this.#terminalHistory = dependencies.terminalHistory;
    this.#repository = dependencies.repository;
    this.#writerLease = dependencies.writerLease;
    this.#resources = dependencies.resourceOwner ?? new RuntimeResourceOwner();
  }

  public readonly openTerminal: LocalAgentLabRuntime["openTerminal"] = (input) =>
    this.#tasks.run(async () => {
      const target = await this.#commandHandler.requireAttachableSession(
        input.conversationId,
        input.sessionName
      );
      const dimensions = parseTerminalDimensions(input.columns, input.rows);
      const attachmentTarget = await this.#conversations.assertSessionAttachable(
        target.conversationId,
        target.sessionName
      );
      const history = await this.#terminalHistory.read(attachmentTarget);
      const finalTarget = await this.#conversations.assertSessionAttachable(
        target.conversationId,
        target.sessionName
      );
      if (!sameAttachmentTarget(attachmentTarget, finalTarget)) {
        throw new Error("The managed session changed while its terminal history was loading.");
      }
      const orderedCallbacks = new OrderedSessionTerminalCallbacks(input.callbacks);
      const process = this.#terminalFactory.attach(
        finalTarget,
        target.workspacePath,
        dimensions,
        this.#resources
      );
      // The adapter may already have registered the process while constructing it. Set tracking is
      // idempotent, and registering again here closes the ownership gap for extension adapters.
      this.#resources.track(process);
      const ownership: { terminal: AttachedSessionTerminal | null } = { terminal: null };
      let terminal: AttachedSessionTerminal;
      try {
        terminal = new AttachedSessionTerminal(process, orderedCallbacks, () => {
          if (ownership.terminal !== null) this.#resources.release(ownership.terminal);
        });
      } catch (error: unknown) {
        try {
          await process.killAndWait();
          this.#resources.release(process);
        } catch (cleanupError: unknown) {
          throw new AggregateError(
            [error, cleanupError],
            "Terminal attachment setup and cleanup both failed.",
            { cause: error }
          );
        }
        throw error;
      }
      ownership.terminal = terminal;
      if (!terminal.closed) this.#resources.track(terminal);
      this.#resources.release(process);
      return {
        history,
        terminal,
        releaseBufferedOutput() {
          return orderedCallbacks.release();
        }
      };
    });

  public readonly close: LocalAgentLabRuntime["close"] = () => {
    if (this.#leaseClosed) return Promise.resolve();
    if (this.#closeInFlight !== null) return this.#closeInFlight;
    const attempt = this.finalize();
    const shared = attempt.finally(() => {
      if (this.#closeInFlight === shared && !this.#leaseClosed) this.#closeInFlight = null;
    });
    this.#closeInFlight = shared;
    return shared;
  };

  private async finalize(): Promise<void> {
    const failures: unknown[] = [];
    await this.#tasks.stopAndDrain();

    if (!this.#resourcesClosed) {
      try {
        await this.#resources.closeAll();
        this.#resourcesClosed = true;
      } catch (error: unknown) {
        failures.push(error);
      }
    }
    if (!this.#repositoryClosed) {
      try {
        this.#repository.close();
        this.#repositoryClosed = true;
      } catch (error: unknown) {
        failures.push(error);
      }
    }
    if (this.#resourcesClosed && this.#repositoryClosed && !this.#leaseClosed) {
      try {
        this.#writerLease.close();
        this.#leaseClosed = true;
      } catch (error: unknown) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "The AgentLab runtime could not close cleanly.");
    }
  }
}

function sameAttachmentTarget(
  left: SessionAttachmentTarget,
  right: SessionAttachmentTarget
): boolean {
  return (
    left.sessionName === right.sessionName &&
    left.runtimeId === right.runtimeId &&
    left.serverPid === right.serverPid &&
    left.serverStartedAt === right.serverStartedAt &&
    left.ownership.mode === right.ownership.mode &&
    (left.ownership.mode === "legacy-name" ||
      (right.ownership.mode === "nonce" && left.ownership.nonce === right.ownership.nonce))
  );
}
