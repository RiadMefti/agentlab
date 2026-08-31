import { isAbsolute, resolve } from "node:path";

import { factoryIdentifierSchema, sha256DigestSchema } from "@agentlab/contracts";
import { z } from "zod";

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
    schemaVersion: z.literal("agentlab.local-factory-eval-attestor.v1"),
    runnerId: factoryIdentifierSchema,
    privateKeyPath: absolutePathSchema,
    keyId: sha256DigestSchema,
    attestationLifetimeSeconds: z.number().int().min(60).max(604_800),
    maximumIssuanceDelaySeconds: z.number().int().min(1).max(86_400)
  })
  .strict();

export type LocalFactoryEvalAttestorConfig = z.infer<typeof configSchema>;

/** Loads only runner identity, timing bounds, and an owner-only signing-key coordinate. */
export async function loadLocalFactoryEvalAttestorConfig(
  pathInput: string
): Promise<LocalFactoryEvalAttestorConfig> {
  const path = privateLocalFilePath(pathInput, "Local factory eval attestor config");
  const content = await readPrivateLocalFile(path, {
    label: "Local factory eval attestor config",
    minimumBytes: 2,
    maximumBytes: 16 * 1_024
  });
  try {
    return configSchema.parse(parseJson(content.toString("utf8")));
  } finally {
    content.fill(0);
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error("Local factory eval attestor config is not valid JSON.", { cause: error });
  }
}
