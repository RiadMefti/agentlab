import { isAbsolute, parse, resolve } from "node:path";

import { sha256DigestSchema, type FactoryCostPolicy } from "@agentlab/contracts";
import { z } from "zod";

import type { FactoryGateDefinition } from "../../domain/factory-gate.js";
import type { FactoryAgentProviderBinding } from "../providers/pinned-factory-agent-provider-resolver.js";
import { factoryPathsOverlap } from "./factory-workspace-paths.js";
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
const nonRootAbsolutePathSchema = absolutePathSchema.refine(
  (value) => value !== parse(value).root,
  "Expected a dedicated non-root path."
);
const versionSchema = z
  .string()
  .trim()
  .min(1)
  .max(180)
  .refine((value) => !/[\0\r\n]/u.test(value));
const providerBindingSchema = z
  .object({
    provider: z.enum(["codex", "claude"]),
    executable: absolutePathSchema,
    executableDigest: sha256DigestSchema,
    version: versionSchema
  })
  .strict();
const commandSchema = z
  .object({
    executable: absolutePathSchema,
    args: z
      .array(
        z
          .string()
          .max(4_096)
          .refine((value) => !value.includes("\0"))
      )
      .max(128)
  })
  .strict();
const gateDefinitionSchema = z
  .object({
    id: z.enum(["format", "architecture", "typecheck", "lint", "test", "build", "secret-scan"]),
    evidenceKind: z.enum(["test", "build", "security", "provenance"]),
    command: commandSchema,
    timeoutMs: z.number().int().min(1).max(3_600_000),
    maximumOutputBytes: z.number().int().min(1).max(1_073_741_824)
  })
  .strict();
const configSchema = z
  .object({
    schemaVersion: z.literal("agentlab.local-factory-worker.v1"),
    databasePath: absolutePathSchema,
    artifactRoot: nonRootAbsolutePathSchema,
    workspaceRoot: nonRootAbsolutePathSchema,
    costPolicyPath: absolutePathSchema,
    gitExecutable: absolutePathSchema,
    flockExecutable: absolutePathSchema,
    systemd: z
      .object({
        runExecutable: absolutePathSchema,
        controlExecutable: absolutePathSchema,
        environmentExecutable: absolutePathSchema,
        version: versionSchema
      })
      .strict(),
    sandbox: z
      .object({
        bubblewrapExecutable: absolutePathSchema,
        runtimeRoots: z.array(nonRootAbsolutePathSchema).max(8)
      })
      .strict(),
    providers: z.array(providerBindingSchema).min(1).max(2),
    gates: z.array(gateDefinitionSchema).length(7)
  })
  .strict()
  .superRefine((config, context) => {
    uniqueBy(config.providers, ({ provider }) => provider, context, ["providers"], "provider IDs");
    uniqueBy(config.gates, ({ id }) => id, context, ["gates"], "gate IDs");
    uniqueBy(
      config.sandbox.runtimeRoots,
      (value) => value,
      context,
      ["sandbox", "runtimeRoots"],
      "runtime roots"
    );
    if (factoryPathsOverlap(config.artifactRoot, config.workspaceRoot)) {
      context.addIssue({
        code: "custom",
        path: ["workspaceRoot"],
        message: "Factory artifact and worktree roots must not overlap."
      });
    }
    for (const gate of config.gates) {
      if (gate.evidenceKind !== requiredGateEvidence[gate.id]) {
        context.addIssue({
          code: "custom",
          path: ["gates"],
          message: `Factory gate ${gate.id} has the wrong evidence kind.`
        });
      }
    }
  });

const requiredGateEvidence = {
  format: "test",
  architecture: "test",
  typecheck: "test",
  lint: "test",
  test: "test",
  build: "build",
  "secret-scan": "security"
} as const;

type ParsedLocalFactoryWorkerConfig = z.infer<typeof configSchema>;
export type LocalFactoryWorkerConfig = ParsedLocalFactoryWorkerConfig & {
  readonly costPolicy: FactoryCostPolicy;
  readonly providers: readonly FactoryAgentProviderBinding[];
  readonly gates: readonly FactoryGateDefinition[];
};

/** Loads strict owner-only worker configuration and its separately reviewed cost policy. */
export async function loadLocalFactoryWorkerConfig(
  pathInput: string
): Promise<LocalFactoryWorkerConfig> {
  const path = privateLocalFilePath(pathInput, "Local factory worker config");
  const content = await readPrivateLocalFile(path, {
    label: "Local factory worker config",
    minimumBytes: 2,
    maximumBytes: 256 * 1_024
  });
  let config: ParsedLocalFactoryWorkerConfig;
  try {
    config = configSchema.parse(parseJson(content.toString("utf8")));
  } finally {
    content.fill(0);
  }
  const costPolicy = await loadLocalFactoryCostPolicy(config.costPolicyPath);
  return { ...config, costPolicy };
}

function uniqueBy<Value>(
  values: readonly Value[],
  key: (value: Value) => string,
  context: z.RefinementCtx,
  path: PropertyKey[],
  label: string
): void {
  if (new Set(values.map(key)).size !== values.length) {
    context.addIssue({ code: "custom", path, message: `Factory worker ${label} must be unique.` });
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error("Local factory worker config is not valid JSON.", { cause: error });
  }
}
