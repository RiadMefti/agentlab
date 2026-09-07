import {
  factoryBudgetSchema,
  factoryIdentifierSchema,
  factoryTimestampSchema,
  sha256DigestSchema,
  type FactoryDailyQuotaPolicy
} from "@agentlab/contracts";
import { z } from "zod";

import {
  assertFactoryDailyQuotaReservation,
  factoryDailyQuotaRepositoryAuthorized,
  factoryDailyQuotaWindow,
  type FactoryDailyQuotaReservationIdentity
} from "../domain/factory-daily-quota-integrity.js";
import {
  FactoryDailyQuotaCapacityError,
  type FactoryDailyQuotaRepository,
  type FactoryDailyQuotaReservationSnapshot
} from "../domain/factory-daily-quota-repository.js";
import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../domain/factory-documents.js";

const quotaReservationCommandSchema = z
  .object({
    repositoryId: factoryIdentifierSchema,
    taskId: z.uuid(),
    scheduleRunId: z.uuid(),
    scheduleRunDigest: sha256DigestSchema,
    canaryReservationDigest: sha256DigestSchema,
    scheduledFor: factoryTimestampSchema,
    budget: factoryBudgetSchema,
    correlationId: z.uuid()
  })
  .strict();

export type FactoryDailyQuotaReservationOutcome =
  | {
      readonly status: "reserved";
      readonly snapshot: FactoryDailyQuotaReservationSnapshot;
    }
  | {
      readonly status: "denied";
      readonly reasonCode:
        | "daily-quota-repository-not-authorized"
        | "daily-quota-repository-capacity-exceeded"
        | "daily-quota-organization-capacity-exceeded";
    };

export interface FactoryDailyQuotaServiceDependencies {
  readonly policy: CanonicalFactoryDocument<FactoryDailyQuotaPolicy>;
  readonly quotas: FactoryDailyQuotaRepository;
  readonly documents: Pick<FactoryDocumentCodec, "dailyQuotaPolicy" | "dailyQuotaReservation">;
  readonly now: () => string;
  readonly createId: () => string;
}

/** Conservatively consumes reviewed UTC-day authority before scheduled model work. */
export class FactoryDailyQuotaService {
  public constructor(private readonly dependencies: FactoryDailyQuotaServiceDependencies) {}

  public async reserve(input: unknown): Promise<FactoryDailyQuotaReservationOutcome> {
    const command = quotaReservationCommandSchema.parse(input);
    const identity = this.#identity(command, false);
    if (
      !factoryDailyQuotaRepositoryAuthorized(this.dependencies.policy.value, command.repositoryId)
    ) {
      return { status: "denied", reasonCode: "daily-quota-repository-not-authorized" };
    }
    const existing = await this.dependencies.quotas.findByTaskId(command.taskId);
    if (existing !== null) {
      assertFactoryDailyQuotaReservation(existing, identity, this.dependencies.documents);
      return { status: "reserved", snapshot: existing };
    }
    const now = factoryTimestampSchema.parse(this.dependencies.now());
    const window = factoryDailyQuotaWindow(command.scheduledFor);
    if (now < window.windowStart || now >= window.windowEnd) {
      throw new Error("Factory daily quota cannot reserve outside the scheduled UTC day.");
    }
    const repositoryQuota = this.dependencies.policy.value.repositories.find(
      ({ repositoryId }) => repositoryId === command.repositoryId
    );
    if (repositoryQuota === undefined) {
      throw new Error("Authorized factory daily quota repository profile disappeared.");
    }
    const reservation = this.dependencies.documents.dailyQuotaReservation({
      schemaVersion: "agentlab.daily-quota-reservation.v1",
      reservationId: this.dependencies.createId(),
      quotaPolicyDigest: this.dependencies.policy.digest,
      quotaPolicy: this.dependencies.policy.value,
      organizationId: this.dependencies.policy.value.organizationId,
      repositoryId: command.repositoryId,
      taskId: command.taskId,
      scheduleRunId: command.scheduleRunId,
      scheduleRunDigest: command.scheduleRunDigest,
      canaryReservationDigest: command.canaryReservationDigest,
      ...window,
      repositoryQuota,
      organizationQuota: this.dependencies.policy.value.organization,
      budget: command.budget,
      draftPullRequests: 1,
      reservedAt: now,
      correlationId: command.correlationId
    });
    try {
      const snapshot = await this.dependencies.quotas.reserve(reservation);
      assertFactoryDailyQuotaReservation(snapshot, identity, this.dependencies.documents);
      return { status: "reserved", snapshot };
    } catch (error: unknown) {
      const raced = await this.dependencies.quotas.findByTaskId(command.taskId);
      if (raced !== null) {
        assertFactoryDailyQuotaReservation(raced, identity, this.dependencies.documents);
        return { status: "reserved", snapshot: raced };
      }
      if (error instanceof FactoryDailyQuotaCapacityError) {
        return {
          status: "denied",
          reasonCode:
            error.scope === "repository"
              ? "daily-quota-repository-capacity-exceeded"
              : "daily-quota-organization-capacity-exceeded"
        };
      }
      throw error;
    }
  }

  public async requireReservation(input: unknown): Promise<FactoryDailyQuotaReservationSnapshot> {
    const command = quotaReservationCommandSchema
      .extend({ reservationDigest: sha256DigestSchema })
      .parse(input);
    const snapshot = await this.dependencies.quotas.findByReservationDigest(
      command.reservationDigest
    );
    if (snapshot === null) {
      throw new Error("Factory daily quota reservation is missing.");
    }
    assertFactoryDailyQuotaReservation(
      snapshot,
      this.#identity(command, true),
      this.dependencies.documents
    );
    return snapshot;
  }

  #identity(
    command: z.infer<typeof quotaReservationCommandSchema>,
    includeCorrelation: boolean
  ): FactoryDailyQuotaReservationIdentity {
    return {
      policy: this.dependencies.policy,
      organizationId: this.dependencies.policy.value.organizationId,
      repositoryId: command.repositoryId,
      taskId: command.taskId,
      scheduleRunId: command.scheduleRunId,
      scheduleRunDigest: command.scheduleRunDigest,
      canaryReservationDigest: command.canaryReservationDigest,
      scheduledFor: command.scheduledFor,
      budget: command.budget,
      ...(includeCorrelation ? { correlationId: command.correlationId } : {})
    };
  }
}
