import { isAbsolute, parse, resolve } from "node:path";

import {
  factoryExternalPullRequestDiscoveryPolicySchema,
  factoryIdentifierSchema,
  sha256DigestSchema,
  type FactoryExternalPullRequestDiscoveryPolicy,
  type FactorySchedulePolicy
} from "@agentlab/contracts";
import { z } from "zod";

import { factoryPathsOverlap } from "./factory-workspace-paths.js";
import { loadLocalFactorySchedulePolicy } from "./local-factory-schedule-policy.js";
import { privateLocalFilePath, readPrivateLocalFile } from "./private-local-file.js";
import { encodeCanonicalDocument } from "../persistence/canonical-factory-documents.js";

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
    schemaVersion: z.literal("agentlab.local-factory-external-pull-request-discovery.v1"),
    databasePath: absolutePathSchema,
    artifactRoot: nonRootAbsolutePathSchema,
    repositoryId: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/u),
    repositoryNumericId: z.number().int().positive().refine(Number.isSafeInteger),
    observerId: factoryIdentifierSchema,
    discoveryPolicyPath: absolutePathSchema,
    expectedDiscoveryPolicyDigest: sha256DigestSchema,
    schedulePolicyPath: absolutePathSchema,
    expectedSchedulePolicyDigest: sha256DigestSchema,
    githubApp: z
      .object({
        clientId: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/u),
        installationId: z.number().int().positive().refine(Number.isSafeInteger),
        privateKeyPath: absolutePathSchema
      })
      .strict()
  })
  .strict();

type ParsedConfig = z.infer<typeof configSchema>;

export type LocalFactoryExternalPullRequestDiscoveryConfig = ParsedConfig & {
  readonly discoveryPolicy: FactoryExternalPullRequestDiscoveryPolicy;
  readonly schedulePolicy: FactorySchedulePolicy;
};

/** Loads a strict owner-only config; the GitHub App private key remains unopened until composition. */
export async function loadLocalFactoryExternalPullRequestDiscoveryConfig(
  pathInput: string
): Promise<LocalFactoryExternalPullRequestDiscoveryConfig> {
  const path = privateLocalFilePath(pathInput, "External PR discovery config");
  const content = await readPrivateLocalFile(path, {
    label: "External PR discovery config",
    minimumBytes: 2,
    maximumBytes: 64 * 1_024
  });
  let config: ParsedConfig;
  try {
    config = configSchema.parse(parseJson(content.toString("utf8")));
  } finally {
    content.fill(0);
  }
  if (factoryPathsOverlap(config.databasePath, config.artifactRoot)) {
    throw new Error("External PR discovery database and artifact root must not overlap.");
  }
  const [discoveryPolicy, schedulePolicy] = await Promise.all([
    loadDiscoveryPolicy(config.discoveryPolicyPath),
    loadLocalFactorySchedulePolicy(config.schedulePolicyPath)
  ]);
  const discoveryDocument = encodeCanonicalDocument(discoveryPolicy);
  const scheduleDocument = encodeCanonicalDocument(schedulePolicy);
  if (
    discoveryDocument.digest !== config.expectedDiscoveryPolicyDigest ||
    scheduleDocument.digest !== config.expectedSchedulePolicyDigest
  ) {
    throw new Error("External PR discovery policy changed after owner review.");
  }
  if (discoveryPolicy.repositoryId !== config.repositoryId) {
    throw new Error("External PR discovery policy names another repository.");
  }
  return { ...config, discoveryPolicy, schedulePolicy };
}

async function loadDiscoveryPolicy(
  pathInput: string
): Promise<FactoryExternalPullRequestDiscoveryPolicy> {
  const path = privateLocalFilePath(pathInput, "External PR discovery policy");
  const content = await readPrivateLocalFile(path, {
    label: "External PR discovery policy",
    minimumBytes: 2,
    maximumBytes: 2 * 1_024 * 1_024
  });
  try {
    return factoryExternalPullRequestDiscoveryPolicySchema.parse(
      parseJson(content.toString("utf8"))
    );
  } finally {
    content.fill(0);
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error("External PR discovery config is not valid JSON.", { cause: error });
  }
}
