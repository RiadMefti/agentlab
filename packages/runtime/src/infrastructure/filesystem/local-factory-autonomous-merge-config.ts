import { isAbsolute, resolve } from "node:path";

import {
  factoryIdentifierSchema,
  sha256DigestSchema,
  type FactoryAutonomousMergePolicy,
  type FactoryCostPolicy,
  type FactoryDailyQuotaPolicy,
  type FactoryRoleIdentityPolicy,
  type FactorySchedulePolicy,
  type Sha256Digest
} from "@agentlab/contracts";
import { z } from "zod";

import type { CanonicalFactoryDocument } from "../../domain/factory-documents.js";
import {
  createAutonomousR1FactoryPolicyBundle,
  type FactoryPolicyBundleV3
} from "../../domain/factory-policy.js";
import {
  encodeCanonicalDocument,
  NodeFactoryDocumentCodec
} from "../persistence/canonical-factory-documents.js";
import { loadLocalFactoryAutonomousMergePolicy } from "./local-factory-autonomous-merge-policy.js";
import { loadLocalFactoryCostPolicy } from "./local-factory-cost-policy.js";
import { loadLocalFactoryDailyQuotaPolicy } from "./local-factory-daily-quota-policy.js";
import { loadLocalFactoryRoleIdentityPolicy } from "./local-factory-role-identity-policy.js";
import { loadLocalFactorySchedulePolicy } from "./local-factory-schedule-policy.js";
import { privateLocalFilePath, readPrivateLocalFile } from "./private-local-file.js";

const absolutePathSchema = z
  .string()
  .min(1)
  .max(4_096)
  .refine(
    (value) => isAbsolute(value) && !value.includes("\0") && resolve(value) === value,
    "Expected a normalized absolute path."
  );

const commonFields = {
  databasePath: absolutePathSchema,
  artifactRoot: absolutePathSchema,
  repositoryId: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/u),
  costPolicyPath: absolutePathSchema,
  schedulePolicyPath: absolutePathSchema,
  dailyQuotaPolicyPath: absolutePathSchema,
  roleIdentityPolicyPath: absolutePathSchema,
  mergePolicyPath: absolutePathSchema,
  expectedFactoryPolicyBundleDigest: sha256DigestSchema,
  expectedSchedulePolicyDigest: sha256DigestSchema,
  expectedDailyQuotaPolicyDigest: sha256DigestSchema,
  expectedRoleIdentityPolicyDigest: sha256DigestSchema,
  expectedMergePolicyDigest: sha256DigestSchema
} as const;

export interface LocalFactoryAutonomousMergePolicyCoordinates {
  readonly repositoryId: string;
  readonly costPolicyPath: string;
  readonly schedulePolicyPath: string;
  readonly dailyQuotaPolicyPath: string;
  readonly roleIdentityPolicyPath: string;
  readonly mergePolicyPath: string;
  readonly expectedFactoryPolicyBundleDigest: Sha256Digest;
  readonly expectedSchedulePolicyDigest: Sha256Digest;
  readonly expectedDailyQuotaPolicyDigest: Sha256Digest;
  readonly expectedRoleIdentityPolicyDigest: Sha256Digest;
  readonly expectedMergePolicyDigest: Sha256Digest;
}

const admissionConfigSchema = z
  .object({
    schemaVersion: z.literal("agentlab.local-factory-autonomous-merge-admission.v1"),
    ...commonFields,
    admissionUserId: z.number().int().min(1).max(4_294_967_294)
  })
  .strict();

const mergerConfigSchema = z
  .object({
    schemaVersion: z.literal("agentlab.local-factory-autonomous-merger.v1"),
    ...commonFields,
    repositoryNumericId: z.number().int().positive().refine(Number.isSafeInteger),
    mergerId: factoryIdentifierSchema,
    githubApp: z
      .object({
        clientId: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/u),
        installationId: z.number().int().positive().refine(Number.isSafeInteger),
        privateKeyPath: absolutePathSchema
      })
      .strict()
  })
  .strict();

export interface LoadedLocalFactoryAutonomousMergePolicies {
  readonly costPolicy: FactoryCostPolicy;
  readonly schedulePolicy: FactorySchedulePolicy;
  readonly dailyQuotaPolicy: FactoryDailyQuotaPolicy;
  readonly roleIdentityPolicy: FactoryRoleIdentityPolicy;
  readonly mergePolicy: CanonicalFactoryDocument<FactoryAutonomousMergePolicy>;
  readonly factoryPolicyBundle: CanonicalFactoryDocument<FactoryPolicyBundleV3>;
}

export type LocalFactoryAutonomousMergeAdmissionConfig = z.infer<typeof admissionConfigSchema> &
  LoadedLocalFactoryAutonomousMergePolicies;

export type LocalFactoryAutonomousMergerConfig = z.infer<typeof mergerConfigSchema> &
  LoadedLocalFactoryAutonomousMergePolicies;

export async function loadLocalFactoryAutonomousMergeAdmissionConfig(
  pathInput: string
): Promise<LocalFactoryAutonomousMergeAdmissionConfig> {
  const config = await loadConfig(pathInput, admissionConfigSchema, "admission");
  const policies = await loadLocalFactoryAutonomousMergePolicies(config);
  if (config.admissionUserId !== policies.roleIdentityPolicy.worker.userId) {
    throw new Error("Autonomous merge admission must use the reviewed worker POSIX identity.");
  }
  return { ...config, ...policies };
}

export async function loadLocalFactoryAutonomousMergerConfig(
  pathInput: string
): Promise<LocalFactoryAutonomousMergerConfig> {
  const config = await loadConfig(pathInput, mergerConfigSchema, "merger");
  const policies = await loadLocalFactoryAutonomousMergePolicies(config);
  if (
    config.mergerId !== policies.mergePolicy.value.mergerId ||
    policies.mergePolicy.value.mergerUserId === policies.mergePolicy.value.prBrokerUserId
  ) {
    throw new Error("Autonomous merger identity changed after policy review.");
  }
  return { ...config, ...policies };
}

export async function loadLocalFactoryAutonomousMergePolicies(
  config: LocalFactoryAutonomousMergePolicyCoordinates
): Promise<LoadedLocalFactoryAutonomousMergePolicies> {
  const documents = new NodeFactoryDocumentCodec();
  const [costPolicy, schedulePolicy, dailyQuotaPolicy, roleIdentityPolicy, mergePolicy] =
    await Promise.all([
      loadLocalFactoryCostPolicy(config.costPolicyPath),
      loadLocalFactorySchedulePolicy(config.schedulePolicyPath),
      loadLocalFactoryDailyQuotaPolicy(config.dailyQuotaPolicyPath),
      loadLocalFactoryRoleIdentityPolicy(config.roleIdentityPolicyPath),
      loadLocalFactoryAutonomousMergePolicy(config.mergePolicyPath, documents)
    ]);
  const schedule = documents.schedulePolicy(schedulePolicy);
  const dailyQuota = documents.dailyQuotaPolicy(dailyQuotaPolicy);
  const roles = documents.roleIdentityPolicy(roleIdentityPolicy);
  const factoryPolicyBundle = encodeCanonicalDocument(
    createAutonomousR1FactoryPolicyBundle({ costPolicy, mergePolicy })
  );
  const mismatches: readonly [Sha256Digest, Sha256Digest, string][] = [
    [schedule.digest, config.expectedSchedulePolicyDigest, "schedule"],
    [dailyQuota.digest, config.expectedDailyQuotaPolicyDigest, "daily quota"],
    [roles.digest, config.expectedRoleIdentityPolicyDigest, "role identity"],
    [mergePolicy.digest, config.expectedMergePolicyDigest, "merge"],
    [factoryPolicyBundle.digest, config.expectedFactoryPolicyBundleDigest, "factory policy bundle"]
  ];
  const mismatch = mismatches.find(([actual, expected]) => actual !== expected);
  if (mismatch !== undefined) {
    throw new Error(`Autonomous merge ${mismatch[2]} policy changed after review.`);
  }
  if (
    mergePolicy.value.repositoryId !== config.repositoryId ||
    mergePolicy.value.schedulePolicyDigest !== schedule.digest ||
    mergePolicy.value.dailyQuotaPolicyDigest !== dailyQuota.digest ||
    mergePolicy.value.roleIdentityPolicyDigest !== roles.digest ||
    mergePolicy.value.mergerUserId === roles.value.worker.userId ||
    mergePolicy.value.mergerUserId === roles.value.evalAttestor.userId ||
    mergePolicy.value.prBrokerUserId === roles.value.worker.userId ||
    mergePolicy.value.prBrokerUserId === roles.value.evalAttestor.userId ||
    !dailyQuota.value.repositories.some(({ repositoryId }) => repositoryId === config.repositoryId)
  ) {
    throw new Error("Autonomous merge policy coordinates or role separation are invalid.");
  }
  return {
    costPolicy,
    schedulePolicy,
    dailyQuotaPolicy,
    roleIdentityPolicy,
    mergePolicy,
    factoryPolicyBundle
  };
}

async function loadConfig<Schema extends z.ZodType>(
  pathInput: string,
  schema: Schema,
  label: string
): Promise<z.output<Schema>> {
  const path = privateLocalFilePath(pathInput, `Local factory autonomous merge ${label} config`);
  const content = await readPrivateLocalFile(path, {
    label: `Local factory autonomous merge ${label} config`,
    minimumBytes: 2,
    maximumBytes: 128 * 1_024
  });
  try {
    return schema.parse(parseJson(content.toString("utf8")));
  } finally {
    content.fill(0);
  }
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error("Local autonomous merge config is not valid JSON.", { cause: error });
  }
}
