import { isAbsolute, resolve } from "node:path";

import {
  factoryIdentifierSchema,
  sha256DigestSchema,
  type FactoryRoleIdentityPolicy
} from "@agentlab/contracts";
import { z } from "zod";

import { privateLocalFilePath, readPrivateLocalFile } from "./private-local-file.js";
import { loadLocalFactoryRoleIdentityPolicy } from "./local-factory-role-identity-policy.js";

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
    schemaVersion: z.literal("agentlab.local-factory-evaluator.v2"),
    databasePath: absolutePathSchema,
    runnerId: factoryIdentifierSchema,
    trustedPublicKeyPath: absolutePathSchema,
    trustedKeyId: sha256DigestSchema,
    roleIdentityPolicyPath: absolutePathSchema,
    expectedRoleIdentityPolicyDigest: sha256DigestSchema,
    maximumIssuanceDelaySeconds: z.number().int().min(1).max(86_400),
    maximumAttestationLifetimeSeconds: z.number().int().min(60).max(604_800)
  })
  .strict();

type ParsedLocalFactoryEvaluatorConfig = z.infer<typeof configSchema>;
export type LocalFactoryEvaluatorConfig = ParsedLocalFactoryEvaluatorConfig & {
  readonly roleIdentityPolicy: FactoryRoleIdentityPolicy;
};

/** Loads the durable ledger, evaluator identity, and one pinned public verification key. */
export async function loadLocalFactoryEvaluatorConfig(
  pathInput: string
): Promise<LocalFactoryEvaluatorConfig> {
  const path = privateLocalFilePath(pathInput, "Local factory evaluator config");
  const content = await readPrivateLocalFile(path, {
    label: "Local factory evaluator config",
    minimumBytes: 2,
    maximumBytes: 16 * 1_024
  });
  try {
    const config = configSchema.parse(parseJson(content.toString("utf8")));
    return {
      ...config,
      roleIdentityPolicy: await loadLocalFactoryRoleIdentityPolicy(config.roleIdentityPolicyPath)
    };
  } finally {
    content.fill(0);
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error("Local factory evaluator config is not valid JSON.", { cause: error });
  }
}
