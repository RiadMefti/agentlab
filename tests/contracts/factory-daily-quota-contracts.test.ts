import {
  factoryDailyQuotaPolicySchema,
  factoryDailyQuotaReservationSchema
} from "@agentlab/contracts";
import { describe, expect, it } from "vitest";

import { testFactoryDailyQuotaPolicy } from "../helpers/factory-daily-quota.js";
import { testDigest } from "../helpers/factory.js";

describe("factory daily quota contracts", () => {
  it("accepts one exact reviewed policy and UTC-day reservation", () => {
    const reservation = validReservation();

    expect(factoryDailyQuotaPolicySchema.parse(reservation.quotaPolicy)).toEqual(
      reservation.quotaPolicy
    );
    expect(factoryDailyQuotaReservationSchema.parse(reservation)).toEqual(reservation);
    expect(
      factoryDailyQuotaReservationSchema.parse({
        ...reservation,
        windowStart: "2028-02-28T00:00:00.000Z",
        windowEnd: "2028-02-29T00:00:00.000Z",
        reservedAt: "2028-02-28T12:00:00.000Z"
      })
    ).toBeDefined();
  });

  it("rejects duplicate repository authority and substituted quota ceilings", () => {
    const policy = testFactoryDailyQuotaPolicy();
    expect(() =>
      factoryDailyQuotaPolicySchema.parse({
        ...policy,
        repositories: [policy.repositories[0], policy.repositories[0]]
      })
    ).toThrow(/unique/u);

    const reservation = validReservation();
    expect(() =>
      factoryDailyQuotaReservationSchema.parse({
        ...reservation,
        repositoryQuota: {
          ...reservation.repositoryQuota,
          maximumTasksPerDay: reservation.repositoryQuota.maximumTasksPerDay + 1
        }
      })
    ).toThrow(/must match policy/u);
    expect(() =>
      factoryDailyQuotaReservationSchema.parse({
        ...reservation,
        organizationId: "another-organization"
      })
    ).toThrow(/policy organization/u);
  });

  it("rejects non-consecutive windows and reservations outside their UTC day", () => {
    const reservation = validReservation();
    expect(() =>
      factoryDailyQuotaReservationSchema.parse({
        ...reservation,
        windowEnd: "2026-09-02T00:00:00.000Z"
      })
    ).toThrow(/exact UTC day/u);
    expect(() =>
      factoryDailyQuotaReservationSchema.parse({
        ...reservation,
        reservedAt: reservation.windowEnd
      })
    ).toThrow(/inside its UTC-day window/u);
  });
});

function validReservation() {
  const quotaPolicy = testFactoryDailyQuotaPolicy();
  const repositoryQuota = quotaPolicy.repositories[0];
  if (repositoryQuota === undefined) throw new Error("Test quota policy lost its repository.");
  return {
    schemaVersion: "agentlab.daily-quota-reservation.v1" as const,
    reservationId: "10000000-0000-4000-8000-000000000001",
    quotaPolicyDigest: testDigest("1"),
    quotaPolicy,
    organizationId: quotaPolicy.organizationId,
    repositoryId: repositoryQuota.repositoryId,
    taskId: "20000000-0000-4000-8000-000000000002",
    scheduleRunId: "30000000-0000-4000-8000-000000000003",
    scheduleRunDigest: testDigest("2"),
    canaryReservationDigest: testDigest("3"),
    windowStart: "2026-08-31T00:00:00.000Z",
    windowEnd: "2026-09-01T00:00:00.000Z",
    repositoryQuota,
    organizationQuota: quotaPolicy.organization,
    budget: repositoryQuota.budget,
    draftPullRequests: 1 as const,
    reservedAt: "2026-08-31T12:05:00.000Z",
    correlationId: "40000000-0000-4000-8000-000000000004"
  };
}
