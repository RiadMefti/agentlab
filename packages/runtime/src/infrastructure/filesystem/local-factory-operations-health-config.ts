import { isAbsolute, resolve } from "node:path";

import {
  factoryIdentifierSchema,
  sha256DigestSchema,
  type FactoryDailyQuotaPolicy,
  type FactoryOperationsHealthPolicy
} from "@agentlab/contracts";
import { z } from "zod";

import { encodeCanonicalDocument } from "../persistence/canonical-factory-documents.js";
import { loadLocalFactoryDailyQuotaPolicy } from "./local-factory-daily-quota-policy.js";
import { loadLocalFactoryOperationsHealthPolicy } from "./local-factory-operations-health-policy.js";
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
    schemaVersion: z.literal("agentlab.local-factory-operations-health.v1"),
    databasePath: absolutePathSchema,
    observerId: factoryIdentifierSchema,
    healthPolicyPath: absolutePathSchema,
    expectedHealthPolicyDigest: sha256DigestSchema,
    dailyQuotaPolicyPath: absolutePathSchema,
    expectedDailyQuotaPolicyDigest: sha256DigestSchema
  })
  .strict();

export type LocalFactoryOperationsHealthConfig = z.infer<typeof configSchema> & {
  readonly healthPolicy: FactoryOperationsHealthPolicy;
  readonly dailyQuotaPolicy: FactoryDailyQuotaPolicy;
};

/** Loads only owner-reviewed policy and a ledger path; it has no credential or mutation field. */
export async function loadLocalFactoryOperationsHealthConfig(
  pathInput: string
): Promise<LocalFactoryOperationsHealthConfig> {
  const path = privateLocalFilePath(pathInput, "Local factory operations health config");
  const content = await readPrivateLocalFile(path, {
    label: "Local factory operations health config",
    minimumBytes: 2,
    maximumBytes: 32 * 1_024
  });
  let config: z.infer<typeof configSchema>;
  try {
    config = configSchema.parse(parseJson(content.toString("utf8")));
  } finally {
    content.fill(0);
  }
  const [healthPolicy, dailyQuotaPolicy] = await Promise.all([
    loadLocalFactoryOperationsHealthPolicy(config.healthPolicyPath),
    loadLocalFactoryDailyQuotaPolicy(config.dailyQuotaPolicyPath)
  ]);
  if (encodeCanonicalDocument(healthPolicy).digest !== config.expectedHealthPolicyDigest) {
    throw new Error("Factory operations health policy changed after review.");
  }
  if (encodeCanonicalDocument(dailyQuotaPolicy).digest !== config.expectedDailyQuotaPolicyDigest) {
    throw new Error("Factory operations daily quota policy changed after review.");
  }
  return { ...config, healthPolicy, dailyQuotaPolicy };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error("Local factory operations health config is not valid JSON.", { cause: error });
  }
}
