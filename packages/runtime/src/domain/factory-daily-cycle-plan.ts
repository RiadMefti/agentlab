import {
  factoryDailyCycleManifestSchema,
  type FactoryDailyCycleManifest,
  type FactoryRoleIdentityPolicy,
  type FactorySchedulePolicy
} from "@agentlab/contracts";

export type FactoryDailyCycleRole = "worker" | "broker" | "incident" | "merger";

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

type ExecutableFactoryDailyCycleManifest = Extract<
  FactoryDailyCycleManifest,
  {
    readonly schemaVersion: "agentlab.daily-cycle-manifest.v4" | "agentlab.daily-cycle-manifest.v5";
  }
>;

/** Compiles reviewed policy into a fixed, shell-free incident/worker/broker command sequence. */
export function compileFactoryDailyCyclePlan(
  manifestInput: FactoryDailyCycleManifest,
  schedulePolicy: FactorySchedulePolicy,
  roleIdentityPolicy: FactoryRoleIdentityPolicy
): FactoryDailyCyclePlan {
  const manifest = factoryDailyCycleManifestSchema.parse(manifestInput);
  if (
    manifest.schemaVersion !== "agentlab.daily-cycle-manifest.v4" &&
    manifest.schemaVersion !== "agentlab.daily-cycle-manifest.v5"
  ) {
    throw new Error(
      "Daily cycle rendering requires a v4 or v5 manifest with incident containment."
    );
  }
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
    stage(manifest, "incident-containment", "incident", [
      "factory",
      "incident-containment",
      "--config",
      manifest.incident.configPath,
      "--health-policy",
      manifest.expectedOperationsHealthPolicyDigest,
      "--daily-quota",
      manifest.expectedDailyQuotaPolicyDigest
    ]),
    stage(manifest, "maintenance-discovery", "worker", [
      "factory",
      "maintenance-discovery-tick",
      "--config",
      manifest.maintenanceDiscoveryConfigPath,
      "--discovery-policy",
      manifest.expectedMaintenanceDiscoveryPolicyDigest,
      "--schedule-policy",
      manifest.expectedSchedulePolicyDigest,
      "--policy",
      manifest.expectedFactoryPolicyBundleDigest,
      "--preparation-grant",
      manifest.expectedPreparationGrantDigest,
      "--role-policy",
      manifest.expectedRoleIdentityPolicyDigest
    ]),
    stage(manifest, "canary-admission", "worker", [
      "factory",
      "canary-admission-tick",
      "--config",
      manifest.canaryAdmissionConfigPath,
      "--cohort",
      manifest.expectedCanaryCohortDigest,
      "--candidate",
      manifest.expectedCanaryCandidateDigest,
      "--schedule-policy",
      manifest.expectedSchedulePolicyDigest,
      "--role-policy",
      manifest.expectedRoleIdentityPolicyDigest,
      "--policy",
      manifest.expectedFactoryPolicyBundleDigest
    ]),
    stage(manifest, "scheduler", "worker", [
      "factory",
      "scheduler-tick",
      "--config",
      manifest.worker.configPath,
      "--schedule-policy",
      manifest.expectedSchedulePolicyDigest,
      "--daily-quota",
      manifest.expectedDailyQuotaPolicyDigest,
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
  if (manifest.schemaVersion === "agentlab.daily-cycle-manifest.v5") {
    if (manifest.maximumRepairRounds === 0) {
      stages.push(
        stage(manifest, "maintenance-1", "broker", [
          "factory",
          "broker-pr-maintenance-tick",
          "--config",
          manifest.broker.configPath,
          ...commonArguments
        ])
      );
    }
    const mergeArguments = [
      "--merge-policy",
      manifest.expectedMergePolicyDigest,
      "--policy",
      manifest.expectedFactoryPolicyBundleDigest,
      "--schedule-policy",
      manifest.expectedSchedulePolicyDigest,
      "--daily-quota",
      manifest.expectedDailyQuotaPolicyDigest,
      "--role-policy",
      manifest.expectedRoleIdentityPolicyDigest
    ] as const;
    stages.push(
      stage(
        manifest,
        "merge-admission",
        "worker",
        [
          "factory",
          "merge-admission-tick",
          "--config",
          manifest.mergeAdmissionConfigPath,
          ...mergeArguments
        ],
        manifest.mergeAdmissionCommandTimeoutSeconds
      ),
      stage(manifest, "merger", "merger", [
        "factory",
        "merger-tick",
        "--config",
        manifest.merger.configPath,
        ...mergeArguments
      ])
    );
  }
  return Object.freeze({ scheduleAtUtc: schedulePolicy.cadence.at, stages: Object.freeze(stages) });
}

function validateIdentityAndBudget(
  manifest: ExecutableFactoryDailyCycleManifest,
  schedulePolicy: FactorySchedulePolicy,
  roleIdentityPolicy: FactoryRoleIdentityPolicy
): void {
  if (manifest.worker.userId !== roleIdentityPolicy.worker.userId) {
    throw new Error("Daily cycle worker identity does not match the reviewed role policy.");
  }
  if (manifest.broker.userId === roleIdentityPolicy.evalAttestor.userId) {
    throw new Error("Daily cycle broker and evaluation attestor identities must remain separate.");
  }
  if (manifest.incident.userId === roleIdentityPolicy.evalAttestor.userId) {
    throw new Error(
      "Daily cycle incident controller and evaluation attestor identities must remain separate."
    );
  }
  if (
    manifest.schemaVersion === "agentlab.daily-cycle-manifest.v5" &&
    manifest.merger.userId === roleIdentityPolicy.evalAttestor.userId
  ) {
    throw new Error("Daily cycle merger and evaluation attestor identities must remain separate.");
  }
  if (manifest.maximumRepairRounds > schedulePolicy.tickBudget.maxRepairAttempts) {
    throw new Error("Daily cycle repair rounds exceed the reviewed schedule budget.");
  }
  if (manifest.workerCommandTimeoutSeconds < schedulePolicy.tickBudget.wallClockSeconds + 30) {
    throw new Error("Daily cycle worker timeout cannot truncate the reviewed wall-clock budget.");
  }
}

function stage(
  manifest: ExecutableFactoryDailyCycleManifest,
  id: string,
  role: FactoryDailyCycleRole,
  arguments_: readonly string[],
  timeoutSeconds?: number
): FactoryDailyCycleStage {
  const identity =
    role === "worker"
      ? manifest.worker
      : role === "broker"
        ? manifest.broker
        : role === "merger" && manifest.schemaVersion === "agentlab.daily-cycle-manifest.v5"
          ? manifest.merger
          : manifest.incident;
  return Object.freeze({
    id,
    role,
    userId: identity.userId,
    executable: manifest.agentlabExecutable.path,
    arguments: Object.freeze([...arguments_]),
    timeoutSeconds:
      timeoutSeconds ??
      (role === "worker"
        ? manifest.workerCommandTimeoutSeconds
        : role === "broker"
          ? manifest.brokerCommandTimeoutSeconds
          : role === "merger" && manifest.schemaVersion === "agentlab.daily-cycle-manifest.v5"
            ? manifest.mergerCommandTimeoutSeconds
            : manifest.incidentCommandTimeoutSeconds)
  });
}
