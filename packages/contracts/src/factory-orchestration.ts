import { z } from "zod";

import { factorySemanticVersionSchema, sha256DigestSchema } from "./factory.js";

const unitSafeTextSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(
    (value) =>
      !Array.from(value).some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 0x1f || codePoint === 0x7f;
      }),
    "System service values cannot contain ASCII control characters."
  );

const orchestrationRoleSchema = z
  .object({
    userId: z.number().int().min(1).max(4_294_967_294),
    configPath: unitSafeTextSchema
  })
  .strict();

const verifierSafeAbsolutePathSchema = unitSafeTextSchema.regex(
  /^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/u,
  "Executable verification paths must use simple absolute POSIX segments."
);

const factoryDailyCycleManifestBaseSchema = z
  .object({
    id: z.literal("agentlab/daily-software-factory"),
    version: factorySemanticVersionSchema,
    agentlabExecutable: z
      .object({
        path: verifierSafeAbsolutePathSchema,
        digest: sha256DigestSchema
      })
      .strict(),
    executableChecksumPath: z.literal("/etc/agentlab/factory-executable.sha256"),
    worker: orchestrationRoleSchema,
    broker: orchestrationRoleSchema,
    schedulePolicyPath: unitSafeTextSchema,
    roleIdentityPolicyPath: unitSafeTextSchema,
    expectedSchedulePolicyDigest: sha256DigestSchema,
    expectedRoleIdentityPolicyDigest: sha256DigestSchema,
    expectedFactoryPolicyBundleDigest: sha256DigestSchema,
    maximumRepairRounds: z.number().int().min(0).max(20),
    workerCommandTimeoutSeconds: z.number().int().min(60).max(90_000),
    brokerCommandTimeoutSeconds: z.number().int().min(60).max(7_200)
  })
  .strict();

/** Reviewed, command-free inputs for rendering one dormant daily systemd cycle. */
export const factoryDailyCycleManifestSchema = z
  .discriminatedUnion("schemaVersion", [
    factoryDailyCycleManifestBaseSchema.extend({
      schemaVersion: z.literal("agentlab.daily-cycle-manifest.v1")
    }),
    factoryDailyCycleManifestBaseSchema.extend({
      schemaVersion: z.literal("agentlab.daily-cycle-manifest.v2"),
      maintenanceDiscoveryConfigPath: unitSafeTextSchema,
      canaryAdmissionConfigPath: unitSafeTextSchema,
      expectedMaintenanceDiscoveryPolicyDigest: sha256DigestSchema,
      expectedPreparationGrantDigest: sha256DigestSchema,
      expectedCanaryCohortDigest: sha256DigestSchema,
      expectedCanaryCandidateDigest: sha256DigestSchema
    })
  ])
  .superRefine((manifest, context) => {
    if (manifest.worker.userId === manifest.broker.userId) {
      context.addIssue({
        code: "custom",
        path: ["broker", "userId"],
        message: "Factory worker and broker must use different operating-system identities."
      });
    }
    if (manifest.worker.configPath === manifest.broker.configPath) {
      context.addIssue({
        code: "custom",
        path: ["broker", "configPath"],
        message: "Factory worker and broker must use different configuration files."
      });
    }
    if (
      manifest.schemaVersion === "agentlab.daily-cycle-manifest.v2" &&
      new Set([
        manifest.worker.configPath,
        manifest.broker.configPath,
        manifest.maintenanceDiscoveryConfigPath,
        manifest.canaryAdmissionConfigPath
      ]).size !== 4
    ) {
      context.addIssue({
        code: "custom",
        path: ["maintenanceDiscoveryConfigPath"],
        message: "Every daily-cycle capability must use a separate configuration file."
      });
    }
  });
export type FactoryDailyCycleManifest = z.infer<typeof factoryDailyCycleManifestSchema>;

export const factoryDailyCycleUnitSchema = z
  .object({
    name: z.string().regex(/^agentlab-factory-[a-z0-9-]+\.(?:service|target|timer)$/u),
    kind: z.enum(["service", "target", "timer"]),
    content: z
      .string()
      .min(1)
      .max(256 * 1_024),
    digest: sha256DigestSchema
  })
  .strict();
export type FactoryDailyCycleUnit = z.infer<typeof factoryDailyCycleUnitSchema>;

const factoryDailyCycleBundleBaseSchema = z
  .object({
    manifestDigest: sha256DigestSchema,
    schedulePolicyDigest: sha256DigestSchema,
    roleIdentityPolicyDigest: sha256DigestSchema,
    factoryPolicyBundleDigest: sha256DigestSchema,
    agentlabExecutableDigest: sha256DigestSchema,
    executableVerification: z
      .object({
        verifierPath: z.literal("/usr/bin/sha256sum"),
        checksumFilePath: z.literal("/etc/agentlab/factory-executable.sha256"),
        checksumContent: z.string().regex(/^[0-9a-f]{64} {2}\/[A-Za-z0-9._/-]+\n$/u),
        checksumDigest: sha256DigestSchema
      })
      .strict(),
    timerUnit: z.literal("agentlab-factory-daily.timer"),
    units: z.array(factoryDailyCycleUnitSchema).min(4).max(68),
    bundleDigest: sha256DigestSchema
  })
  .strict();

/** Content-addressed output; emitting it neither installs nor activates system services. */
export const factoryDailyCycleBundleSchema = z.discriminatedUnion("schemaVersion", [
  factoryDailyCycleBundleBaseSchema.extend({
    schemaVersion: z.literal("agentlab.daily-cycle-bundle.v1")
  }),
  factoryDailyCycleBundleBaseSchema.extend({
    schemaVersion: z.literal("agentlab.daily-cycle-bundle.v2"),
    maintenanceDiscoveryPolicyDigest: sha256DigestSchema,
    preparationGrantDigest: sha256DigestSchema,
    canaryCohortDigest: sha256DigestSchema,
    canaryCandidateDigest: sha256DigestSchema
  })
]);
export type FactoryDailyCycleBundle = z.infer<typeof factoryDailyCycleBundleSchema>;
