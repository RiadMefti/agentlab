import { isAbsolute, resolve } from "node:path";

import { factoryIdentifierSchema, type FactoryCostPolicy } from "@agentlab/contracts";
import { z } from "zod";

import { loadLocalFactoryCostPolicy } from "./local-factory-cost-policy.js";
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

const configFields = {
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
} as const;

const configV1Schema = z
  .object({ schemaVersion: z.literal("agentlab.local-factory-broker.v1"), ...configFields })
  .strict();
const configV2Schema = z
  .object({
    schemaVersion: z.literal("agentlab.local-factory-broker.v2"),
    ...configFields,
    costPolicyPath: absolutePathSchema
  })
  .strict();
const configSchema = z.discriminatedUnion("schemaVersion", [configV1Schema, configV2Schema]);

export type LocalFactoryBrokerConfigV1 = z.infer<typeof configV1Schema>;
export type LocalFactoryBrokerConfigV2 = z.infer<typeof configV2Schema> & {
  readonly costPolicy: FactoryCostPolicy;
};
export type LocalFactoryBrokerConfig = LocalFactoryBrokerConfigV1 | LocalFactoryBrokerConfigV2;

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
  let config: z.infer<typeof configSchema>;
  try {
    config = configSchema.parse(parseJson(content.toString("utf8")));
  } finally {
    content.fill(0);
  }
  if (config.schemaVersion === "agentlab.local-factory-broker.v1") return config;
  const costPolicy = await loadLocalFactoryCostPolicy(config.costPolicyPath);
  return { ...config, costPolicy };
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error("Local factory broker config is not valid JSON.", { cause: error });
  }
}
