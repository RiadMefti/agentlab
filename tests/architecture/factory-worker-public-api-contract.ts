import type {
  FactoryAutonomousMergePolicy,
  FactoryCostPolicy,
  FactoryDailyQuotaPolicy,
  FactoryRoleIdentityPolicy,
  FactorySchedulePolicy,
  FactoryTaskState,
  Sha256Digest
} from "@agentlab/contracts";
import {
  createConfiguredLocalFactoryWorker,
  createLocalFactoryWorker,
  loadLocalFactoryWorkerConfig,
  loadLocalFactoryDailyQuotaPolicy,
  loadLocalFactorySchedulePolicy,
  type FactoryAgentProviderBinding,
  type FactoryCanaryPullRequestRepairTickReport,
  type FactoryGateDefinition,
  type FactoryWorkerCommandPort,
  type FactoryWorkerPreflight,
  type FactoryWorkerTaskRunReport,
  type FactorySchedulerTickReport,
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
  readonly schedulePolicy?: FactorySchedulePolicy;
  readonly dailyQuotaPolicy?: FactoryDailyQuotaPolicy;
  readonly roleIdentityPolicy?: FactoryRoleIdentityPolicy;
  readonly expectedRoleIdentityPolicyDigest?: Sha256Digest;
  readonly autonomousMergePolicy?: FactoryAutonomousMergePolicy;
  readonly expectedAutonomousMergePolicyDigest?: Sha256Digest;
  readonly expectedFactoryPolicyBundleDigest?: Sha256Digest;
  readonly hostEnvironment?: NodeJS.ProcessEnv;
  readonly now?: () => string;
  readonly createId?: () => string;
}

interface ExpectedPreflight {
  readonly schemaVersion: "agentlab.worker-preflight.v4";
  readonly status: "ready" | "blocked";
  readonly policyBundleDigest: Sha256Digest;
  readonly schedulePolicyDigest: Sha256Digest | null;
  readonly roleIdentityPolicyDigest: Sha256Digest | null;
  readonly dailyQuotaPolicyDigest: Sha256Digest | null;
  readonly schedulerEnabled: boolean;
  readonly costPolicyConfigured: boolean;
  readonly hostReady: boolean;
  readonly configuredProviders: readonly ("codex" | "claude")[];
  readonly gateIds: readonly string[];
  readonly reasonCodes: readonly string[];
}

interface ExpectedTaskRunReport {
  readonly schemaVersion: "agentlab.worker-task-run.v3";
  readonly status: "ready-for-broker" | "already-advanced" | "stopped";
  readonly taskId: string;
  readonly correlationId: string;
  readonly policyBundleDigest: Sha256Digest;
  readonly roleIdentityPolicyDigest: Sha256Digest | null;
  readonly canaryReservationDigest: Sha256Digest | null;
  readonly preparationState:
    | "registered"
    | "qualifying"
    | "qualified"
    | "specifying"
    | "specified"
    | "planning"
    | "planned"
    | "prepared"
    | "needs-human"
    | "rejected"
    | "failed"
    | "cancelled"
    | "expired";
  readonly taskState:
    | "intake"
    | "qualified"
    | "specified"
    | "planned"
    | "awaiting-execution-approval"
    | "queued"
    | "executing"
    | "verifying"
    | "reviewing"
    | "repairing"
    | "pr-proposed"
    | "pr-open"
    | "merge-ready"
    | "awaiting-merge-approval"
    | "merge-queued"
    | "merged"
    | "canary"
    | "released"
    | "observing"
    | "completed"
    | "needs-attention"
    | "rejected"
    | "cancelled"
    | "expired"
    | "failed"
    | "quarantined"
    | "rolled-back"
    | null;
  readonly contractDigest: Sha256Digest | null;
  readonly reasonCodes: readonly string[];
}

interface ExpectedSchedulerTickReport {
  readonly schemaVersion: "agentlab.scheduler-tick-result.v3";
  readonly status: "completed" | "already-completed" | "missed-deadline" | "blocked";
  readonly schedulePolicyDigest: Sha256Digest;
  readonly factoryPolicyBundleDigest: Sha256Digest;
  readonly roleIdentityPolicyDigest: Sha256Digest;
  readonly dailyQuotaPolicyDigest: Sha256Digest;
  readonly scheduledFor: string;
  readonly deadlineAt: string;
  readonly runId: string | null;
  readonly runDigest: Sha256Digest | null;
  readonly tasksClaimed: number;
  readonly tasksFinished: number;
  readonly tasksSkipped: number;
  readonly reservedUsage: {
    readonly wallClockSeconds: number;
    readonly agentTurns: number;
    readonly toolCalls: number;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly costMicrousd: number;
    readonly processes: number;
    readonly outputBytes: number;
    readonly workers: number;
    readonly repairAttempts: number;
    readonly changedFiles: number;
    readonly changedLines: number;
  };
  readonly reasonCodes: readonly string[];
}

interface ExpectedCanaryPullRequestRepairTickReport {
  readonly schemaVersion: "agentlab.canary-pull-request-repair-tick-result.v1";
  readonly status: "idle" | "completed" | "attention-required" | "blocked";
  readonly schedulePolicyDigest: Sha256Digest;
  readonly factoryPolicyBundleDigest: Sha256Digest;
  readonly roleIdentityPolicyDigest: Sha256Digest;
  readonly observedAt: string;
  readonly candidatesInspected: number;
  readonly recoveryAttempts: number;
  readonly repairAttempts: number;
  readonly repairRunsCreated: number;
  readonly proposalsCreated: number;
  readonly reservedUsage: ExpectedSchedulerTickReport["reservedUsage"];
  readonly hasMore: boolean;
  readonly reasonCodes: readonly string[];
  readonly tasks: readonly {
    readonly taskId: string;
    readonly repositoryId: string;
    readonly authorizationDigest: Sha256Digest;
    readonly source: "authorized" | "recoverable";
    readonly status:
      | "recovered"
      | "pr-proposed"
      | "already-advanced"
      | "expired"
      | "blocked"
      | "needs-attention"
      | "failed"
      | "quarantined";
    readonly taskState: FactoryTaskState | null;
    readonly reasonCodes: readonly string[];
    readonly repairRunDigest: Sha256Digest | null;
    readonly patchProposalDigest: Sha256Digest | null;
  }[];
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
  | "costPolicy"
  | "schedulePolicy"
  | "dailyQuotaPolicy"
  | "roleIdentityPolicy"
  | "autonomousMergePolicy";

export type FactoryWorkerPublicApiAssertions = [
  Assert<Equal<FactoryAgentProviderBinding, ExpectedProviderBinding>>,
  Assert<Equal<FactoryGateDefinition, ExpectedGateDefinition>>,
  Assert<Equal<LocalFactoryWorkerOptions, ExpectedOptions>>,
  Assert<Equal<FactoryWorkerPreflight, ExpectedPreflight>>,
  Assert<Equal<FactoryWorkerTaskRunReport, ExpectedTaskRunReport>>,
  Assert<Equal<FactorySchedulerTickReport, ExpectedSchedulerTickReport>>,
  Assert<
    Equal<FactoryCanaryPullRequestRepairTickReport, ExpectedCanaryPullRequestRepairTickReport>
  >,
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
      | "executePullRequestRepair"
      | "recoverPullRequestRepair"
      | "runCanaryPullRequestRepairTick"
      | "runTask"
      | "runScheduledTick"
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
  >,
  Assert<
    Equal<
      typeof loadLocalFactorySchedulePolicy,
      (pathInput: string) => Promise<FactorySchedulePolicy>
    >
  >,
  Assert<
    Equal<
      typeof loadLocalFactoryDailyQuotaPolicy,
      (pathInput: string) => Promise<FactoryDailyQuotaPolicy>
    >
  >
];

void forbiddenInteractiveWorker;
void forbiddenBrokerWorker;
void forbiddenWorkerAuthority;
