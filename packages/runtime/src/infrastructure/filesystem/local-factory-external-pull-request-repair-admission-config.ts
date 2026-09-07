import { isAbsolute, resolve } from "node:path";

import {
  factoryExternalPullRequestRepairAdmissionPolicySchema,
  sha256DigestSchema,
  type FactoryExternalPullRequestRepairAdmissionPolicy
} from "@agentlab/contracts";
import { z } from "zod";

import { encodeCanonicalDocument } from "../persistence/canonical-factory-documents.js";
import { privateLocalFilePath, readPrivateLocalFile } from "./private-local-file.js";

const absolutePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(
    (value) => isAbsolute(value) && !value.includes("\0") && resolve(value) === value,
    "Expected a normalized absolute path."
  );

const configSchema = z
  .object({
    schemaVersion: z.literal("agentlab.local-factory-external-pull-request-repair-admission.v1"),
    databasePath: absolutePathSchema,
    repositoryId: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/u),
    processUserId: z.number().int().positive().max(4_294_967_294),
    admissionPolicyPath: absolutePathSchema,
    expectedAdmissionPolicyDigest: sha256DigestSchema
  })
  .strict();

type ParsedConfig = z.infer<typeof configSchema>;

export type LocalFactoryExternalPullRequestRepairAdmissionConfig = ParsedConfig & {
  readonly admissionPolicy: FactoryExternalPullRequestRepairAdmissionPolicy;
};

/** Loads the owner-only deterministic external-repair admission configuration. */
export async function loadLocalFactoryExternalPullRequestRepairAdmissionConfig(
  pathInput: string
): Promise<LocalFactoryExternalPullRequestRepairAdmissionConfig> {
  const path = privateLocalFilePath(pathInput, "External PR repair admission config");
  const content = await readPrivateLocalFile(path, {
    label: "External PR repair admission config",
    minimumBytes: 2,
    maximumBytes: 64 * 1_024
  });
  let config: ParsedConfig;
  try {
    config = configSchema.parse(parseJson(content.toString("utf8"), "config"));
  } finally {
    content.fill(0);
  }
  const policyPath = privateLocalFilePath(
    config.admissionPolicyPath,
    "External PR repair admission policy"
  );
  const policyContent = await readPrivateLocalFile(policyPath, {
    label: "External PR repair admission policy",
    minimumBytes: 2,
    maximumBytes: 2 * 1_024 * 1_024
  });
  let admissionPolicy: FactoryExternalPullRequestRepairAdmissionPolicy;
  try {
    admissionPolicy = factoryExternalPullRequestRepairAdmissionPolicySchema.parse(
      parseJson(policyContent.toString("utf8"), "policy")
    );
  } finally {
    policyContent.fill(0);
  }
  if (
    admissionPolicy.repositoryId !== config.repositoryId ||
    encodeCanonicalDocument(admissionPolicy).digest !== config.expectedAdmissionPolicyDigest
  ) {
    throw new Error("External PR repair admission policy changed after owner review.");
  }
  return { ...config, admissionPolicy };
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error(`External PR repair admission ${label} is not valid JSON.`, { cause: error });
  }
}
