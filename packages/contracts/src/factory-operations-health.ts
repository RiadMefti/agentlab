import { z } from "zod";

import {
  factoryIdentifierSchema,
  factorySemanticVersionSchema,
  factoryTimestampSchema,
  sha256DigestSchema
} from "./factory.js";

const countSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const utilizationSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const factoryOperationsHealthPolicySchema = z
  .object({
    schemaVersion: z.literal("agentlab.operations-health-policy.v1"),
    id: z.literal("agentlab/operations-health"),
    version: factorySemanticVersionSchema,
    lookbackSeconds: z.number().int().min(300).max(604_800),
    maximumScheduleOverrunSeconds: z.number().int().min(0).max(86_400),
    maximumInFlightSilenceSeconds: z.number().int().min(300).max(86_400),
    quotaWarningBasisPoints: z.number().int().min(1).max(9_999),
    maximumRecordsPerSection: z.number().int().min(10).max(10_000)
  })
  .strict();
export type FactoryOperationsHealthPolicy = z.infer<typeof factoryOperationsHealthPolicySchema>;

export const factoryOperationsHealthReasonCodeSchema = z.enum([
  "observation-truncated",
  "multiple-open-schedule-runs",
  "overdue-schedule-run",
  "overdue-autonomous-task",
  "stalled-autonomous-task",
  "recent-quarantined-task",
  "recent-failed-task",
  "recent-needs-attention-task",
  "daily-quota-warning",
  "daily-quota-capacity-violated"
]);
export type FactoryOperationsHealthReasonCode = z.infer<
  typeof factoryOperationsHealthReasonCodeSchema
>;

const authoritySummarySchema = z
  .object({
    schedulerEnabled: z.boolean(),
    prBrokerEnabled: z.boolean(),
    autonomousDraftsEnabled: z.boolean(),
    /** Absent only on health reports produced before autonomous merge authority existed. */
    mergeBrokerEnabled: z.boolean().optional(),
    /** Absent only on health reports produced before autonomous merge authority existed. */
    autonomousMergesEnabled: z.boolean().optional()
  })
  .strict();

const scheduleSummarySchema = z
  .object({
    observed: countSchema,
    completed: countSchema,
    open: countSchema,
    overdue: countSchema,
    oldestOpenAgeSeconds: countSchema.nullable(),
    latestScheduledFor: factoryTimestampSchema.nullable(),
    openRunIds: z.array(z.uuid()).max(10_000),
    overdueRunIds: z.array(z.uuid()).max(10_000)
  })
  .strict();

const taskSummarySchema = z
  .object({
    observed: countSchema,
    active: countSchema,
    completed: countSchema,
    needsAttention: countSchema,
    failed: countSchema,
    quarantined: countSchema,
    otherTerminal: countSchema,
    overdue: countSchema,
    stalled: countSchema,
    attentionTaskIds: z.array(z.uuid()).max(10_000)
  })
  .strict();

const quotaUsageSchema = z
  .object({
    tasksReserved: countSchema,
    draftPullRequestsReserved: countSchema,
    costMicrousdReserved: countSchema,
    taskUtilizationBasisPoints: utilizationSchema,
    draftPullRequestUtilizationBasisPoints: utilizationSchema,
    maximumBudgetUtilizationBasisPoints: utilizationSchema
  })
  .strict();

const repositoryQuotaUsageSchema = quotaUsageSchema
  .extend({ repositoryId: factoryIdentifierSchema })
  .strict();

const dailyQuotaSummarySchema = z
  .object({
    organizationId: factoryIdentifierSchema,
    windowStart: factoryTimestampSchema,
    windowEnd: factoryTimestampSchema,
    organization: quotaUsageSchema,
    repositories: z.array(repositoryQuotaUsageSchema).min(1).max(256)
  })
  .strict();

/** Content-addressable, read-only operational projection over the durable factory ledger. */
export const factoryOperationsHealthReportSchema = z
  .object({
    schemaVersion: z.literal("agentlab.operations-health-report.v1"),
    reportId: z.uuid(),
    observerId: factoryIdentifierSchema,
    healthPolicyDigest: sha256DigestSchema,
    dailyQuotaPolicyDigest: sha256DigestSchema,
    observedAt: factoryTimestampSchema,
    lookbackStartedAt: factoryTimestampSchema,
    authority: authoritySummarySchema,
    schedules: scheduleSummarySchema,
    tasks: taskSummarySchema,
    dailyQuota: dailyQuotaSummarySchema,
    status: z.enum(["healthy", "degraded", "critical"]),
    incidentRecommended: z.boolean(),
    reasonCodes: z.array(factoryOperationsHealthReasonCodeSchema).max(10)
  })
  .strict()
  .superRefine((report, context) => {
    if (report.lookbackStartedAt > report.observedAt) {
      context.addIssue({
        code: "custom",
        path: ["lookbackStartedAt"],
        message: "Operations health lookback must not begin after observation."
      });
    }
    if (
      report.observedAt < report.dailyQuota.windowStart ||
      report.observedAt >= report.dailyQuota.windowEnd
    ) {
      context.addIssue({
        code: "custom",
        path: ["dailyQuota"],
        message: "Operations health quota window must contain the observation timestamp."
      });
    }
    if (new Set(report.reasonCodes).size !== report.reasonCodes.length) {
      context.addIssue({
        code: "custom",
        path: ["reasonCodes"],
        message: "Operations health reason codes must be unique."
      });
    }
    if (report.incidentRecommended !== (report.status === "critical")) {
      context.addIssue({
        code: "custom",
        path: ["incidentRecommended"],
        message: "Only critical operations health reports recommend incident containment."
      });
    }
    if (
      report.authority.autonomousDraftsEnabled !==
      (report.authority.schedulerEnabled && report.authority.prBrokerEnabled)
    ) {
      context.addIssue({
        code: "custom",
        path: ["authority", "autonomousDraftsEnabled"],
        message: "Autonomous draft authority must be the scheduler and PR-broker conjunction."
      });
    }
    if (
      report.authority.autonomousMergesEnabled !== undefined &&
      report.authority.autonomousMergesEnabled !==
        (report.authority.schedulerEnabled &&
          report.authority.prBrokerEnabled &&
          (report.authority.mergeBrokerEnabled ?? false))
    ) {
      context.addIssue({
        code: "custom",
        path: ["authority", "autonomousMergesEnabled"],
        message: "Autonomous merge authority must require every factory authority switch."
      });
    }
  });
export type FactoryOperationsHealthReport = z.infer<typeof factoryOperationsHealthReportSchema>;
