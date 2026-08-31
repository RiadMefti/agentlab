import { isAbsolute, resolve } from "node:path";

import {
  factoryIdentifierSchema,
  sha256DigestSchema,
  type FactoryRoleIdentityPolicy
} from "@agentlab/contracts";
import { z } from "zod";

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

const configV1Schema = z
  .object({
    schemaVersion: z.literal("agentlab.local-factory-canary-authority.v1"),
    databasePath: absolutePathSchema,
    operatorId: factoryIdentifierSchema
  })
  .strict();

const configV2Schema = z
  .object({
    schemaVersion: z.literal("agentlab.local-factory-canary-authority.v2"),
    databasePath: absolutePathSchema,
    operatorId: factoryIdentifierSchema,
    runnerId: factoryIdentifierSchema,
    trustedPublicKeyPath: absolutePathSchema,
    trustedKeyId: sha256DigestSchema,
    roleIdentityPolicyPath: absolutePathSchema,
    expectedRoleIdentityPolicyDigest: sha256DigestSchema,
    maximumIssuanceDelaySeconds: z.number().int().min(1).max(86_400),
    maximumAttestationLifetimeSeconds: z.number().int().min(60).max(604_800)
  })
  .strict();

const configSchema = z.discriminatedUnion("schemaVersion", [configV1Schema, configV2Schema]);

export type LocalFactoryCanaryAuthorityConfig =
  | z.infer<typeof configV1Schema>
  | (z.infer<typeof configV2Schema> & {
      readonly roleIdentityPolicy: FactoryRoleIdentityPolicy;
    });

/** Loads the minimal human canary-authority identity and durable ledger target. */
export async function loadLocalFactoryCanaryAuthorityConfig(
  pathInput: string
): Promise<LocalFactoryCanaryAuthorityConfig> {
  const path = privateLocalFilePath(pathInput, "Local factory canary authority config");
  const content = await readPrivateLocalFile(path, {
    label: "Local factory canary authority config",
    minimumBytes: 2,
    maximumBytes: 16 * 1_024
  });
  try {
    const config = configSchema.parse(parseJson(content.toString("utf8")));
    return config.schemaVersion === "agentlab.local-factory-canary-authority.v1"
      ? config
      : {
          ...config,
          roleIdentityPolicy: await loadLocalFactoryRoleIdentityPolicy(
            config.roleIdentityPolicyPath
          )
        };
  } finally {
    content.fill(0);
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error("Local factory canary authority config is not valid JSON.", { cause: error });
  }
}
