import type {
  AgentSession as ContractAgentSession,
  Conversation as ContractConversation,
  FolderSuggestion as ContractFolderSuggestion,
  ProviderCapability as ContractProviderCapability
} from "@agentlab/contracts";
import {
  createLocalAgentLab,
  loadLocalConfig,
  maximumTerminalDimension,
  type AgentLabCommandPort,
  type BufferedTerminalRelease,
  type Disposable,
  type LocalAgentLabOptions,
  type LocalAgentLabRuntime,
  type LocalAppConfig,
  type ManagedPseudoTerminal,
  type ManagedPseudoTerminalFactory,
  type ManagedTerminalHistoryReader,
  type ManagedTerminalResource,
  type ManagedTerminalResourceOwner,
  type OpenSessionTerminalInput,
  type PseudoTerminal,
  type PseudoTerminalFactory,
  type SessionAttachmentTarget,
  type SessionTerminal,
  type SessionTerminalCallbacks,
  type TerminalDimensions,
  type TerminalHistoryReader,
  type WorkspaceInspection,
  type WorkspacePreparation
} from "@agentlab/runtime";

type Equal<Left, Right> = [Left] extends [Right]
  ? [Right] extends [Left]
    ? [keyof Left] extends [keyof Right]
      ? [keyof Right] extends [keyof Left]
        ? true
        : false
      : false
    : false
  : false;
type Assert<Value extends true> = Value;
type AssertFalse<Value extends false> = Value;

type ExactCallable<Left, Right> =
  NonNullable<Left> extends (...arguments_: infer LeftParameters) => infer LeftReturn
    ? NonNullable<Right> extends (...arguments_: infer RightParameters) => infer RightReturn
      ? Equal<LeftParameters, RightParameters> extends true
        ? Equal<LeftReturn, RightReturn>
        : false
      : false
    : NonNullable<Right> extends (...arguments_: never[]) => unknown
      ? false
      : true;

type ExactMethods<Left, Right, Keys extends keyof Left & keyof Right> = false extends {
  [Key in Keys]: ExactCallable<Left[Key], Right[Key]>;
}[Keys]
  ? false
  : true;

type ExpectedProviderId = "codex" | "claude" | "opencode";

interface ExpectedConversation {
  id: string;
  title: string;
  workspacePath: string | null;
  provider: ExpectedProviderId;
  model: string | null;
  reasoning: string | null;
  captainSessionName: string;
  createdAt: string;
  updatedAt: string;
}

interface ExpectedAgentSession {
  name: string;
  conversationId: string;
  role: "captain" | "worker";
  provider: ExpectedProviderId;
  label: string;
  status: "running" | "stopped";
  attached: boolean;
  startedAt: string | null;
}

interface ExpectedFolderSuggestion {
  value: string;
  label: string;
  symlink: boolean;
}

interface ExpectedReasoningOption {
  id: string;
  label: string;
}

interface ExpectedModelCapability {
  id: string;
  label: string;
  description: string | null;
  defaultReasoning: string | null;
  reasoningOptions: ExpectedReasoningOption[];
}

interface ExpectedProviderCapability {
  id: ExpectedProviderId;
  label: string;
  available: boolean;
  version: string | null;
  reason: string | null;
  source: "live" | "cache" | "stale" | "fallback" | "unavailable";
  discoveredAt: string | null;
  defaultModel: string | null;
  models: ExpectedModelCapability[];
  customModelPolicy: "allowed" | "catalog-only";
}

interface ExpectedDisposable {
  dispose(): void;
}

interface ExpectedPseudoTerminal {
  write(data: Uint8Array): void;
  resize(columns: number, rows: number): void;
  kill(): void;
  onData(listener: (data: string) => void): ExpectedDisposable;
  onExit(listener: (event: { exitCode: number }) => void): ExpectedDisposable;
}

interface ExpectedManagedTerminalResource {
  closeAndWait(): Promise<void>;
}

interface ExpectedManagedPseudoTerminal
  extends ExpectedPseudoTerminal, ExpectedManagedTerminalResource {
  killAndWait(): Promise<void>;
  consumePendingOutputOverrun?(): number | null;
}

interface ExpectedManagedTerminalResourceOwner {
  track(resource: ExpectedManagedTerminalResource): void;
  release(resource: ExpectedManagedTerminalResource): void;
}

interface ExpectedSessionAttachmentTarget {
  readonly sessionName: string;
  readonly runtimeId: string;
  readonly serverPid: string;
  readonly serverStartedAt: string;
  readonly ownership:
    { readonly mode: "nonce"; readonly nonce: string } | { readonly mode: "legacy-name" };
}

interface ExpectedManagedPseudoTerminalFactory {
  attach(
    target: ExpectedSessionAttachmentTarget,
    cwd: string,
    dimensions: { readonly columns: number; readonly rows: number },
    owner: ExpectedManagedTerminalResourceOwner
  ): ExpectedManagedPseudoTerminal;
}

interface ExpectedManagedTerminalHistoryReader {
  read(target: ExpectedSessionAttachmentTarget): Promise<string>;
}

interface ExpectedLocalAgentLabOptions {
  readonly databasePath: string;
  readonly terminalFactory?: {
    attach(
      sessionName: string,
      cwd: string,
      dimensions: { readonly columns: number; readonly rows: number }
    ): ExpectedPseudoTerminal;
  };
  readonly terminalHistory?: {
    read(sessionName: string): Promise<string>;
  };
  readonly managedTerminalFactory?: ExpectedManagedPseudoTerminalFactory;
  readonly managedTerminalHistory?: ExpectedManagedTerminalHistoryReader;
}

interface ExpectedSessionTerminalCallbacks {
  readonly onData: (data: string) => void;
  readonly onExit: (exitCode: number) => void;
}

interface ExpectedOpenSessionTerminalInput {
  readonly conversationId: unknown;
  readonly sessionName: unknown;
  readonly columns: unknown;
  readonly rows: unknown;
  readonly callbacks: ExpectedSessionTerminalCallbacks;
}

interface ExpectedSessionTerminal {
  write(data: Uint8Array): void;
  resize(columns: number, rows: number): void;
  close(): void;
}

interface ExpectedBufferedTerminalRelease {
  readonly bufferedBytes: number;
  readonly overrun: boolean;
}

interface ExpectedAgentLabCommandPort {
  listConversations(): Promise<readonly ExpectedConversation[]>;
  inspectWorkspace(workspacePath: unknown): Promise<ExpectedWorkspaceInspection>;
  prepareWorkspace(workspacePath: unknown): Promise<ExpectedWorkspacePreparation>;
  discoverWorkspaceProviders(
    workspacePath: unknown
  ): Promise<readonly ExpectedProviderCapability[]>;
  completeFolders(input: unknown): Promise<readonly ExpectedFolderSuggestion[]>;
  listProviders(conversationId: unknown): Promise<readonly ExpectedProviderCapability[]>;
  createConversation(input: unknown): Promise<ExpectedConversation>;
  deleteConversation(conversationId: unknown): Promise<void>;
  listSessions(conversationId: unknown): Promise<readonly ExpectedAgentSession[]>;
  createWorker(conversationId: unknown, input: unknown): Promise<string>;
  deleteWorker(conversationId: unknown, sessionName: unknown): Promise<void>;
  requireAttachableSession(
    conversationId: unknown,
    sessionName: unknown
  ): Promise<{
    readonly conversationId: string;
    readonly sessionName: string;
    readonly workspacePath: string;
  }>;
}

interface ExpectedWorkspacePreparation {
  readonly workspacePath: string;
  readonly suggestedName: string;
}

interface ExpectedWorkspaceInspection extends ExpectedWorkspacePreparation {
  readonly providers: readonly ExpectedProviderCapability[];
}

interface ExpectedLocalAgentLabRuntime {
  readonly commands: ExpectedAgentLabCommandPort;
  openTerminal(input: ExpectedOpenSessionTerminalInput): Promise<{
    readonly history: string;
    readonly terminal: ExpectedSessionTerminal;
    readonly releaseBufferedOutput: () => ExpectedBufferedTerminalRelease;
  }>;
  close(): Promise<void>;
}

interface ExpectedLocalAppConfig {
  readonly databasePath: string;
}

type ActualOpenTerminalResult = Awaited<ReturnType<LocalAgentLabRuntime["openTerminal"]>>;
type ExpectedOpenTerminalResult = Awaited<ReturnType<ExpectedLocalAgentLabRuntime["openTerminal"]>>;

export type PublicRuntimeCompatibilityAssertions = [
  Assert<Equal<ContractConversation, ExpectedConversation>>,
  Assert<Equal<ContractAgentSession, ExpectedAgentSession>>,
  Assert<Equal<ContractFolderSuggestion, ExpectedFolderSuggestion>>,
  Assert<Equal<ContractProviderCapability, ExpectedProviderCapability>>,
  Assert<Equal<AgentLabCommandPort, ExpectedAgentLabCommandPort>>,
  Assert<Equal<LocalAgentLabOptions, ExpectedLocalAgentLabOptions>>,
  Assert<Equal<LocalAgentLabRuntime, ExpectedLocalAgentLabRuntime>>,
  Assert<Equal<LocalAppConfig, ExpectedLocalAppConfig>>,
  Assert<Equal<OpenSessionTerminalInput, ExpectedOpenSessionTerminalInput>>,
  Assert<Equal<SessionTerminal, ExpectedSessionTerminal>>,
  Assert<Equal<SessionTerminalCallbacks, ExpectedSessionTerminalCallbacks>>,
  Assert<Equal<BufferedTerminalRelease, ExpectedBufferedTerminalRelease>>,
  Assert<Equal<Disposable, ExpectedDisposable>>,
  Assert<Equal<PseudoTerminal, ExpectedPseudoTerminal>>,
  Assert<
    Equal<PseudoTerminalFactory, NonNullable<ExpectedLocalAgentLabOptions["terminalFactory"]>>
  >,
  Assert<Equal<ManagedTerminalResource, ExpectedManagedTerminalResource>>,
  Assert<Equal<ManagedTerminalResourceOwner, ExpectedManagedTerminalResourceOwner>>,
  Assert<Equal<ManagedPseudoTerminal, ExpectedManagedPseudoTerminal>>,
  Assert<Equal<SessionAttachmentTarget, ExpectedSessionAttachmentTarget>>,
  Assert<Equal<ManagedPseudoTerminalFactory, ExpectedManagedPseudoTerminalFactory>>,
  Assert<Equal<ManagedTerminalHistoryReader, ExpectedManagedTerminalHistoryReader>>,
  Assert<
    Equal<TerminalHistoryReader, NonNullable<ExpectedLocalAgentLabOptions["terminalHistory"]>>
  >,
  Assert<Equal<TerminalDimensions, { readonly columns: number; readonly rows: number }>>,
  Assert<Equal<WorkspacePreparation, ExpectedWorkspacePreparation>>,
  Assert<Equal<WorkspaceInspection, ExpectedWorkspaceInspection>>,
  Assert<
    ExactCallable<
      typeof createLocalAgentLab,
      (options: ExpectedLocalAgentLabOptions) => ExpectedLocalAgentLabRuntime
    >
  >,
  Assert<
    ExactCallable<
      typeof loadLocalConfig,
      (environment?: NodeJS.ProcessEnv, cwd?: string) => ExpectedLocalAppConfig
    >
  >,
  Assert<Equal<typeof maximumTerminalDimension, 1_000>>,
  Assert<ExactMethods<AgentLabCommandPort, ExpectedAgentLabCommandPort, keyof AgentLabCommandPort>>,
  Assert<ExactMethods<Disposable, ExpectedDisposable, keyof ExpectedDisposable>>,
  Assert<ExactMethods<PseudoTerminal, ExpectedPseudoTerminal, keyof ExpectedPseudoTerminal>>,
  Assert<
    ExactMethods<
      PseudoTerminalFactory,
      NonNullable<ExpectedLocalAgentLabOptions["terminalFactory"]>,
      "attach"
    >
  >,
  Assert<
    ExactMethods<
      ManagedTerminalResource,
      ExpectedManagedTerminalResource,
      keyof ExpectedManagedTerminalResource
    >
  >,
  Assert<
    ExactMethods<
      ManagedTerminalResourceOwner,
      ExpectedManagedTerminalResourceOwner,
      keyof ExpectedManagedTerminalResourceOwner
    >
  >,
  Assert<
    ExactMethods<
      ManagedPseudoTerminal,
      ExpectedManagedPseudoTerminal,
      keyof ExpectedManagedPseudoTerminal
    >
  >,
  Assert<
    ExactMethods<
      ManagedPseudoTerminalFactory,
      ExpectedManagedPseudoTerminalFactory,
      keyof ExpectedManagedPseudoTerminalFactory
    >
  >,
  Assert<
    ExactMethods<
      ManagedTerminalHistoryReader,
      ExpectedManagedTerminalHistoryReader,
      keyof ExpectedManagedTerminalHistoryReader
    >
  >,
  Assert<
    ExactMethods<
      TerminalHistoryReader,
      NonNullable<ExpectedLocalAgentLabOptions["terminalHistory"]>,
      "read"
    >
  >,
  Assert<
    ExactMethods<
      SessionTerminalCallbacks,
      ExpectedSessionTerminalCallbacks,
      keyof ExpectedSessionTerminalCallbacks
    >
  >,
  Assert<ExactMethods<SessionTerminal, ExpectedSessionTerminal, keyof ExpectedSessionTerminal>>,
  Assert<
    ExactMethods<LocalAgentLabRuntime, ExpectedLocalAgentLabRuntime, "openTerminal" | "close">
  >,
  Assert<
    ExactMethods<ActualOpenTerminalResult, ExpectedOpenTerminalResult, "releaseBufferedOutput">
  >
];

/** Proves this contract's equality guard notices removal of optional public members. */
export type PublicRuntimeContractGuardAssertions = [
  AssertFalse<
    Equal<
      ExpectedLocalAgentLabOptions,
      Omit<ExpectedLocalAgentLabOptions, "managedTerminalFactory">
    >
  >,
  AssertFalse<
    Equal<
      ExpectedManagedPseudoTerminal,
      Omit<ExpectedManagedPseudoTerminal, "consumePendingOutputOverrun">
    >
  >,
  AssertFalse<ExactCallable<(first?: string, second?: string) => void, (first?: string) => void>>,
  AssertFalse<
    ExactMethods<{ inspect(value: unknown): void }, { inspect(value: string): void }, "inspect">
  >
];
