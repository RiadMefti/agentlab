import type { FactoryDailyQuotaReservation } from "@agentlab/contracts";
import { describe, expect, it } from "vitest";

import { FactoryDailyQuotaService } from "../../packages/runtime/src/application/factory-daily-quota-service.js";
import {
  FactoryDailyQuotaCapacityError,
  type FactoryDailyQuotaRepository,
  type FactoryDailyQuotaReservationSnapshot
} from "../../packages/runtime/src/domain/factory-daily-quota-repository.js";
import type { CanonicalFactoryDocument } from "../../packages/runtime/src/domain/factory-documents.js";
import { NodeFactoryDocumentCodec } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { testFactoryDailyQuotaPolicy } from "../helpers/factory-daily-quota.js";
import { testFactoryScheduleBudget } from "../helpers/factory-schedule.js";
import { testDigest } from "../helpers/factory.js";

const documents = new NodeFactoryDocumentCodec();

describe("FactoryDailyQuotaService", () => {
  it("reserves worst-case authority once and recovers the original correlation after retry", async () => {
    const fixture = serviceFixture();
    const first = await fixture.service.reserve(command());
    const retried = await fixture.service.reserve({
      ...command(),
      correlationId: "90000000-0000-4000-8000-000000000009"
    });

    expect(first).toMatchObject({ status: "reserved" });
    expect(retried).toEqual(first);
    if (first.status !== "reserved") throw new Error("Expected a quota reservation.");
    expect(first.snapshot.reservation).toMatchObject({
      organizationId: "agentlab-test",
      repositoryId: "agentlab",
      budget: testFactoryScheduleBudget(),
      draftPullRequests: 1,
      correlationId: command().correlationId
    });
    expect(fixture.repository.insertAttempts).toBe(1);
  });

  it("denies repositories outside policy and refuses reservations outside the UTC day", async () => {
    const fixture = serviceFixture();
    await expect(
      fixture.service.reserve({ ...command(), repositoryId: "unreviewed/repository" })
    ).resolves.toEqual({
      status: "denied",
      reasonCode: "daily-quota-repository-not-authorized"
    });
    expect(fixture.repository.insertAttempts).toBe(0);

    const late = serviceFixture({ now: "2026-09-01T00:00:00.000Z" });
    await expect(late.service.reserve(command())).rejects.toThrow(/outside the scheduled UTC day/u);
  });

  it("maps repository and organization capacity failures without fabricating authority", async () => {
    for (const scope of ["repository", "organization"] as const) {
      const fixture = serviceFixture();
      fixture.repository.failure = new FactoryDailyQuotaCapacityError(scope);
      await expect(fixture.service.reserve(command())).resolves.toEqual({
        status: "denied",
        reasonCode: `daily-quota-${scope}-capacity-exceeded`
      });
      expect(await fixture.repository.findByTaskId(command().taskId)).toBeNull();
    }
  });

  it("recovers an exact concurrent insert before interpreting a capacity error", async () => {
    const fixture = serviceFixture();
    fixture.repository.failure = new FactoryDailyQuotaCapacityError("repository");
    fixture.repository.persistBeforeFailure = true;

    const outcome = await fixture.service.reserve(command());

    expect(outcome.status).toBe("reserved");
    expect(fixture.repository.insertAttempts).toBe(1);
  });

  it("requires exact digest, run, budget, and stored task correlation at consumption", async () => {
    const fixture = serviceFixture();
    const reserved = await fixture.service.reserve(command());
    if (reserved.status !== "reserved") throw new Error("Expected a quota reservation.");
    await expect(
      fixture.service.requireReservation({
        ...command(),
        reservationDigest: reserved.snapshot.reservationDigest
      })
    ).resolves.toEqual(reserved.snapshot);
    await expect(
      fixture.service.requireReservation({
        ...command(),
        budget: { ...command().budget, maxToolCalls: command().budget.maxToolCalls - 1 },
        reservationDigest: reserved.snapshot.reservationDigest
      })
    ).rejects.toThrow(/immutable identity/u);
    await expect(
      fixture.service.requireReservation({
        ...command(),
        correlationId: "90000000-0000-4000-8000-000000000009",
        reservationDigest: reserved.snapshot.reservationDigest
      })
    ).rejects.toThrow(/immutable identity/u);
  });
});

function serviceFixture(options: { readonly now?: string } = {}) {
  const policy = documents.dailyQuotaPolicy(testFactoryDailyQuotaPolicy());
  const repository = new MemoryDailyQuotaRepository();
  let id = 0;
  return {
    repository,
    service: new FactoryDailyQuotaService({
      policy,
      quotas: repository,
      documents,
      now: () => options.now ?? "2026-08-31T12:05:00.000Z",
      createId: () =>
        id++ === 0 ? "50000000-0000-4000-8000-000000000005" : "60000000-0000-4000-8000-000000000006"
    })
  };
}

function command() {
  return {
    repositoryId: "agentlab",
    taskId: "10000000-0000-4000-8000-000000000001",
    scheduleRunId: "20000000-0000-4000-8000-000000000002",
    scheduleRunDigest: testDigest("2"),
    canaryReservationDigest: testDigest("3"),
    scheduledFor: "2026-08-31T12:00:00.000Z",
    budget: testFactoryScheduleBudget(),
    correlationId: "40000000-0000-4000-8000-000000000004"
  } as const;
}

class MemoryDailyQuotaRepository implements FactoryDailyQuotaRepository {
  public failure: Error | null = null;
  public persistBeforeFailure = false;
  public insertAttempts = 0;
  readonly #byTask = new Map<string, FactoryDailyQuotaReservationSnapshot>();
  readonly #byDigest = new Map<string, FactoryDailyQuotaReservationSnapshot>();

  public reserve(
    reservation: CanonicalFactoryDocument<FactoryDailyQuotaReservation>
  ): Promise<FactoryDailyQuotaReservationSnapshot> {
    this.insertAttempts += 1;
    const snapshot = {
      reservation: reservation.value,
      reservationDigest: reservation.digest
    };
    if (this.persistBeforeFailure) this.#store(snapshot);
    if (this.failure !== null) return Promise.reject(this.failure);
    this.#store(snapshot);
    return Promise.resolve(snapshot);
  }

  public findByTaskId(taskId: string): Promise<FactoryDailyQuotaReservationSnapshot | null> {
    return Promise.resolve(this.#byTask.get(taskId) ?? null);
  }

  public findByReservationDigest(
    digest: `sha256:${string}`
  ): Promise<FactoryDailyQuotaReservationSnapshot | null> {
    return Promise.resolve(this.#byDigest.get(digest) ?? null);
  }

  public close(): void {
    return;
  }

  #store(snapshot: FactoryDailyQuotaReservationSnapshot): void {
    this.#byTask.set(snapshot.reservation.taskId, snapshot);
    this.#byDigest.set(snapshot.reservationDigest, snapshot);
  }
}
