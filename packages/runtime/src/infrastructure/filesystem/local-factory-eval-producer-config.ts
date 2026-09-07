import { isAbsolute, parse, resolve } from "node:path";

import { factoryIdentifierSchema, sha256DigestSchema } from "@agentlab/contracts";
import { z } from "zod";

import type { FactoryEvalExecutableBinding } from "../../domain/factory-eval-harness.js";
import { factoryPathsOverlap } from "./factory-workspace-paths.js";
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
const executableBindingSchema = z
  .object({
    descriptorDigest: sha256DigestSchema,
    executable: absolutePathSchema,
    executableDigest: sha256DigestSchema,
    version: versionSchema
  })
  .strict();

const configSchema = z
  .object({
    schemaVersion: z.literal("agentlab.local-factory-eval-producer.v1"),
    databasePath: absolutePathSchema,
    artifactRoot: nonRootAbsolutePathSchema,
    workspaceRoot: nonRootAbsolutePathSchema,
    runnerId: factoryIdentifierSchema,
    executables: z.array(executableBindingSchema).min(2).max(32),
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
      .strict()
  })
  .strict()
  .superRefine((config, context) => {
    unique(
      config.executables.map(({ descriptorDigest }) => descriptorDigest),
      context,
      ["executables"],
      "descriptor digests"
    );
    unique(
      config.sandbox.runtimeRoots,
      context,
      ["sandbox", "runtimeRoots"],
      "sandbox runtime roots"
    );
    if (
      factoryPathsOverlap(config.artifactRoot, config.workspaceRoot) ||
      factoryPathsOverlap(config.databasePath, config.artifactRoot) ||
      factoryPathsOverlap(config.databasePath, config.workspaceRoot) ||
      config.sandbox.runtimeRoots.some(
        (root) =>
          factoryPathsOverlap(root, config.databasePath) ||
          factoryPathsOverlap(root, config.artifactRoot) ||
          factoryPathsOverlap(root, config.workspaceRoot)
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["workspaceRoot"],
        message: "Eval artifact, database, sandbox-workspace, and runtime paths must not overlap."
      });
    }
  });

export type LocalFactoryEvalProducerConfig = z.infer<typeof configSchema> & {
  readonly executables: readonly FactoryEvalExecutableBinding[];
};

/** Loads only reviewed local eval runner, sandbox, storage, and executable bindings. */
export async function loadLocalFactoryEvalProducerConfig(
  pathInput: string
): Promise<LocalFactoryEvalProducerConfig> {
  const path = privateLocalFilePath(pathInput, "Local factory eval producer config");
  const content = await readPrivateLocalFile(path, {
    label: "Local factory eval producer config",
    minimumBytes: 2,
    maximumBytes: 128 * 1_024
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
    throw new Error("Local factory eval producer config is not valid JSON.", { cause: error });
  }
}

function unique(
  values: readonly string[],
  context: z.RefinementCtx,
  path: PropertyKey[],
  label: string
): void {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: "custom", path, message: `Factory eval ${label} must be unique.` });
  }
}
