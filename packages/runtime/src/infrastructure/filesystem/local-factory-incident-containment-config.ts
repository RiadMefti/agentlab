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
    schemaVersion: z.literal("agentlab.local-factory-incident-containment.v1"),
    databasePath: absolutePathSchema,
    controllerId: factoryIdentifierSchema,
    controllerUserId: z.number().int().min(1).max(4_294_967_294),
    healthPolicyPath: absolutePathSchema,
    expectedHealthPolicyDigest: sha256DigestSchema,
    dailyQuotaPolicyPath: absolutePathSchema,
    expectedDailyQuotaPolicyDigest: sha256DigestSchema
  })
  .strict();

export type LocalFactoryIncidentContainmentConfig = z.infer<typeof configSchema> & {
  readonly healthPolicy: FactoryOperationsHealthPolicy;
  readonly dailyQuotaPolicy: FactoryDailyQuotaPolicy;
};

/** Loads owner-only local policy without credentials or any enable-authority input. */
export async function loadLocalFactoryIncidentContainmentConfig(
  pathInput: string
): Promise<LocalFactoryIncidentContainmentConfig> {
  const path = privateLocalFilePath(pathInput, "Local factory incident containment config");
  const content = await readPrivateLocalFile(path, {
    label: "Local factory incident containment config",
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
    throw new Error("Factory incident health policy changed after review.");
  }
  if (encodeCanonicalDocument(dailyQuotaPolicy).digest !== config.expectedDailyQuotaPolicyDigest) {
    throw new Error("Factory incident daily quota policy changed after review.");
  }
  return { ...config, healthPolicy, dailyQuotaPolicy };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error("Local factory incident containment config is not valid JSON.", {
      cause: error
    });
  }
}
