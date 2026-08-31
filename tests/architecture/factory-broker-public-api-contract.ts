import {
  createConfiguredLocalFactoryBroker,
  createLocalFactoryBroker,
  loadLocalFactoryBrokerConfig,
  type FactoryBrokerCommandPort,
  type FactoryBrokerPreflight,
  type GitHubAppPrivateKeySource,
  type LocalFactoryBrokerConfig,
  type LocalFactoryBrokerOptions,
  type LocalFactoryBrokerRuntime
} from "@agentlab/runtime/factory-broker";
import type { FactoryCostPolicy } from "@agentlab/contracts";
// @ts-expect-error Broker authority must not be exported by the interactive runtime entry point.
import { createLocalFactoryBroker as forbiddenInteractiveBroker } from "@agentlab/runtime";
// @ts-expect-error Human authority mutation must not be exported by the credential-bearing broker.
import { createLocalFactoryAuthority as forbiddenBrokerAuthority } from "@agentlab/runtime/factory-broker";

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

interface ExpectedConfigFields {
  databasePath: string;
  artifactRoot: string;
  temporaryRoot: string;
  repositoryId: string;
  repositoryNumericId: number;
  brokerId: string;
  gitExecutable: string;
  githubApp: {
    clientId: string;
    installationId: number;
    privateKeyPath: string;
    trustedStatusChecks: {
      context: "verify" | "factory-sandbox";
      appId: number;
    }[];
  };
}

type ExpectedConfig = ExpectedConfigFields &
  (
    | { schemaVersion: "agentlab.local-factory-broker.v1" }
    | {
        schemaVersion: "agentlab.local-factory-broker.v2";
        costPolicyPath: string;
        costPolicy: FactoryCostPolicy;
      }
  );

interface ExpectedOptions {
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

interface ExpectedPreflight {
  readonly schemaVersion: "agentlab.broker-preflight.v1";
  readonly status: "ready" | "blocked";
  readonly repository: {
    readonly repositoryId: string;
    readonly baseBranch: string;
    readonly baseRevision: string;
    readonly governance: {
      readonly requiresPullRequest: boolean;
      readonly requiredApprovals: number;
      readonly dismissesStaleReviews: boolean;
      readonly requiresCodeOwnerReviews: boolean;
      readonly requiresLastPushApproval: boolean;
      readonly enforcesAdmins: boolean;
      readonly allowsForcePushes: boolean;
      readonly allowsDeletions: boolean;
      readonly requiredStatusChecks: readonly string[];
    };
  };
  readonly policyBundleDigest: string;
  readonly authorityEnabled: boolean;
  readonly reasonCodes: readonly string[];
}

export type FactoryBrokerPublicApiAssertions = [
  Assert<Equal<LocalFactoryBrokerConfig, ExpectedConfig>>,
  Assert<Equal<LocalFactoryBrokerOptions, ExpectedOptions>>,
  Assert<Equal<FactoryBrokerPreflight, ExpectedPreflight>>,
  Assert<
    Equal<
      keyof FactoryBrokerCommandPort,
      | "preflight"
      | "openDraft"
      | "updatePullRequest"
      | "observePullRequest"
      | "admitPullRequestRepair"
    >
  >,
  Assert<Equal<keyof LocalFactoryBrokerRuntime, "commands" | "close">>,
  Assert<Equal<ReturnType<GitHubAppPrivateKeySource["load"]>, Promise<Uint8Array>>>,
  Assert<
    Equal<
      typeof createLocalFactoryBroker,
      (options: LocalFactoryBrokerOptions) => LocalFactoryBrokerRuntime
    >
  >,
  Assert<
    Equal<
      typeof createConfiguredLocalFactoryBroker,
      (config: LocalFactoryBrokerConfig) => LocalFactoryBrokerRuntime
    >
  >,
  Assert<
    Equal<
      typeof loadLocalFactoryBrokerConfig,
      (pathInput: string) => Promise<LocalFactoryBrokerConfig>
    >
  >
];

void forbiddenInteractiveBroker;
void forbiddenBrokerAuthority;
