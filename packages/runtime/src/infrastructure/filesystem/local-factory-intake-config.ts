import { isAbsolute, parse, resolve } from "node:path";

import {
  factoryIdentifierSchema,
  factoryPreparationAuthorityGrantSchema,
  factorySkillPackageSchema,
  type FactoryCostPolicy,
  type FactoryPreparationAuthorityGrant,
  type FactorySkillPackage
} from "@agentlab/contracts";
import { z } from "zod";

import { factoryPathsOverlap } from "./factory-workspace-paths.js";
import { loadLocalFactoryCostPolicy } from "./local-factory-cost-policy.js";
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
    schemaVersion: z.literal("agentlab.local-factory-intake.v1"),
    databasePath: absolutePathSchema,
    artifactRoot: nonRootAbsolutePathSchema,
    repositoryRoot: nonRootAbsolutePathSchema,
    repositoryId: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/u),
    conversationId: z.uuid(),
    operatorId: factoryIdentifierSchema,
    gitExecutable: absolutePathSchema,
    flockExecutable: absolutePathSchema,
    costPolicyPath: absolutePathSchema,
    preparationGrantPath: absolutePathSchema,
    skillPackagePaths: z.array(absolutePathSchema).min(4).max(64),
    authorityLifetimeSeconds: z.number().int().min(60).max(604_800)
  })
  .strict()
  .superRefine((config, context) => {
    if (new Set(config.skillPackagePaths).size !== config.skillPackagePaths.length) {
      context.addIssue({
        code: "custom",
        path: ["skillPackagePaths"],
        message: "Factory intake skill package paths must be unique."
      });
    }
    for (const [path, message] of [
      [config.artifactRoot, "Factory artifact and repository roots must not overlap."],
      [config.databasePath, "Factory database must remain outside the source repository."]
    ] as const) {
      if (factoryPathsOverlap(path, config.repositoryRoot)) {
        context.addIssue({ code: "custom", path: ["repositoryRoot"], message });
      }
    }
    if (factoryPathsOverlap(config.artifactRoot, config.databasePath)) {
      context.addIssue({
        code: "custom",
        path: ["databasePath"],
        message: "Factory database must remain outside the content-addressed artifact root."
      });
    }
  });

type ParsedLocalFactoryIntakeConfig = z.infer<typeof configSchema>;

export type LocalFactoryIntakeConfig = ParsedLocalFactoryIntakeConfig & {
  readonly costPolicy: FactoryCostPolicy;
  readonly preparationGrant: FactoryPreparationAuthorityGrant;
  readonly skillPackages: readonly FactorySkillPackage[];
};

/** Loads strict owner-only intake, policy, authority, and skill-package documents. */
export async function loadLocalFactoryIntakeConfig(
  pathInput: string
): Promise<LocalFactoryIntakeConfig> {
  const path = privateLocalFilePath(pathInput, "Local factory intake config");
  const content = await readPrivateLocalFile(path, {
    label: "Local factory intake config",
    minimumBytes: 2,
    maximumBytes: 256 * 1_024
  });
  let config: ParsedLocalFactoryIntakeConfig;
  try {
    config = configSchema.parse(parseJson(content.toString("utf8"), "intake config"));
  } finally {
    content.fill(0);
  }
  const [costPolicy, preparationGrant, skillPackages] = await Promise.all([
    loadLocalFactoryCostPolicy(config.costPolicyPath),
    loadPreparationGrant(config.preparationGrantPath),
    Promise.all(config.skillPackagePaths.map((skillPath) => loadSkillPackage(skillPath)))
  ]);
  return { ...config, costPolicy, preparationGrant, skillPackages };
}

async function loadPreparationGrant(pathInput: string): Promise<FactoryPreparationAuthorityGrant> {
  const path = privateLocalFilePath(pathInput, "Factory preparation authority grant");
  const content = await readPrivateLocalFile(path, {
    label: "Factory preparation authority grant",
    minimumBytes: 2,
    maximumBytes: 2 * 1_024 * 1_024
  });
  try {
    return factoryPreparationAuthorityGrantSchema.parse(
      parseJson(content.toString("utf8"), "preparation authority grant")
    );
  } finally {
    content.fill(0);
  }
}

async function loadSkillPackage(pathInput: string): Promise<FactorySkillPackage> {
  const path = privateLocalFilePath(pathInput, "Factory skill package");
  const content = await readPrivateLocalFile(path, {
    label: "Factory skill package",
    minimumBytes: 2,
    maximumBytes: 8 * 1_024 * 1_024
  });
  try {
    return factorySkillPackageSchema.parse(parseJson(content.toString("utf8"), "skill package"));
  } finally {
    content.fill(0);
  }
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error(`Local factory ${label} is not valid JSON.`, { cause: error });
  }
}
