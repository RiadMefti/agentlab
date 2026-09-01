import { isAbsolute, parse, resolve } from "node:path";

import {
  factoryMaintenanceDiscoveryPolicySchema,
  type FactoryMaintenanceDiscoveryPolicy,
  type FactoryPreparationAuthorityGrant,
  type FactorySkillPackage
} from "@agentlab/contracts";
import { z } from "zod";

import { factoryPathsOverlap } from "./factory-workspace-paths.js";
import {
  loadLocalFactoryWorkerConfig,
  type LocalFactoryWorkerConfig
} from "./local-factory-worker-config.js";
import {
  loadFactoryPreparationGrant,
  loadFactorySkillPackage
} from "./local-factory-preparation-policy-inputs.js";
import { privateLocalFilePath, readPrivateLocalFile } from "./private-local-file.js";

const absolutePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(
    (value) => isAbsolute(value) && !value.includes("\0") && resolve(value) === value,
    "Expected a normalized absolute path."
  );
const nonRootAbsolutePathSchema = absolutePathSchema.refine(
  (value) => value !== parse(value).root,
  "Expected a dedicated non-root path."
);

const configSchema = z
  .object({
    schemaVersion: z.literal("agentlab.local-factory-maintenance-discovery.v1"),
    workerConfigPath: absolutePathSchema,
    repositoryRoot: nonRootAbsolutePathSchema,
    repositoryId: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/u),
    conversationId: z.uuid(),
    discoveryPolicyPath: absolutePathSchema,
    discoverySkillPackagePath: absolutePathSchema,
    preparationGrantPath: absolutePathSchema,
    preparationSkillPackagePaths: z.array(absolutePathSchema).min(4).max(64),
    authorityLifetimeSeconds: z.number().int().min(60).max(604_800)
  })
  .strict()
  .superRefine((config, context) => {
    if (
      new Set(config.preparationSkillPackagePaths).size !==
      config.preparationSkillPackagePaths.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["preparationSkillPackagePaths"],
        message: "Discovery preparation skill package paths must be unique."
      });
    }
  });

type ParsedConfig = z.infer<typeof configSchema>;

export type LocalFactoryMaintenanceDiscoveryConfig = ParsedConfig & {
  readonly workerConfig: LocalFactoryWorkerConfig & {
    readonly schemaVersion: "agentlab.local-factory-worker.v3";
    readonly schedulePolicy: NonNullable<LocalFactoryWorkerConfig["schedulePolicy"]>;
    readonly roleIdentityPolicy: NonNullable<LocalFactoryWorkerConfig["roleIdentityPolicy"]>;
  };
  readonly discoveryPolicy: FactoryMaintenanceDiscoveryPolicy;
  readonly discoverySkillPackage: FactorySkillPackage;
  readonly preparationGrant: FactoryPreparationAuthorityGrant;
  readonly preparationSkillPackages: readonly FactorySkillPackage[];
};

/** Loads owner-only discovery inputs plus the exact scheduled worker configuration. */
export async function loadLocalFactoryMaintenanceDiscoveryConfig(
  pathInput: string
): Promise<LocalFactoryMaintenanceDiscoveryConfig> {
  const path = privateLocalFilePath(pathInput, "Local factory maintenance discovery config");
  const content = await readPrivateLocalFile(path, {
    label: "Local factory maintenance discovery config",
    minimumBytes: 2,
    maximumBytes: 64 * 1_024
  });
  let config: ParsedConfig;
  try {
    config = configSchema.parse(parseJson(content.toString("utf8")));
  } finally {
    content.fill(0);
  }
  const [
    workerConfig,
    discoveryPolicy,
    discoverySkillPackage,
    preparationGrant,
    preparationSkillPackages
  ] = await Promise.all([
    loadLocalFactoryWorkerConfig(config.workerConfigPath),
    loadDiscoveryPolicy(config.discoveryPolicyPath),
    loadFactorySkillPackage(config.discoverySkillPackagePath),
    loadFactoryPreparationGrant(config.preparationGrantPath),
    Promise.all(config.preparationSkillPackagePaths.map(loadFactorySkillPackage))
  ]);
  if (
    workerConfig.schemaVersion !== "agentlab.local-factory-worker.v3" ||
    workerConfig.schedulePolicy === undefined ||
    workerConfig.roleIdentityPolicy === undefined
  ) {
    throw new Error("Maintenance discovery requires a scheduled factory worker v3 configuration.");
  }
  for (const [candidate, label] of [
    [workerConfig.artifactRoot, "artifact root"],
    [workerConfig.workspaceRoot, "workspace root"],
    [workerConfig.databasePath, "database"]
  ] as const) {
    if (factoryPathsOverlap(candidate, config.repositoryRoot)) {
      throw new Error(`Maintenance discovery ${label} must remain outside its repository.`);
    }
  }
  return {
    ...config,
    workerConfig: {
      ...workerConfig,
      schedulePolicy: workerConfig.schedulePolicy,
      roleIdentityPolicy: workerConfig.roleIdentityPolicy
    },
    discoveryPolicy,
    discoverySkillPackage,
    preparationGrant,
    preparationSkillPackages
  };
}

async function loadDiscoveryPolicy(pathInput: string): Promise<FactoryMaintenanceDiscoveryPolicy> {
  const path = privateLocalFilePath(pathInput, "Factory maintenance discovery policy");
  const content = await readPrivateLocalFile(path, {
    label: "Factory maintenance discovery policy",
    minimumBytes: 2,
    maximumBytes: 2 * 1_024 * 1_024
  });
  try {
    return factoryMaintenanceDiscoveryPolicySchema.parse(parseJson(content.toString("utf8")));
  } finally {
    content.fill(0);
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error("Local factory maintenance discovery config is not valid JSON.", {
      cause: error
    });
  }
}
