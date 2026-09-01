import {
  sha256DigestSchema,
  type FactorySchedulePolicy,
  type Sha256Digest
} from "@agentlab/contracts";
import { z } from "zod";

import { ConflictError } from "../domain/errors.js";
import type { FactoryCanaryReservationRepository } from "../domain/factory-canary-reservation-repository.js";
import type { CanonicalFactoryDocument } from "../domain/factory-documents.js";
import type { FactoryPreparationRepository } from "../domain/factory-preparation-repository.js";
import type { FactoryControlRepository } from "../domain/factory-task-repository.js";
import type {
  FactoryCanaryAdmissionCommand,
  FactoryCanaryAdmissionService
} from "./factory-canary-admission-service.js";

const tickCommandSchema = z
  .object({
    expectedCohortDigest: sha256DigestSchema,
    expectedCandidateDigest: sha256DigestSchema,
    expectedSchedulePolicyDigest: sha256DigestSchema,
    expectedPolicyBundleDigest: sha256DigestSchema,
    expectedRoleIdentityPolicyDigest: sha256DigestSchema
  })
  .strict();

type AdmissionPins = z.infer<typeof tickCommandSchema>;

export interface FactoryCanaryAdmissionTickReport {
  readonly schemaVersion: "agentlab.canary-admission-tick-result.v1";
  readonly status: "completed" | "blocked";
  readonly schedulePolicyDigest: Sha256Digest;
  readonly candidates: number;
  readonly reserved: number;
  readonly existing: number;
  readonly skipped: number;
  readonly reasonCodes: readonly string[];
}

export interface FactoryCanaryAdmissionConsumerServiceDependencies {
  readonly schedulePolicy: CanonicalFactoryDocument<FactorySchedulePolicy>;
  readonly pins: AdmissionPins;
  readonly controls: Pick<FactoryControlRepository, "state">;
  readonly preparations: Pick<FactoryPreparationRepository, "listScheduled">;
  readonly reservations: Pick<FactoryCanaryReservationRepository, "findByTaskId">;
  readonly admission: Pick<FactoryCanaryAdmissionService, "reserve">;
}

/** Reserves a bounded page only within pre-existing human-approved attested cohort authority. */
export class FactoryCanaryAdmissionConsumerService {
  readonly #pins: AdmissionPins;

  public constructor(
    private readonly dependencies: FactoryCanaryAdmissionConsumerServiceDependencies
  ) {
    this.#pins = tickCommandSchema.parse(dependencies.pins);
    if (dependencies.schedulePolicy.digest !== this.#pins.expectedSchedulePolicyDigest) {
      throw new Error("Canary admission consumer schedule policy differs from its reviewed pin.");
    }
  }

  public async tick(input: unknown): Promise<FactoryCanaryAdmissionTickReport> {
    const command = tickCommandSchema.parse(input);
    if (
      Object.keys(this.#pins).some(
        (key) => command[key as keyof AdmissionPins] !== this.#pins[key as keyof AdmissionPins]
      )
    ) {
      throw new ConflictError("Canary admission consumer pins changed after review.");
    }
    const authority = await this.dependencies.controls.state();
    if (!authority.scheduler)
      return report("blocked", this.dependencies.schedulePolicy.digest, 0, 0, 0, 0, [
        "scheduler-disabled"
      ]);
    const policy = this.dependencies.schedulePolicy.value;
    const candidates = await this.dependencies.preparations.listScheduled(
      policy.maximumCandidatesPerTick
    );
    let reserved = 0;
    let existing = 0;
    let skipped = 0;
    const reasonCodes: string[] = [];
    for (const candidate of candidates) {
      if (reserved >= policy.maximumTasksPerTick) break;
      if (
        candidate.request.trigger !== "scheduled" ||
        candidate.authority.taskId !== candidate.request.taskId ||
        candidate.authority.requestDigest !== candidate.requestDigest ||
        candidate.authority.policyBundleDigest !== this.#pins.expectedPolicyBundleDigest
      ) {
        throw new Error("Canary admission candidate failed immutable authority validation.");
      }
      if ((await this.dependencies.reservations.findByTaskId(candidate.request.taskId)) !== null) {
        existing += 1;
        continue;
      }
      const reservationCommand: FactoryCanaryAdmissionCommand = {
        taskId: candidate.request.taskId,
        ...this.#pins
      };
      try {
        const result = await this.dependencies.admission.reserve(reservationCommand);
        if (result.status === "reserved") reserved += 1;
        else existing += 1;
      } catch (error: unknown) {
        if (!(error instanceof ConflictError)) throw error;
        skipped += 1;
        reasonCodes.push("task-canary-admission-denied");
      }
    }
    return report(
      skipped === 0 ? "completed" : "blocked",
      this.dependencies.schedulePolicy.digest,
      candidates.length,
      reserved,
      existing,
      skipped,
      reasonCodes
    );
  }
}

function report(
  status: FactoryCanaryAdmissionTickReport["status"],
  schedulePolicyDigest: Sha256Digest,
  candidates: number,
  reserved: number,
  existing: number,
  skipped: number,
  reasonCodes: readonly string[]
): FactoryCanaryAdmissionTickReport {
  return {
    schemaVersion: "agentlab.canary-admission-tick-result.v1",
    status,
    schedulePolicyDigest,
    candidates,
    reserved,
    existing,
    skipped,
    reasonCodes: [...new Set(reasonCodes)].sort()
  };
}
