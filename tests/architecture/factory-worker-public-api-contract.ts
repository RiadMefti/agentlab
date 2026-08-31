import type { FactoryCostPolicy, Sha256Digest } from "@agentlab/contracts";
import {
  createConfiguredLocalFactoryWorker,
  createLocalFactoryWorker,
  loadLocalFactoryWorkerConfig,
  type FactoryAgentProviderBinding,
  type FactoryGateDefinition,
  type FactoryWorkerCommandPort,
  type FactoryWorkerPreflight,
  type LocalFactoryWorkerConfig,
  type LocalFactoryWorkerOptions,
  type LocalFactoryWorkerRuntime
} from "@agentlab/runtime/factory-worker";
// @ts-expect-error Worker execution must not be exported by the interactive runtime entry point.
import { createLocalFactoryWorker as forbiddenInteractiveWorker } from "@agentlab/runtime";
// @ts-expect-error Worker execution must not be exported by the GitHub authority entry point.
import { createLocalFactoryWorker as forbiddenBrokerWorker } from "@agentlab/runtime/factory-broker";
// @ts-expect-error Human authority mutation must not be exported by the model-bearing worker.
import { createLocalFactoryAuthority as forbiddenWorkerAuthority } from "@agentlab/runtime/factory-worker";

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

interface ExpectedProviderBinding {
  readonly provider: "codex" | "claude";
  readonly executable: string;
  readonly executableDigest: Sha256Digest;
  readonly version: string;
}

interface ExpectedGateDefinition {
  readonly id: string;
  readonly evidenceKind: "test" | "build" | "security" | "provenance";
  readonly command: {
    readonly executable: string;
    readonly args: readonly string[];
    readonly environment?: Readonly<Record<string, string>>;
  };
  readonly timeoutMs: number;
  readonly maximumOutputBytes: number;
}

interface ExpectedOptions {
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

interface ExpectedPreflight {
  readonly schemaVersion: "agentlab.worker-preflight.v1";
  readonly status: "ready" | "blocked";
  readonly policyBundleDigest: Sha256Digest;
  readonly schedulerEnabled: boolean;
  readonly costPolicyConfigured: boolean;
  readonly hostReady: boolean;
  readonly configuredProviders: readonly ("codex" | "claude")[];
  readonly gateIds: readonly string[];
  readonly reasonCodes: readonly string[];
}

type ExpectedConfigKeys =
  | "schemaVersion"
  | "databasePath"
  | "artifactRoot"
  | "workspaceRoot"
  | "costPolicyPath"
  | "gitExecutable"
  | "flockExecutable"
  | "systemd"
  | "sandbox"
  | "providers"
  | "gates"
  | "costPolicy";

export type FactoryWorkerPublicApiAssertions = [
  Assert<Equal<FactoryAgentProviderBinding, ExpectedProviderBinding>>,
  Assert<Equal<FactoryGateDefinition, ExpectedGateDefinition>>,
  Assert<Equal<LocalFactoryWorkerOptions, ExpectedOptions>>,
  Assert<Equal<FactoryWorkerPreflight, ExpectedPreflight>>,
  Assert<Equal<keyof LocalFactoryWorkerConfig, ExpectedConfigKeys>>,
  Assert<Equal<Extract<keyof LocalFactoryWorkerConfig, "githubApp" | "repositoryId">, never>>,
  Assert<
    Equal<
      keyof FactoryWorkerCommandPort,
      | "preflight"
      | "advancePreparation"
      | "recoverPreparation"
      | "materializePreparation"
      | "admitExecution"
      | "execute"
      | "recoverExecution"
    >
  >,
  Assert<Equal<keyof LocalFactoryWorkerRuntime, "commands" | "close">>,
  Assert<
    Equal<
      typeof createLocalFactoryWorker,
      (options: LocalFactoryWorkerOptions) => LocalFactoryWorkerRuntime
    >
  >,
  Assert<
    Equal<
      typeof createConfiguredLocalFactoryWorker,
      (config: LocalFactoryWorkerConfig) => LocalFactoryWorkerRuntime
    >
  >,
  Assert<
    Equal<
      typeof loadLocalFactoryWorkerConfig,
      (pathInput: string) => Promise<LocalFactoryWorkerConfig>
    >
  >
];

void forbiddenInteractiveWorker;
void forbiddenBrokerWorker;
void forbiddenWorkerAuthority;
