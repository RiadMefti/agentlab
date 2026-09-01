import { lstat } from "node:fs/promises";

import {
  factoryDailyCycleManifestSchema,
  type FactoryDailyCycleManifest,
  type FactoryRoleIdentityPolicy,
  type FactorySchedulePolicy
} from "@agentlab/contracts";

import { encodeCanonicalDocument } from "../persistence/canonical-factory-documents.js";
import { loadLocalFactoryRoleIdentityPolicy } from "./local-factory-role-identity-policy.js";
import { loadLocalFactorySchedulePolicy } from "./local-factory-schedule-policy.js";
import { pinnedLocalExecutableDigest } from "./pinned-local-executable.js";
import { privateLocalFilePath, readPrivateLocalFile } from "./private-local-file.js";

export type LocalFactoryOrchestrationConfig = FactoryDailyCycleManifest & {
  readonly schedulePolicy: FactorySchedulePolicy;
  readonly roleIdentityPolicy: FactoryRoleIdentityPolicy;
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
  const [schedulePolicy, roleIdentityPolicy, executableDigest] = await Promise.all([
    loadLocalFactorySchedulePolicy(manifest.schedulePolicyPath),
    loadLocalFactoryRoleIdentityPolicy(manifest.roleIdentityPolicyPath),
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
  if (executableDigest !== manifest.agentlabExecutable.digest) {
    throw new Error("Daily cycle AgentLab executable changed after review.");
  }
  const executableMetadata = await lstat(manifest.agentlabExecutable.path, { bigint: true });
  if (
    executableMetadata.uid === BigInt(manifest.worker.userId) ||
    executableMetadata.uid === BigInt(manifest.broker.userId) ||
    (executableMetadata.mode & 0o022n) !== 0n
  ) {
    throw new Error(
      "Daily cycle AgentLab executable must be immutable to worker and broker identities."
    );
  }
  return { ...manifest, schedulePolicy, roleIdentityPolicy };
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
    manifest.schemaVersion === "agentlab.daily-cycle-manifest.v2"
      ? {
          ...common,
          maintenanceDiscoveryConfigPath: privateLocalFilePath(
            manifest.maintenanceDiscoveryConfigPath,
            "Factory maintenance discovery config"
          ),
          canaryAdmissionConfigPath: privateLocalFilePath(
            manifest.canaryAdmissionConfigPath,
            "Factory canary admission config"
          )
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
