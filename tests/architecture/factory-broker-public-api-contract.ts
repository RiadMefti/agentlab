import {
  createConfiguredLocalFactoryBroker,
  createLocalFactoryBroker,
  loadLocalFactoryBrokerConfig,
  type FactoryBrokerCommandPort,
  type FactoryBrokerPreflight,
  type FactoryCanaryBrokerTickReport,
  type FactoryCanaryPullRequestMaintenanceTickReport,
  type FactoryCanaryPullRequestUpdateTickReport,
  type GitHubAppPrivateKeySource,
  type LocalFactoryBrokerConfig,
  type LocalFactoryBrokerOptions,
  type LocalFactoryBrokerRuntime
} from "@agentlab/runtime/factory-broker";
import type {
  FactoryAutonomousMergePolicy,
  FactoryCostPolicy,
  FactoryDailyQuotaPolicy,
  FactoryRoleIdentityPolicy,
  FactorySchedulePolicy,
  Sha256Digest
} from "@agentlab/contracts";
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
    | {
        schemaVersion: "agentlab.local-factory-broker.v3";
        costPolicyPath: string;
        schedulePolicyPath: string;
        roleIdentityPolicyPath: string;
        expectedRoleIdentityPolicyDigest: Sha256Digest;
        costPolicy: FactoryCostPolicy;
        schedulePolicy: FactorySchedulePolicy;
        roleIdentityPolicy: FactoryRoleIdentityPolicy;
      }
    | {
        schemaVersion: "agentlab.local-factory-broker.v4";
        costPolicyPath: string;
        schedulePolicyPath: string;
        dailyQuotaPolicyPath: string;
        expectedDailyQuotaPolicyDigest: Sha256Digest;
        roleIdentityPolicyPath: string;
        expectedRoleIdentityPolicyDigest: Sha256Digest;
        costPolicy: FactoryCostPolicy;
        schedulePolicy: FactorySchedulePolicy;
        dailyQuotaPolicy: FactoryDailyQuotaPolicy;
        roleIdentityPolicy: FactoryRoleIdentityPolicy;
      }
    | {
        schemaVersion: "agentlab.local-factory-broker.v5";
        costPolicyPath: string;
        schedulePolicyPath: string;
        dailyQuotaPolicyPath: string;
        roleIdentityPolicyPath: string;
        mergePolicyPath: string;
        expectedFactoryPolicyBundleDigest: Sha256Digest;
        expectedSchedulePolicyDigest: Sha256Digest;
        expectedDailyQuotaPolicyDigest: Sha256Digest;
        expectedRoleIdentityPolicyDigest: Sha256Digest;
        expectedMergePolicyDigest: Sha256Digest;
        costPolicy: FactoryCostPolicy;
        schedulePolicy: FactorySchedulePolicy;
        dailyQuotaPolicy: FactoryDailyQuotaPolicy;
        roleIdentityPolicy: FactoryRoleIdentityPolicy;
        autonomousMergePolicy: FactoryAutonomousMergePolicy;
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
  readonly schedulePolicy?: FactorySchedulePolicy;
  readonly dailyQuotaPolicy?: FactoryDailyQuotaPolicy;
  readonly roleIdentityPolicy?: FactoryRoleIdentityPolicy;
  readonly expectedRoleIdentityPolicyDigest?: Sha256Digest;
  readonly autonomousMergePolicy?: FactoryAutonomousMergePolicy;
  readonly expectedAutonomousMergePolicyDigest?: Sha256Digest;
  readonly expectedFactoryPolicyBundleDigest?: Sha256Digest;
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

interface ExpectedCanaryBrokerTickReport {
  readonly schemaVersion: "agentlab.canary-broker-tick-result.v1";
  readonly status: "idle" | "completed" | "attention-required" | "blocked";
  readonly repositoryId: string;
  readonly schedulePolicyDigest: Sha256Digest;
  readonly factoryPolicyBundleDigest: Sha256Digest;
  readonly roleIdentityPolicyDigest: Sha256Digest;
  readonly observedAt: string;
  readonly candidatesInspected: number;
  readonly dispatchAttempts: number;
  readonly draftsCompleted: number;
  readonly hasMore: boolean;
  readonly reasonCodes: readonly string[];
  readonly tasks: readonly {
    readonly taskId: string;
    readonly reservationDigest: Sha256Digest;
    readonly source: "undispatched" | "recoverable";
    readonly status: "completed" | "expired" | "blocked" | "denied" | "needs-human";
    readonly reasonCodes: readonly string[];
    readonly pullRequestNumber: number | null;
  }[];
}

interface ExpectedCanaryPullRequestMaintenanceTickReport {
  readonly schemaVersion: "agentlab.canary-pull-request-maintenance-tick-result.v1";
  readonly status: "idle" | "completed" | "attention-required" | "blocked";
  readonly repositoryId: string;
  readonly schedulePolicyDigest: Sha256Digest;
  readonly factoryPolicyBundleDigest: Sha256Digest;
  readonly roleIdentityPolicyDigest: Sha256Digest;
  readonly maintenanceSlot: string;
  readonly observedAt: string;
  readonly candidatesInspected: number;
  readonly maintenanceAttempts: number;
  readonly observationsCreated: number;
  readonly repairAuthorizationsCreated: number;
  readonly hasMore: boolean;
  readonly reasonCodes: readonly string[];
  readonly tasks: readonly {
    readonly taskId: string;
    readonly reservationDigest: Sha256Digest;
    readonly source: "unobserved" | "observed-actionable";
    readonly status:
      "clear" | "pending" | "repair-authorized" | "unsafe" | "expired" | "blocked" | "denied";
    readonly reasonCodes: readonly string[];
    readonly observationDigest: Sha256Digest | null;
    readonly repairAuthorizationDigest: Sha256Digest | null;
  }[];
}

interface ExpectedCanaryPullRequestUpdateTickReport {
  readonly schemaVersion: "agentlab.canary-pull-request-update-tick-result.v1";
  readonly status: "idle" | "completed" | "attention-required" | "blocked";
  readonly repositoryId: string;
  readonly schedulePolicyDigest: Sha256Digest;
  readonly factoryPolicyBundleDigest: Sha256Digest;
  readonly roleIdentityPolicyDigest: Sha256Digest;
  readonly observedAt: string;
  readonly candidatesInspected: number;
  readonly recoveryAttempts: number;
  readonly updateAttempts: number;
  readonly updatesCompleted: number;
  readonly remoteUpdates: number;
  readonly hasMore: boolean;
  readonly reasonCodes: readonly string[];
  readonly tasks: readonly {
    readonly taskId: string;
    readonly repositoryId: string;
    readonly authorizationDigest: Sha256Digest;
    readonly repairRunDigest: Sha256Digest;
    readonly source: "authorized" | "recoverable";
    readonly status: "updated" | "recovered" | "expired" | "blocked" | "denied" | "needs-human";
    readonly reasonCodes: readonly string[];
    readonly pullRequestNumber: number | null;
    readonly priorHeadRevision: string | null;
    readonly headRevision: string | null;
    readonly remoteUpdated: boolean;
  }[];
}

export type FactoryBrokerPublicApiAssertions = [
  Assert<Equal<LocalFactoryBrokerConfig, ExpectedConfig>>,
  Assert<Equal<LocalFactoryBrokerOptions, ExpectedOptions>>,
  Assert<Equal<FactoryBrokerPreflight, ExpectedPreflight>>,
  Assert<Equal<FactoryCanaryBrokerTickReport, ExpectedCanaryBrokerTickReport>>,
  Assert<
    Equal<
      FactoryCanaryPullRequestMaintenanceTickReport,
      ExpectedCanaryPullRequestMaintenanceTickReport
    >
  >,
  Assert<
    Equal<FactoryCanaryPullRequestUpdateTickReport, ExpectedCanaryPullRequestUpdateTickReport>
  >,
  Assert<
    Equal<
      keyof FactoryBrokerCommandPort,
      | "preflight"
      | "openDraft"
      | "reconcileCanaryDrafts"
      | "maintainCanaryPullRequests"
      | "updateCanaryPullRequests"
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
