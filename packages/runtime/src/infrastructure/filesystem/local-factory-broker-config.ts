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

const trustedStatusCheckSchema = z
  .object({
    context: z.enum(["verify", "factory-sandbox"]),
    appId: z.number().int().positive().refine(Number.isSafeInteger)
  })
  .strict();

const trustedStatusChecksSchema = z
  .array(trustedStatusCheckSchema)
  .length(2)
  .superRefine((checks, context) => {
    const names = new Set(checks.map((check) => check.context));
    if (!names.has("verify") || !names.has("factory-sandbox")) {
      context.addIssue({
        code: "custom",
        message: "Trusted status checks must bind verify and factory-sandbox exactly once."
      });
    }
  });

const configSchema = z
  .object({
    schemaVersion: z.literal("agentlab.local-factory-broker.v1"),
    databasePath: absolutePathSchema,
    artifactRoot: absolutePathSchema,
    temporaryRoot: absolutePathSchema,
    repositoryId: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/u),
    repositoryNumericId: z.number().int().positive().refine(Number.isSafeInteger),
    brokerId: factoryIdentifierSchema,
    gitExecutable: absolutePathSchema,
    githubApp: z
      .object({
        clientId: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/u),
        installationId: z.number().int().positive().refine(Number.isSafeInteger),
        privateKeyPath: absolutePathSchema,
        trustedStatusChecks: trustedStatusChecksSchema
      })
      .strict()
  })
  .strict();

export type LocalFactoryBrokerConfig = z.infer<typeof configSchema>;

/** Loads a strict owner-only broker configuration; the referenced key is not read here. */
export async function loadLocalFactoryBrokerConfig(
  pathInput: string
): Promise<LocalFactoryBrokerConfig> {
  const path = privateLocalFilePath(pathInput, "Local factory broker config");
  const content = await readPrivateLocalFile(path, {
    label: "Local factory broker config",
    minimumBytes: 2,
    maximumBytes: 64 * 1_024
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
    throw new Error("Local factory broker config is not valid JSON.", { cause: error });
  }
}
