import { isAbsolute, resolve } from "node:path";

import { factoryIdentifierSchema } from "@agentlab/contracts";
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
    schemaVersion: z.literal("agentlab.local-factory-canary-authority.v1"),
    databasePath: absolutePathSchema,
    operatorId: factoryIdentifierSchema
  })
  .strict();

export type LocalFactoryCanaryAuthorityConfig = z.infer<typeof configSchema>;

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
    return configSchema.parse(parseJson(content.toString("utf8")));
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
