import { isAbsolute, parse, resolve } from "node:path";

import {
  factoryExternalPullRequestReviewPolicySchema,
  sha256DigestSchema,
  type FactoryCostPolicy,
  type FactoryExternalPullRequestReviewPolicy,
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
    schemaVersion: z.literal("agentlab.local-factory-external-pull-request-review.v1"),
    databasePath: absolutePathSchema,
    artifactRoot: nonRootAbsolutePathSchema,
    workspaceRoot: nonRootAbsolutePathSchema,
    repositoryRoot: nonRootAbsolutePathSchema,
    repositoryId: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/u),
    reviewPolicyPath: absolutePathSchema,
    expectedReviewPolicyDigest: sha256DigestSchema,
    costPolicyPath: absolutePathSchema,
    expectedCostPolicyDigest: sha256DigestSchema,
    roleIdentityPolicyPath: absolutePathSchema,
    expectedRoleIdentityPolicyDigest: sha256DigestSchema,
    skillPackagePaths: z.array(absolutePathSchema).min(1).max(80),
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
        message: "External PR reviewer provider IDs must be unique."
      });
    }
    if (new Set(config.skillPackagePaths).size !== config.skillPackagePaths.length) {
      context.addIssue({
        code: "custom",
        path: ["skillPackagePaths"],
        message: "External PR reviewer skill package paths must be unique."
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
            message: "Repository, artifact, and reviewer worktree roots must not overlap."
          });
        }
      }
    }
    for (const isolatedPath of isolatedPaths) {
      if (factoryPathsOverlap(config.databasePath, isolatedPath)) {
        context.addIssue({
          code: "custom",
          path: ["databasePath"],
          message:
            "The external PR review database must remain outside repository and artifact roots."
        });
        break;
      }
    }
  });

type ParsedConfig = z.infer<typeof configSchema>;

export type LocalFactoryExternalPullRequestReviewConfig = ParsedConfig & {
  readonly reviewPolicy: FactoryExternalPullRequestReviewPolicy;
  readonly costPolicy: FactoryCostPolicy;
  readonly roleIdentityPolicy: FactoryRoleIdentityPolicy;
  readonly skillPackages: readonly FactorySkillPackage[];
  readonly providers: readonly FactoryAgentProviderBinding[];
};

/** Loads an owner-only, fully pinned external-review process configuration. */
export async function loadLocalFactoryExternalPullRequestReviewConfig(
  pathInput: string
): Promise<LocalFactoryExternalPullRequestReviewConfig> {
  const path = privateLocalFilePath(pathInput, "Local factory external PR review config");
  const content = await readPrivateLocalFile(path, {
    label: "Local factory external PR review config",
    minimumBytes: 2,
    maximumBytes: 256 * 1_024
  });
  let config: ParsedConfig;
  try {
    config = configSchema.parse(parseJson(content.toString("utf8"), "config"));
  } finally {
    content.fill(0);
  }
  const [reviewPolicy, costPolicy, roleIdentityPolicy, skillPackages] = await Promise.all([
    loadReviewPolicy(config.reviewPolicyPath),
    loadLocalFactoryCostPolicy(config.costPolicyPath),
    loadLocalFactoryRoleIdentityPolicy(config.roleIdentityPolicyPath),
    Promise.all(config.skillPackagePaths.map(loadFactorySkillPackage))
  ]);
  if (reviewPolicy.repositoryId !== config.repositoryId) {
    throw new Error("External PR review policy repository does not match its configuration.");
  }
  const reviewPolicyDigest = encodeCanonicalDocument(reviewPolicy).digest;
  const costPolicyDigest = encodeCanonicalDocument(costPolicy).digest;
  const roleIdentityPolicyDigest = encodeCanonicalDocument(roleIdentityPolicy).digest;
  if (
    reviewPolicyDigest !== config.expectedReviewPolicyDigest ||
    costPolicyDigest !== config.expectedCostPolicyDigest ||
    roleIdentityPolicyDigest !== config.expectedRoleIdentityPolicyDigest
  ) {
    throw new Error("External PR review policy material changed after owner review.");
  }
  const configuredSkillDigests = skillPackages.map(
    (skillPackage) => encodeCanonicalDocument(skillPackage).digest
  );
  const requiredSkillDigests = [
    ...new Set(reviewPolicy.reviewerProfiles.flatMap(({ skillDigests }) => skillDigests))
  ].sort();
  if (
    new Set(configuredSkillDigests).size !== configuredSkillDigests.length ||
    configuredSkillDigests.toSorted().join("\0") !== requiredSkillDigests.join("\0")
  ) {
    throw new Error("External PR review skill inventory does not match its reviewed policy.");
  }
  return { ...config, reviewPolicy, costPolicy, roleIdentityPolicy, skillPackages };
}

async function loadReviewPolicy(
  pathInput: string
): Promise<FactoryExternalPullRequestReviewPolicy> {
  const path = privateLocalFilePath(pathInput, "Factory external PR review policy");
  const content = await readPrivateLocalFile(path, {
    label: "Factory external PR review policy",
    minimumBytes: 2,
    maximumBytes: 2 * 1_024 * 1_024
  });
  try {
    return factoryExternalPullRequestReviewPolicySchema.parse(
      parseJson(content.toString("utf8"), "review policy")
    );
  } finally {
    content.fill(0);
  }
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error(`Local factory external PR ${label} is not valid JSON.`, { cause: error });
  }
}
