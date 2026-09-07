import { isAbsolute, parse, relative, resolve, sep } from "node:path";

import {
  factoryExternalPullRequestRepairExecutionPolicySchema,
  factoryExternalPullRequestRepairQualificationPolicySchema,
  sha256DigestSchema,
  type FactoryCostPolicy,
  type FactoryExternalPullRequestRepairExecutionPolicy,
  type FactoryExternalPullRequestRepairQualificationPolicy,
  type FactoryRoleIdentityPolicy,
  type FactorySkillPackage
} from "@agentlab/contracts";
import { z } from "zod";

import type { FactoryGateDefinition } from "../../domain/factory-gate.js";
import type { FactoryAgentProviderBinding } from "../providers/pinned-factory-agent-provider-resolver.js";
import { encodeCanonicalDocument } from "../persistence/canonical-factory-documents.js";
import { factoryPathsOverlap } from "./factory-workspace-paths.js";
import { loadLocalFactoryCostPolicy } from "./local-factory-cost-policy.js";
import { loadFactorySkillPackage } from "./local-factory-preparation-policy-inputs.js";
import { loadLocalFactoryRoleIdentityPolicy } from "./local-factory-role-identity-policy.js";
import { pinnedLocalExecutableDigest } from "./pinned-local-executable.js";
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
    schemaVersion: z.literal(
      "agentlab.local-factory-external-pull-request-repair-qualification.v1"
    ),
    databasePath: absolutePathSchema,
    artifactRoot: nonRootAbsolutePathSchema,
    workspaceRoot: nonRootAbsolutePathSchema,
    repositoryRoot: nonRootAbsolutePathSchema,
    repositoryId: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/u),
    qualificationPolicyPath: absolutePathSchema,
    expectedQualificationPolicyDigest: sha256DigestSchema,
    repairExecutionPolicyPath: absolutePathSchema,
    expectedRepairExecutionPolicyDigest: sha256DigestSchema,
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
    sandbox: z
      .object({
        bubblewrapExecutable: absolutePathSchema,
        runtimeRoots: z.array(nonRootAbsolutePathSchema).max(8)
      })
      .strict(),
    providers: z.array(providerBindingSchema).min(1).max(2)
  })
  .strict()
  .superRefine((config, context) => {
    unique(
      config.providers.map(({ provider }) => provider),
      context,
      ["providers"],
      "provider IDs"
    );
    unique(config.skillPackagePaths, context, ["skillPackagePaths"], "skill paths");
    unique(config.sandbox.runtimeRoots, context, ["sandbox", "runtimeRoots"], "runtime roots");
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
            message: "Repository, artifact, and qualification worktree roots must not overlap."
          });
        }
      }
    }
    if (isolatedPaths.some((path) => factoryPathsOverlap(config.databasePath, path))) {
      context.addIssue({
        code: "custom",
        path: ["databasePath"],
        message: "The qualification database must remain outside repository and artifact roots."
      });
    }
    if (
      config.sandbox.runtimeRoots.some((root) =>
        isolatedPaths.some((path) => factoryPathsOverlap(root, path))
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["sandbox", "runtimeRoots"],
        message:
          "Qualification runtime roots must not overlap mutable repository or evidence roots."
      });
    }
  });

type ParsedConfig = z.infer<typeof configSchema>;

export type LocalFactoryExternalPullRequestRepairQualificationConfig = ParsedConfig & {
  readonly qualificationPolicy: FactoryExternalPullRequestRepairQualificationPolicy;
  readonly repairExecutionPolicy: FactoryExternalPullRequestRepairExecutionPolicy;
  readonly costPolicy: FactoryCostPolicy;
  readonly roleIdentityPolicy: FactoryRoleIdentityPolicy;
  readonly skillPackages: readonly FactorySkillPackage[];
  readonly providers: readonly FactoryAgentProviderBinding[];
  readonly gates: readonly FactoryGateDefinition[];
};

/** Loads one complete, owner-pinned, credentialless post-repair qualification configuration. */
export async function loadLocalFactoryExternalPullRequestRepairQualificationConfig(
  pathInput: string
): Promise<LocalFactoryExternalPullRequestRepairQualificationConfig> {
  const path = privateLocalFilePath(pathInput, "Local external PR repair qualification config");
  const content = await readPrivateLocalFile(path, {
    label: "Local external PR repair qualification config",
    minimumBytes: 2,
    maximumBytes: 256 * 1_024
  });
  let config: ParsedConfig;
  try {
    config = configSchema.parse(parseJson(content.toString("utf8"), "config"));
  } finally {
    content.fill(0);
  }
  const [
    qualificationPolicy,
    repairExecutionPolicy,
    costPolicy,
    roleIdentityPolicy,
    skillPackages
  ] = await Promise.all([
    loadPolicy(
      config.qualificationPolicyPath,
      "qualification policy",
      factoryExternalPullRequestRepairQualificationPolicySchema
    ),
    loadPolicy(
      config.repairExecutionPolicyPath,
      "repair execution policy",
      factoryExternalPullRequestRepairExecutionPolicySchema
    ),
    loadLocalFactoryCostPolicy(config.costPolicyPath),
    loadLocalFactoryRoleIdentityPolicy(config.roleIdentityPolicyPath),
    Promise.all(config.skillPackagePaths.map(loadFactorySkillPackage))
  ]);
  const qualificationDigest = encodeCanonicalDocument(qualificationPolicy).digest;
  const executionDigest = encodeCanonicalDocument(repairExecutionPolicy).digest;
  const costDigest = encodeCanonicalDocument(costPolicy).digest;
  const roleDigest = encodeCanonicalDocument(roleIdentityPolicy).digest;
  const gateDigest = encodeCanonicalDocument(qualificationPolicy.gateProfile).digest;
  if (
    qualificationDigest !== config.expectedQualificationPolicyDigest ||
    executionDigest !== config.expectedRepairExecutionPolicyDigest ||
    costDigest !== config.expectedCostPolicyDigest ||
    roleDigest !== config.expectedRoleIdentityPolicyDigest ||
    qualificationPolicy.repositoryId !== config.repositoryId ||
    repairExecutionPolicy.repositoryId !== config.repositoryId ||
    repairExecutionPolicy.qualificationPolicyDigest !== qualificationDigest ||
    qualificationPolicy.costPolicyDigest !== costDigest ||
    repairExecutionPolicy.costPolicyDigest !== costDigest ||
    qualificationPolicy.roleIdentityPolicyDigest !== roleDigest ||
    repairExecutionPolicy.roleIdentityPolicyDigest !== roleDigest ||
    qualificationPolicy.gateProfileDigest !== gateDigest ||
    repairExecutionPolicy.gateProfileDigest !== gateDigest ||
    qualificationPolicy.maximumPatchBytes < repairExecutionPolicy.maximumPatchBytes ||
    qualificationPolicy.aggregateBudget.maxChangedFiles <
      repairExecutionPolicy.maximumChangedFiles ||
    qualificationPolicy.aggregateBudget.maxChangedLines <
      repairExecutionPolicy.maximumChangedLines ||
    qualificationPolicy.reviewerProfiles.some(
      ({ id }) => id === repairExecutionPolicy.repairerProfile.id
    )
  ) {
    throw new Error(
      "External repair qualification policy material changed or weakens repair bounds."
    );
  }
  if (
    qualificationPolicy.gateProfile.gates.some(
      ({ command }) =>
        !command.executable.startsWith("/usr/") &&
        !config.sandbox.runtimeRoots.some((root) => isPathInside(root, command.executable))
    )
  ) {
    throw new Error("External repair qualification gate executable is outside trusted mounts.");
  }
  const expectedSkillDigests = [
    ...new Set(qualificationPolicy.reviewerProfiles.flatMap(({ skillDigests }) => skillDigests))
  ];
  const configuredSkillDigests = skillPackages.map(
    (skillPackage) => encodeCanonicalDocument(skillPackage).digest
  );
  if (
    new Set(configuredSkillDigests).size !== configuredSkillDigests.length ||
    configuredSkillDigests.join("\0") !== expectedSkillDigests.join("\0")
  ) {
    throw new Error("External repair qualification skill inventory changed after review.");
  }
  await verifyGateExecutables(qualificationPolicy);
  return {
    ...config,
    qualificationPolicy,
    repairExecutionPolicy,
    costPolicy,
    roleIdentityPolicy,
    skillPackages,
    gates: qualificationPolicy.gateProfile.gates.map(({ command, ...gate }) => ({
      ...gate,
      command: { executable: command.executable, args: command.args }
    }))
  };
}

async function verifyGateExecutables(
  policy: FactoryExternalPullRequestRepairQualificationPolicy
): Promise<void> {
  const expectedByPath = new Map<string, string>();
  for (const gate of policy.gateProfile.gates) {
    const prior = expectedByPath.get(gate.command.executable);
    if (prior !== undefined && prior !== gate.command.executableDigest) {
      throw new Error("One qualification executable has conflicting reviewed digests.");
    }
    expectedByPath.set(gate.command.executable, gate.command.executableDigest);
  }
  await Promise.all(
    [...expectedByPath].map(async ([executable, expectedDigest]) => {
      const actual = await pinnedLocalExecutableDigest(
        executable,
        "Pinned external repair qualification gate executable"
      );
      if (actual !== expectedDigest) {
        throw new Error("External repair qualification gate executable changed after review.");
      }
    })
  );
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

function unique(
  values: readonly string[],
  context: z.RefinementCtx,
  path: PropertyKey[],
  label: string
): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", path, message: `Qualification ${label} must be unique.` });
  }
}

function isPathInside(root: string, path: string): boolean {
  const child = relative(root, path);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error(`Local external PR repair qualification ${label} is not valid JSON.`, {
      cause: error
    });
  }
}
