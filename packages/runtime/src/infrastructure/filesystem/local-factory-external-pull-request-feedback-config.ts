import { isAbsolute, parse, resolve } from "node:path";

import {
  factoryExternalPullRequestFeedbackPolicySchema,
  sha256DigestSchema,
  type FactoryExternalPullRequestFeedbackPolicy
} from "@agentlab/contracts";
import { z } from "zod";

import { factoryPathsOverlap } from "./factory-workspace-paths.js";
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
    schemaVersion: z.literal("agentlab.local-factory-external-pull-request-feedback.v1"),
    databasePath: absolutePathSchema,
    artifactRoot: nonRootAbsolutePathSchema,
    repositoryId: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/u),
    repositoryNumericId: z.number().int().positive().refine(Number.isSafeInteger),
    processUserId: z.number().int().positive().max(4_294_967_294),
    feedbackPolicyPath: absolutePathSchema,
    expectedFeedbackPolicyDigest: sha256DigestSchema,
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

export type LocalFactoryExternalPullRequestFeedbackConfig = ParsedConfig & {
  readonly feedbackPolicy: FactoryExternalPullRequestFeedbackPolicy;
};

/** Loads the owner-only, exact-purpose feedback publisher configuration. */
export async function loadLocalFactoryExternalPullRequestFeedbackConfig(
  pathInput: string
): Promise<LocalFactoryExternalPullRequestFeedbackConfig> {
  const path = privateLocalFilePath(pathInput, "External PR feedback config");
  const content = await readPrivateLocalFile(path, {
    label: "External PR feedback config",
    minimumBytes: 2,
    maximumBytes: 64 * 1_024
  });
  let config: ParsedConfig;
  try {
    config = configSchema.parse(parseJson(content.toString("utf8"), "config"));
  } finally {
    content.fill(0);
  }
  if (factoryPathsOverlap(config.databasePath, config.artifactRoot)) {
    throw new Error("External PR feedback database and artifact root must not overlap.");
  }
  const policyPath = privateLocalFilePath(config.feedbackPolicyPath, "External PR feedback policy");
  const policyContent = await readPrivateLocalFile(policyPath, {
    label: "External PR feedback policy",
    minimumBytes: 2,
    maximumBytes: 2 * 1_024 * 1_024
  });
  let feedbackPolicy: FactoryExternalPullRequestFeedbackPolicy;
  try {
    feedbackPolicy = factoryExternalPullRequestFeedbackPolicySchema.parse(
      parseJson(policyContent.toString("utf8"), "policy")
    );
  } finally {
    policyContent.fill(0);
  }
  if (
    feedbackPolicy.repositoryId !== config.repositoryId ||
    encodeCanonicalDocument(feedbackPolicy).digest !== config.expectedFeedbackPolicyDigest
  ) {
    throw new Error("External PR feedback policy changed after owner review.");
  }
  return { ...config, feedbackPolicy };
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error(`External PR feedback ${label} is not valid JSON.`, { cause: error });
  }
}
