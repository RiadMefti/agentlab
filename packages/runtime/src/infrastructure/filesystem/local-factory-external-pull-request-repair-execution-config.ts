import { isAbsolute, parse, resolve } from "node:path";

import {
  factoryExternalPullRequestRepairAdmissionPolicySchema,
  factoryExternalPullRequestRepairExecutionPolicySchema,
  sha256DigestSchema,
  type FactoryCostPolicy,
  type FactoryExternalPullRequestRepairAdmissionPolicy,
  type FactoryExternalPullRequestRepairExecutionPolicy,
  type FactoryRoleIdentityPolicy,
  type FactorySkillPackage
} from "@agentlab/contracts";
import { z } from "zod";

import type { FactoryAgentProviderBinding } from "../providers/pinned-factory-agent-provider-resolver.js";
import { encodeCanonicalDocument } from "../persistence/canonical-factory-documents.js";
import { factoryPathsOverlap } from "./factory-workspace-paths.js";
import { loadLocalFactoryCostPolicy } from "./local-factory-cost-policy.js";
import { loadFactorySkillPackage } from "./local-factory-preparation-policy-inputs.js";
import { loadLocalFactoryRoleIdentityPolicy } from "./local-factory-role-identity-policy.js";
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
const versionSchema = z
  .string()
  .trim()
  .min(1)
  .max(180)
  .refine((value) => !/[\0\r\n]/u.test(value));
const providerBindingSchema = z
  .object({
    provider: z.enum(["codex", "claude"]),
    executable: absolutePathSchema,
    executableDigest: sha256DigestSchema,
    version: versionSchema
  })
  .strict();

const configSchema = z
  .object({
    schemaVersion: z.literal("agentlab.local-factory-external-pull-request-repair-execution.v1"),
    databasePath: absolutePathSchema,
    artifactRoot: nonRootAbsolutePathSchema,
    workspaceRoot: nonRootAbsolutePathSchema,
    repositoryRoot: nonRootAbsolutePathSchema,
    repositoryId: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/u),
    executionPolicyPath: absolutePathSchema,
    expectedExecutionPolicyDigest: sha256DigestSchema,
    admissionPolicyPath: absolutePathSchema,
    expectedAdmissionPolicyDigest: sha256DigestSchema,
    costPolicyPath: absolutePathSchema,
    expectedCostPolicyDigest: sha256DigestSchema,
    roleIdentityPolicyPath: absolutePathSchema,
    expectedRoleIdentityPolicyDigest: sha256DigestSchema,
    skillPackagePaths: z.array(absolutePathSchema).min(1).max(16),
    gitExecutable: absolutePathSchema,
    flockExecutable: absolutePathSchema,
    systemd: z
      .object({
        runExecutable: absolutePathSchema,
        controlExecutable: absolutePathSchema,
        environmentExecutable: absolutePathSchema,
        version: versionSchema
      })
      .strict(),
    providers: z.array(providerBindingSchema).min(1).max(2)
  })
  .strict()
  .superRefine((config, context) => {
    if (
      new Set(config.providers.map(({ provider }) => provider)).size !== config.providers.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["providers"],
        message: "Repair provider IDs must be unique."
      });
    }
    if (new Set(config.skillPackagePaths).size !== config.skillPackagePaths.length) {
      context.addIssue({
        code: "custom",
        path: ["skillPackagePaths"],
        message: "Repair skill paths must be unique."
      });
    }
    const isolatedPaths = [config.artifactRoot, config.workspaceRoot, config.repositoryRoot];
    for (let left = 0; left < isolatedPaths.length; left += 1) {
      for (let right = left + 1; right < isolatedPaths.length; right += 1) {
        const leftPath = isolatedPaths[left];
        const rightPath = isolatedPaths[right];
        if (
          leftPath !== undefined &&
          rightPath !== undefined &&
          factoryPathsOverlap(leftPath, rightPath)
        ) {
          context.addIssue({
            code: "custom",
            path: ["workspaceRoot"],
            message: "Repository, artifact, and repair worktree roots must not overlap."
          });
        }
      }
    }
    if (isolatedPaths.some((path) => factoryPathsOverlap(config.databasePath, path))) {
      context.addIssue({
        code: "custom",
        path: ["databasePath"],
        message: "The repair database must remain outside repository and artifact roots."
      });
    }
  });

type ParsedConfig = z.infer<typeof configSchema>;

export type LocalFactoryExternalPullRequestRepairExecutionConfig = ParsedConfig & {
  readonly executionPolicy: FactoryExternalPullRequestRepairExecutionPolicy;
  readonly admissionPolicy: FactoryExternalPullRequestRepairAdmissionPolicy;
  readonly costPolicy: FactoryCostPolicy;
  readonly roleIdentityPolicy: FactoryRoleIdentityPolicy;
  readonly skillPackages: readonly FactorySkillPackage[];
  readonly providers: readonly FactoryAgentProviderBinding[];
};

/** Loads the complete owner-pinned, credentialless external-repair worker configuration. */
export async function loadLocalFactoryExternalPullRequestRepairExecutionConfig(
  pathInput: string
): Promise<LocalFactoryExternalPullRequestRepairExecutionConfig> {
  const path = privateLocalFilePath(pathInput, "Local external PR repair execution config");
  const content = await readPrivateLocalFile(path, {
    label: "Local external PR repair execution config",
    minimumBytes: 2,
    maximumBytes: 256 * 1_024
  });
  let config: ParsedConfig;
  try {
    config = configSchema.parse(parseJson(content.toString("utf8"), "config"));
  } finally {
    content.fill(0);
  }
  const [executionPolicy, admissionPolicy, costPolicy, roleIdentityPolicy, skillPackages] =
    await Promise.all([
      loadPolicy(
        config.executionPolicyPath,
        "execution policy",
        factoryExternalPullRequestRepairExecutionPolicySchema
      ),
      loadPolicy(
        config.admissionPolicyPath,
        "admission policy",
        factoryExternalPullRequestRepairAdmissionPolicySchema
      ),
      loadLocalFactoryCostPolicy(config.costPolicyPath),
      loadLocalFactoryRoleIdentityPolicy(config.roleIdentityPolicyPath),
      Promise.all(config.skillPackagePaths.map(loadFactorySkillPackage))
    ]);
  const executionDigest = encodeCanonicalDocument(executionPolicy).digest;
  const admissionDigest = encodeCanonicalDocument(admissionPolicy).digest;
  const costDigest = encodeCanonicalDocument(costPolicy).digest;
  const roleDigest = encodeCanonicalDocument(roleIdentityPolicy).digest;
  if (
    executionDigest !== config.expectedExecutionPolicyDigest ||
    admissionDigest !== config.expectedAdmissionPolicyDigest ||
    costDigest !== config.expectedCostPolicyDigest ||
    roleDigest !== config.expectedRoleIdentityPolicyDigest ||
    executionPolicy.repositoryId !== config.repositoryId ||
    admissionPolicy.repositoryId !== config.repositoryId ||
    executionPolicy.costPolicyDigest !== costDigest ||
    executionPolicy.roleIdentityPolicyDigest !== roleDigest ||
    admissionPolicy.repairExecutionPolicyDigest !== executionDigest ||
    admissionPolicy.costPolicyDigest !== costDigest ||
    admissionPolicy.roleIdentityPolicyDigest !== roleDigest ||
    admissionPolicy.gateProfileDigest !== executionPolicy.gateProfileDigest ||
    admissionPolicy.skillPackageDigests.join("\0") !==
      executionPolicy.repairerProfile.skillDigests.join("\0") ||
    executionPolicy.maximumChangedFiles > admissionPolicy.maximumChangedFiles ||
    executionPolicy.maximumChangedLines > admissionPolicy.maximumChangedLines
  ) {
    throw new Error("External repair execution policy material changed or exceeds admission.");
  }
  const configuredSkillDigests = skillPackages.map(
    (skillPackage) => encodeCanonicalDocument(skillPackage).digest
  );
  if (
    new Set(configuredSkillDigests).size !== configuredSkillDigests.length ||
    configuredSkillDigests.join("\0") !== executionPolicy.repairerProfile.skillDigests.join("\0")
  ) {
    throw new Error("External repair skill inventory does not match its reviewed policy.");
  }
  return {
    ...config,
    executionPolicy,
    admissionPolicy,
    costPolicy,
    roleIdentityPolicy,
    skillPackages
  };
}

async function loadPolicy<Output>(
  pathInput: string,
  label: string,
  schema: { parse(input: unknown): Output }
): Promise<Output> {
  const path = privateLocalFilePath(pathInput, `External repair ${label}`);
  const content = await readPrivateLocalFile(path, {
    label: `External repair ${label}`,
    minimumBytes: 2,
    maximumBytes: 2 * 1_024 * 1_024
  });
  try {
    return schema.parse(parseJson(content.toString("utf8"), label));
  } finally {
    content.fill(0);
  }
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error(`Local external PR repair ${label} is not valid JSON.`, { cause: error });
  }
}
