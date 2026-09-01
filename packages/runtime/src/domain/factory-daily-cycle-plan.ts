import {
  factoryDailyCycleManifestSchema,
  type FactoryDailyCycleManifest,
  type FactoryRoleIdentityPolicy,
  type FactorySchedulePolicy
} from "@agentlab/contracts";

export type FactoryDailyCycleRole = "worker" | "broker";

export interface FactoryDailyCycleStage {
  readonly id: string;
  readonly role: FactoryDailyCycleRole;
  readonly userId: number;
  readonly executable: string;
  readonly arguments: readonly string[];
  readonly timeoutSeconds: number;
}

export interface FactoryDailyCyclePlan {
  readonly scheduleAtUtc: string;
  readonly stages: readonly FactoryDailyCycleStage[];
}

/** Compiles reviewed policy into a fixed, shell-free worker/broker command sequence. */
export function compileFactoryDailyCyclePlan(
  manifestInput: FactoryDailyCycleManifest,
  schedulePolicy: FactorySchedulePolicy,
  roleIdentityPolicy: FactoryRoleIdentityPolicy
): FactoryDailyCyclePlan {
  const manifest = factoryDailyCycleManifestSchema.parse(manifestInput);
  validateIdentityAndBudget(manifest, schedulePolicy, roleIdentityPolicy);
  const commonArguments = [
    "--schedule-policy",
    manifest.expectedSchedulePolicyDigest,
    "--role-policy",
    manifest.expectedRoleIdentityPolicyDigest,
    "--policy",
    manifest.expectedFactoryPolicyBundleDigest
  ] as const;
  const stages: FactoryDailyCycleStage[] = [
    stage(manifest, "scheduler", "worker", [
      "factory",
      "scheduler-tick",
      "--config",
      manifest.worker.configPath,
      "--schedule-policy",
      manifest.expectedSchedulePolicyDigest,
      "--policy",
      manifest.expectedFactoryPolicyBundleDigest
    ]),
    stage(manifest, "draft", "broker", [
      "factory",
      "broker-canary-tick",
      "--config",
      manifest.broker.configPath,
      ...commonArguments
    ])
  ];
  for (let round = 1; round <= manifest.maximumRepairRounds; round += 1) {
    stages.push(
      stage(manifest, `maintenance-${String(round)}`, "broker", [
        "factory",
        "broker-pr-maintenance-tick",
        "--config",
        manifest.broker.configPath,
        ...commonArguments
      ]),
      stage(manifest, `repair-${String(round)}`, "worker", [
        "factory",
        "worker-pr-repair-tick",
        "--config",
        manifest.worker.configPath,
        ...commonArguments
      ]),
      stage(manifest, `update-${String(round)}`, "broker", [
        "factory",
        "broker-pr-update-tick",
        "--config",
        manifest.broker.configPath,
        ...commonArguments
      ])
    );
  }
  if (manifest.maximumRepairRounds > 0) {
    stages.push(
      stage(manifest, `maintenance-${String(manifest.maximumRepairRounds + 1)}`, "broker", [
        "factory",
        "broker-pr-maintenance-tick",
        "--config",
        manifest.broker.configPath,
        ...commonArguments
      ])
    );
  }
  return Object.freeze({ scheduleAtUtc: schedulePolicy.cadence.at, stages: Object.freeze(stages) });
}

function validateIdentityAndBudget(
  manifest: FactoryDailyCycleManifest,
  schedulePolicy: FactorySchedulePolicy,
  roleIdentityPolicy: FactoryRoleIdentityPolicy
): void {
  if (manifest.worker.userId !== roleIdentityPolicy.worker.userId) {
    throw new Error("Daily cycle worker identity does not match the reviewed role policy.");
  }
  if (manifest.broker.userId === roleIdentityPolicy.evalAttestor.userId) {
    throw new Error("Daily cycle broker and evaluation attestor identities must remain separate.");
  }
  if (manifest.maximumRepairRounds > schedulePolicy.tickBudget.maxRepairAttempts) {
    throw new Error("Daily cycle repair rounds exceed the reviewed schedule budget.");
  }
  if (manifest.workerCommandTimeoutSeconds < schedulePolicy.tickBudget.wallClockSeconds + 30) {
    throw new Error("Daily cycle worker timeout cannot truncate the reviewed wall-clock budget.");
  }
}

function stage(
  manifest: FactoryDailyCycleManifest,
  id: string,
  role: FactoryDailyCycleRole,
  arguments_: readonly string[]
): FactoryDailyCycleStage {
  const identity = role === "worker" ? manifest.worker : manifest.broker;
  return Object.freeze({
    id,
    role,
    userId: identity.userId,
    executable: manifest.agentlabExecutable.path,
    arguments: Object.freeze([...arguments_]),
    timeoutSeconds:
      role === "worker"
        ? manifest.workerCommandTimeoutSeconds
        : manifest.brokerCommandTimeoutSeconds
  });
}
