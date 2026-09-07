import { lstat } from "node:fs/promises";

import {
  factoryDailyCycleManifestSchema,
  type FactoryAutonomousMergePolicy,
  type FactoryDailyCycleManifest,
  type FactoryDailyQuotaPolicy,
  type FactoryOperationsHealthPolicy,
  type FactoryRoleIdentityPolicy,
  type FactorySchedulePolicy
} from "@agentlab/contracts";

import { encodeCanonicalDocument } from "../persistence/canonical-factory-documents.js";
import { loadLocalFactoryAutonomousMergePolicy } from "./local-factory-autonomous-merge-policy.js";
import { loadLocalFactoryDailyQuotaPolicy } from "./local-factory-daily-quota-policy.js";
import { loadLocalFactoryOperationsHealthPolicy } from "./local-factory-operations-health-policy.js";
import { loadLocalFactoryRoleIdentityPolicy } from "./local-factory-role-identity-policy.js";
import { loadLocalFactorySchedulePolicy } from "./local-factory-schedule-policy.js";
import { pinnedLocalExecutableDigest } from "./pinned-local-executable.js";
import { privateLocalFilePath, readPrivateLocalFile } from "./private-local-file.js";

export type LocalFactoryOrchestrationConfig = FactoryDailyCycleManifest & {
  readonly schedulePolicy: FactorySchedulePolicy;
  readonly roleIdentityPolicy: FactoryRoleIdentityPolicy;
  readonly dailyQuotaPolicy?: FactoryDailyQuotaPolicy;
  readonly operationsHealthPolicy?: FactoryOperationsHealthPolicy;
  readonly autonomousMergePolicy?: FactoryAutonomousMergePolicy;
};

/** Loads and verifies the reviewed inputs used only to render a dormant daily-cycle bundle. */
export async function loadLocalFactoryOrchestrationConfig(
  pathInput: string
): Promise<LocalFactoryOrchestrationConfig> {
  const path = privateLocalFilePath(pathInput, "Local factory orchestration config");
  const content = await readPrivateLocalFile(path, {
    label: "Local factory orchestration config",
    minimumBytes: 2,
    maximumBytes: 64 * 1_024
  });
  let parsed: FactoryDailyCycleManifest;
  try {
    parsed = factoryDailyCycleManifestSchema.parse(parseJson(content.toString("utf8")));
  } finally {
    content.fill(0);
  }
  const manifest = normalizeManifestPaths(parsed);
  const [
    schedulePolicy,
    roleIdentityPolicy,
    dailyQuotaPolicy,
    operationsHealthPolicy,
    autonomousMergePolicy,
    executableDigest
  ] = await Promise.all([
    loadLocalFactorySchedulePolicy(manifest.schedulePolicyPath),
    loadLocalFactoryRoleIdentityPolicy(manifest.roleIdentityPolicyPath),
    manifest.schemaVersion === "agentlab.daily-cycle-manifest.v3" ||
    manifest.schemaVersion === "agentlab.daily-cycle-manifest.v4" ||
    manifest.schemaVersion === "agentlab.daily-cycle-manifest.v5"
      ? loadLocalFactoryDailyQuotaPolicy(manifest.dailyQuotaPolicyPath)
      : Promise.resolve(undefined),
    manifest.schemaVersion === "agentlab.daily-cycle-manifest.v4" ||
    manifest.schemaVersion === "agentlab.daily-cycle-manifest.v5"
      ? loadLocalFactoryOperationsHealthPolicy(manifest.operationsHealthPolicyPath)
      : Promise.resolve(undefined),
    manifest.schemaVersion === "agentlab.daily-cycle-manifest.v5"
      ? loadLocalFactoryAutonomousMergePolicy(manifest.mergePolicyPath)
      : Promise.resolve(undefined),
    pinnedLocalExecutableDigest(manifest.agentlabExecutable.path, "Pinned AgentLab executable")
  ]);
  const schedulePolicyDigest = encodeCanonicalDocument(schedulePolicy).digest;
  const roleIdentityPolicyDigest = encodeCanonicalDocument(roleIdentityPolicy).digest;
  if (schedulePolicyDigest !== manifest.expectedSchedulePolicyDigest) {
    throw new Error("Daily cycle schedule policy changed after review.");
  }
  if (roleIdentityPolicyDigest !== manifest.expectedRoleIdentityPolicyDigest) {
    throw new Error("Daily cycle role identity policy changed after review.");
  }
  if (
    (manifest.schemaVersion === "agentlab.daily-cycle-manifest.v3" ||
      manifest.schemaVersion === "agentlab.daily-cycle-manifest.v4" ||
      manifest.schemaVersion === "agentlab.daily-cycle-manifest.v5") &&
    (dailyQuotaPolicy === undefined ||
      encodeCanonicalDocument(dailyQuotaPolicy).digest !== manifest.expectedDailyQuotaPolicyDigest)
  ) {
    throw new Error("Daily cycle aggregate quota policy changed after review.");
  }
  if (
    (manifest.schemaVersion === "agentlab.daily-cycle-manifest.v4" ||
      manifest.schemaVersion === "agentlab.daily-cycle-manifest.v5") &&
    (operationsHealthPolicy === undefined ||
      encodeCanonicalDocument(operationsHealthPolicy).digest !==
        manifest.expectedOperationsHealthPolicyDigest)
  ) {
    throw new Error("Daily cycle operations health policy changed after review.");
  }
  if (
    manifest.schemaVersion === "agentlab.daily-cycle-manifest.v5" &&
    (autonomousMergePolicy?.digest !== manifest.expectedMergePolicyDigest ||
      autonomousMergePolicy.value.schedulePolicyDigest !== schedulePolicyDigest ||
      dailyQuotaPolicy === undefined ||
      autonomousMergePolicy.value.dailyQuotaPolicyDigest !==
        encodeCanonicalDocument(dailyQuotaPolicy).digest ||
      autonomousMergePolicy.value.roleIdentityPolicyDigest !== roleIdentityPolicyDigest ||
      autonomousMergePolicy.value.mergerUserId !== manifest.merger.userId ||
      autonomousMergePolicy.value.prBrokerUserId !== manifest.broker.userId)
  ) {
    throw new Error(
      "Daily cycle autonomous merge policy or role coordinates changed after review."
    );
  }
  if (executableDigest !== manifest.agentlabExecutable.digest) {
    throw new Error("Daily cycle AgentLab executable changed after review.");
  }
  const executableMetadata = await lstat(manifest.agentlabExecutable.path, { bigint: true });
  if (
    executableMetadata.uid === BigInt(manifest.worker.userId) ||
    executableMetadata.uid === BigInt(manifest.broker.userId) ||
    ((manifest.schemaVersion === "agentlab.daily-cycle-manifest.v4" ||
      manifest.schemaVersion === "agentlab.daily-cycle-manifest.v5") &&
      executableMetadata.uid === BigInt(manifest.incident.userId)) ||
    (manifest.schemaVersion === "agentlab.daily-cycle-manifest.v5" &&
      executableMetadata.uid === BigInt(manifest.merger.userId)) ||
    (executableMetadata.mode & 0o022n) !== 0n
  ) {
    throw new Error(
      "Daily cycle AgentLab executable must be immutable to runtime role identities."
    );
  }
  return {
    ...manifest,
    schedulePolicy,
    roleIdentityPolicy,
    ...(dailyQuotaPolicy === undefined ? {} : { dailyQuotaPolicy }),
    ...(operationsHealthPolicy === undefined ? {} : { operationsHealthPolicy }),
    ...(autonomousMergePolicy === undefined
      ? {}
      : { autonomousMergePolicy: autonomousMergePolicy.value })
  };
}

function normalizeManifestPaths(manifest: FactoryDailyCycleManifest): FactoryDailyCycleManifest {
  const common = {
    ...manifest,
    agentlabExecutable: {
      ...manifest.agentlabExecutable,
      path: privateLocalFilePath(manifest.agentlabExecutable.path, "AgentLab executable")
    },
    executableChecksumPath: privateLocalFilePath(
      manifest.executableChecksumPath,
      "AgentLab executable checksum"
    ),
    worker: {
      ...manifest.worker,
      configPath: privateLocalFilePath(manifest.worker.configPath, "Factory worker config")
    },
    broker: {
      ...manifest.broker,
      configPath: privateLocalFilePath(manifest.broker.configPath, "Factory broker config")
    },
    schedulePolicyPath: privateLocalFilePath(
      manifest.schedulePolicyPath,
      "Factory schedule policy"
    ),
    roleIdentityPolicyPath: privateLocalFilePath(
      manifest.roleIdentityPolicyPath,
      "Factory role identity policy"
    )
  };
  return factoryDailyCycleManifestSchema.parse(
    manifest.schemaVersion !== "agentlab.daily-cycle-manifest.v1"
      ? {
          ...common,
          maintenanceDiscoveryConfigPath: privateLocalFilePath(
            manifest.maintenanceDiscoveryConfigPath,
            "Factory maintenance discovery config"
          ),
          canaryAdmissionConfigPath: privateLocalFilePath(
            manifest.canaryAdmissionConfigPath,
            "Factory canary admission config"
          ),
          ...(manifest.schemaVersion === "agentlab.daily-cycle-manifest.v3" ||
          manifest.schemaVersion === "agentlab.daily-cycle-manifest.v4" ||
          manifest.schemaVersion === "agentlab.daily-cycle-manifest.v5"
            ? {
                dailyQuotaPolicyPath: privateLocalFilePath(
                  manifest.dailyQuotaPolicyPath,
                  "Factory daily quota policy"
                )
              }
            : {}),
          ...(manifest.schemaVersion === "agentlab.daily-cycle-manifest.v4" ||
          manifest.schemaVersion === "agentlab.daily-cycle-manifest.v5"
            ? {
                incident: {
                  ...manifest.incident,
                  configPath: privateLocalFilePath(
                    manifest.incident.configPath,
                    "Factory incident role config"
                  )
                },
                operationsHealthPolicyPath: privateLocalFilePath(
                  manifest.operationsHealthPolicyPath,
                  "Factory operations health policy"
                ),
                ...(manifest.schemaVersion === "agentlab.daily-cycle-manifest.v5"
                  ? {
                      merger: {
                        ...manifest.merger,
                        configPath: privateLocalFilePath(
                          manifest.merger.configPath,
                          "Factory autonomous merger config"
                        )
                      },
                      mergeAdmissionConfigPath: privateLocalFilePath(
                        manifest.mergeAdmissionConfigPath,
                        "Factory autonomous merge admission config"
                      ),
                      mergePolicyPath: privateLocalFilePath(
                        manifest.mergePolicyPath,
                        "Factory autonomous merge policy"
                      )
                    }
                  : {})
              }
            : {})
        }
      : common
  );
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error("Local factory orchestration config is not valid JSON.", { cause: error });
  }
}
