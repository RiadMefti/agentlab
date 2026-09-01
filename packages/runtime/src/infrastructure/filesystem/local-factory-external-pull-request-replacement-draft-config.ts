import { isAbsolute, parse, resolve } from "node:path";

import {
  factoryExternalPullRequestRepairQualificationPolicySchema,
  factoryExternalPullRequestReplacementDraftPolicySchema,
  sha256DigestSchema,
  type FactoryExternalPullRequestRepairQualificationPolicy,
  type FactoryExternalPullRequestReplacementDraftPolicy,
  type FactoryRoleIdentityPolicy
} from "@agentlab/contracts";
import { z } from "zod";

import { encodeCanonicalDocument } from "../persistence/canonical-factory-documents.js";
import { factoryPathsOverlap } from "./factory-workspace-paths.js";
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
const trustedStatusChecksSchema = z
  .array(
    z
      .object({
        context: z.enum(["verify", "factory-sandbox"]),
        appId: z.number().int().positive().refine(Number.isSafeInteger)
      })
      .strict()
  )
  .length(2)
  .refine((checks) => new Set(checks.map(({ context }) => context)).size === 2);

const configSchema = z
  .object({
    schemaVersion: z.literal("agentlab.local-factory-external-pull-request-replacement-draft.v1"),
    databasePath: absolutePathSchema,
    artifactRoot: nonRootAbsolutePathSchema,
    temporaryRoot: nonRootAbsolutePathSchema,
    repositoryRoot: nonRootAbsolutePathSchema,
    repositoryId: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/u),
    repositoryNumericId: z.number().int().positive().refine(Number.isSafeInteger),
    publicationPolicyPath: absolutePathSchema,
    expectedPublicationPolicyDigest: sha256DigestSchema,
    qualificationPolicyPath: absolutePathSchema,
    expectedQualificationPolicyDigest: sha256DigestSchema,
    roleIdentityPolicyPath: absolutePathSchema,
    expectedRoleIdentityPolicyDigest: sha256DigestSchema,
    gitExecutable: absolutePathSchema,
    githubApp: z
      .object({
        clientId: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/u),
        installationId: z.number().int().positive().refine(Number.isSafeInteger),
        publisherUserId: z.number().int().positive().refine(Number.isSafeInteger),
        privateKeyPath: absolutePathSchema,
        trustedStatusChecks: trustedStatusChecksSchema
      })
      .strict()
  })
  .strict()
  .superRefine((config, context) => {
    const roots = [config.artifactRoot, config.temporaryRoot, config.repositoryRoot];
    for (let left = 0; left < roots.length; left += 1)
      for (let right = left + 1; right < roots.length; right += 1) {
        if (factoryPathsOverlap(roots[left] ?? "", roots[right] ?? ""))
          context.addIssue({
            code: "custom",
            path: ["temporaryRoot"],
            message: "Repository, artifact, and broker temporary roots must not overlap."
          });
      }
    if (
      roots.some(
        (root) =>
          factoryPathsOverlap(config.databasePath, root) ||
          factoryPathsOverlap(config.githubApp.privateKeyPath, root)
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["databasePath"],
        message:
          "Broker database and private key must remain outside repository and evidence roots."
      });
    }
  });

type ParsedConfig = z.infer<typeof configSchema>;
export type LocalFactoryExternalPullRequestReplacementDraftConfig = ParsedConfig & {
  readonly publicationPolicy: FactoryExternalPullRequestReplacementDraftPolicy;
  readonly qualificationPolicy: FactoryExternalPullRequestRepairQualificationPolicy;
  readonly roleIdentityPolicy: FactoryRoleIdentityPolicy;
};

/** Loads owner-pinned publication policy and a distinct, fixed-purpose GitHub App config. */
export async function loadLocalFactoryExternalPullRequestReplacementDraftConfig(
  pathInput: string
): Promise<LocalFactoryExternalPullRequestReplacementDraftConfig> {
  const path = privateLocalFilePath(pathInput, "Local external PR replacement-draft config");
  const content = await readPrivateLocalFile(path, {
    label: "Local external PR replacement-draft config",
    minimumBytes: 2,
    maximumBytes: 128 * 1_024
  });
  let config: ParsedConfig;
  try {
    config = configSchema.parse(parseJson(content.toString("utf8"), "config"));
  } finally {
    content.fill(0);
  }
  const [publicationPolicy, qualificationPolicy, roleIdentityPolicy] = await Promise.all([
    loadPolicy(
      config.publicationPolicyPath,
      "publication policy",
      factoryExternalPullRequestReplacementDraftPolicySchema
    ),
    loadPolicy(
      config.qualificationPolicyPath,
      "qualification policy",
      factoryExternalPullRequestRepairQualificationPolicySchema
    ),
    loadLocalFactoryRoleIdentityPolicy(config.roleIdentityPolicyPath)
  ]);
  const publicationDigest = encodeCanonicalDocument(publicationPolicy).digest;
  const qualificationDigest = encodeCanonicalDocument(qualificationPolicy).digest;
  const roleDigest = encodeCanonicalDocument(roleIdentityPolicy).digest;
  if (
    publicationDigest !== config.expectedPublicationPolicyDigest ||
    qualificationDigest !== config.expectedQualificationPolicyDigest ||
    roleDigest !== config.expectedRoleIdentityPolicyDigest ||
    publicationPolicy.repositoryId !== config.repositoryId ||
    qualificationPolicy.repositoryId !== config.repositoryId ||
    publicationPolicy.qualificationPolicyDigest !== qualificationDigest ||
    publicationPolicy.roleIdentityPolicyDigest !== roleDigest ||
    publicationPolicy.maximumPatchBytes !== qualificationPolicy.maximumPatchBytes ||
    publicationPolicy.brokerUserId === roleIdentityPolicy.worker.userId ||
    publicationPolicy.brokerUserId === roleIdentityPolicy.evalAttestor.userId ||
    publicationPolicy.publisherId !== `github-user/${String(config.githubApp.publisherUserId)}` ||
    publicationPolicy.requiredStatusChecks.join("\0") !==
      config.githubApp.trustedStatusChecks.map(({ context }) => context).join("\0")
  )
    throw new Error("Replacement-draft authority material changed or violates role separation.");
  return { ...config, publicationPolicy, qualificationPolicy, roleIdentityPolicy };
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
    throw new Error(`Local external PR replacement-draft ${label} is not valid JSON.`, {
      cause: error
    });
  }
}
