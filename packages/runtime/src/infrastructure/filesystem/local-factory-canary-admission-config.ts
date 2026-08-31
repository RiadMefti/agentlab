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

const configSchema = z
  .object({
    schemaVersion: z.literal("agentlab.local-factory-canary-admission.v1"),
    databasePath: absolutePathSchema,
    runnerId: factoryIdentifierSchema,
    trustedPublicKeyPath: absolutePathSchema,
    trustedKeyId: sha256DigestSchema,
    roleIdentityPolicyPath: absolutePathSchema,
    expectedRoleIdentityPolicyDigest: sha256DigestSchema,
    expectedCohortDigest: sha256DigestSchema,
    expectedCandidateDigest: sha256DigestSchema,
    expectedSchedulePolicyDigest: sha256DigestSchema,
    expectedPolicyBundleDigest: sha256DigestSchema,
    maximumIssuanceDelaySeconds: z.number().int().min(1).max(86_400),
    maximumAttestationLifetimeSeconds: z.number().int().min(60).max(604_800)
  })
  .strict();

export type LocalFactoryCanaryAdmissionConfig = z.infer<typeof configSchema> & {
  readonly roleIdentityPolicy: FactoryRoleIdentityPolicy;
};

/** Loads only immutable trust and configuration pins for credentialless canary admission. */
export async function loadLocalFactoryCanaryAdmissionConfig(
  pathInput: string
): Promise<LocalFactoryCanaryAdmissionConfig> {
  const path = privateLocalFilePath(pathInput, "Local factory canary admission config");
  const content = await readPrivateLocalFile(path, {
    label: "Local factory canary admission config",
    minimumBytes: 2,
    maximumBytes: 32 * 1_024
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
    throw new Error("Local factory canary admission config is not valid JSON.", {
      cause: error
    });
  }
}
