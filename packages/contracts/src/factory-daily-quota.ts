import { z } from "zod";

import {
  factoryBudgetSchema,
  factoryIdentifierSchema,
  factorySemanticVersionSchema,
  factoryTimestampSchema,
  sha256DigestSchema
} from "./factory.js";

const quotaCeilingSchema = z
  .object({
    maximumTasksPerDay: z.number().int().min(1).max(1_024),
    maximumDraftPullRequestsPerDay: z.number().int().min(0).max(1_024),
    budget: factoryBudgetSchema
  })
  .strict();

const repositoryQuotaSchema = quotaCeilingSchema
  .extend({ repositoryId: factoryIdentifierSchema })
  .strict();

/** Reviewed UTC-day ceilings shared by every scheduler using the same durable ledger. */
export const factoryDailyQuotaPolicySchema = z
  .object({
    schemaVersion: z.literal("agentlab.daily-quota-policy.v1"),
    id: z.literal("agentlab/daily-aggregate-quota"),
    version: factorySemanticVersionSchema,
    organizationId: factoryIdentifierSchema,
    timeZone: z.literal("UTC"),
    repositories: z.array(repositoryQuotaSchema).min(1).max(256),
    organization: quotaCeilingSchema
  })
  .strict()
  .superRefine((policy, context) => {
    if (
      new Set(policy.repositories.map(({ repositoryId }) => repositoryId)).size !==
      policy.repositories.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["repositories"],
        message: "Daily quota repository profiles must be unique."
      });
    }
  });
export type FactoryDailyQuotaPolicy = z.infer<typeof factoryDailyQuotaPolicySchema>;

/** Immutable worst-case reservation made before one scheduled task can start model work. */
export const factoryDailyQuotaReservationSchema = z
  .object({
    schemaVersion: z.literal("agentlab.daily-quota-reservation.v1"),
    reservationId: z.uuid(),
    quotaPolicyDigest: sha256DigestSchema,
    quotaPolicy: factoryDailyQuotaPolicySchema,
    organizationId: factoryIdentifierSchema,
    repositoryId: factoryIdentifierSchema,
    taskId: z.uuid(),
    scheduleRunId: z.uuid(),
    scheduleRunDigest: sha256DigestSchema,
    canaryReservationDigest: sha256DigestSchema,
    windowStart: factoryTimestampSchema,
    windowEnd: factoryTimestampSchema,
    repositoryQuota: repositoryQuotaSchema,
    organizationQuota: quotaCeilingSchema,
    budget: factoryBudgetSchema,
    draftPullRequests: z.literal(1),
    reservedAt: factoryTimestampSchema,
    correlationId: z.uuid()
  })
  .strict()
  .superRefine((reservation, context) => {
    if (reservation.organizationId !== reservation.quotaPolicy.organizationId) {
      context.addIssue({
        code: "custom",
        path: ["organizationId"],
        message: "Daily quota reservation must use its policy organization."
      });
    }
    const repositoryQuota = reservation.quotaPolicy.repositories.find(
      ({ repositoryId }) => repositoryId === reservation.repositoryId
    );
    if (repositoryQuota === undefined) {
      context.addIssue({
        code: "custom",
        path: ["repositoryId"],
        message: "Daily quota reservation repository is not authorized by policy."
      });
    } else if (JSON.stringify(repositoryQuota) !== JSON.stringify(reservation.repositoryQuota)) {
      context.addIssue({
        code: "custom",
        path: ["repositoryQuota"],
        message: "Daily quota reservation repository ceiling must match policy."
      });
    }
    if (
      JSON.stringify(reservation.organizationQuota) !==
      JSON.stringify(reservation.quotaPolicy.organization)
    ) {
      context.addIssue({
        code: "custom",
        path: ["organizationQuota"],
        message: "Daily quota reservation organization ceiling must match policy."
      });
    }
    if (
      !reservation.windowStart.endsWith("T00:00:00.000Z") ||
      reservation.windowEnd !== nextUtcDayStart(reservation.windowStart)
    ) {
      context.addIssue({
        code: "custom",
        path: ["windowEnd"],
        message: "Daily quota reservation must cover one exact UTC day."
      });
    }
    if (
      reservation.reservedAt < reservation.windowStart ||
      reservation.reservedAt >= reservation.windowEnd
    ) {
      context.addIssue({
        code: "custom",
        path: ["reservedAt"],
        message: "Daily quota reservation must occur inside its UTC-day window."
      });
    }
  });
export type FactoryDailyQuotaReservation = z.infer<typeof factoryDailyQuotaReservationSchema>;

function nextUtcDayStart(timestamp: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T00:00:00\.000Z$/u.exec(timestamp);
  if (match === null) return null;
  let year = Number(match[1]);
  let month = Number(match[2]);
  let day = Number(match[3]);
  const daysInMonth = [31, leapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][
    month - 1
  ];
  if (daysInMonth === undefined || day < 1 || day > daysInMonth) return null;
  day += 1;
  if (day > daysInMonth) {
    day = 1;
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}T00:00:00.000Z`;
}

function leapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}
