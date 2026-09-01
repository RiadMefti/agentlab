import { factoryTimestampSchema, sha256DigestSchema, type Sha256Digest } from "@agentlab/contracts";
import { z } from "zod";

import {
  assertFactoryBrokeredTaskReservation,
  isFactoryCanaryReservationCurrentAt
} from "../domain/factory-canary-reservation-integrity.js";
import type { FactoryCanaryReservationRepository } from "../domain/factory-canary-reservation-repository.js";
import type { FactoryDocumentCodec } from "../domain/factory-documents.js";
import type { FactoryPreparationRepository } from "../domain/factory-preparation-repository.js";
import type { FactoryScheduleRepository } from "../domain/factory-schedule-repository.js";
import type { FactoryTaskSnapshot } from "../domain/factory-task-repository.js";

export const factoryPullRequestCanaryCoordinatesSchema = z
  .object({
    reservationDigest: sha256DigestSchema,
    schedulePolicyDigest: sha256DigestSchema,
    roleIdentityPolicyDigest: sha256DigestSchema
  })
  .strict();

export type FactoryPullRequestCanaryCoordinates = z.infer<
  typeof factoryPullRequestCanaryCoordinatesSchema
>;

export interface FactoryPullRequestCanaryAuthorityDependencies {
  readonly policyBundleDigest: Sha256Digest;
  readonly schedulePolicyDigest: Sha256Digest | null;
  readonly roleIdentityPolicyDigest: Sha256Digest | null;
  readonly preparations: Pick<FactoryPreparationRepository, "findById">;
  readonly reservations: Pick<FactoryCanaryReservationRepository, "findByReservationDigest">;
  readonly schedules: Pick<FactoryScheduleRepository, "findTaskCompletion">;
  readonly documents: Pick<FactoryDocumentCodec, "canaryTaskReservation">;
  readonly now: () => string;
}

/** Independently proves that a scheduled task may cross into the credential-bearing broker. */
export class FactoryPullRequestCanaryAuthority {
  public constructor(
    private readonly dependencies: FactoryPullRequestCanaryAuthorityDependencies
  ) {}

  public async require(
    task: FactoryTaskSnapshot,
    coordinates: FactoryPullRequestCanaryCoordinates | undefined
  ): Promise<Sha256Digest | null> {
    if (task.contract.trigger !== "scheduled") {
      if (coordinates !== undefined) {
        throw new Error("Non-scheduled draft PR work cannot consume canary broker authority.");
      }
      return null;
    }
    if (coordinates === undefined) {
      throw new Error("Scheduled draft PR work requires exact canary broker authority.");
    }
    const parsed = factoryPullRequestCanaryCoordinatesSchema.parse(coordinates);
    if (
      this.dependencies.schedulePolicyDigest === null ||
      this.dependencies.roleIdentityPolicyDigest === null ||
      parsed.schedulePolicyDigest !== this.dependencies.schedulePolicyDigest ||
      parsed.roleIdentityPolicyDigest !== this.dependencies.roleIdentityPolicyDigest
    ) {
      throw new Error("Scheduled draft PR work requires the exact configured canary policy pins.");
    }
    const [preparation, reservation, completion] = await Promise.all([
      this.dependencies.preparations.findById(task.contract.taskId),
      this.dependencies.reservations.findByReservationDigest(parsed.reservationDigest),
      this.dependencies.schedules.findTaskCompletion(task.contract.taskId)
    ]);
    if (preparation === null || reservation === null || completion === null) {
      throw new Error("Scheduled draft PR work is missing its complete canary authority chain.");
    }
    const document = assertFactoryBrokeredTaskReservation(
      reservation,
      preparation,
      task,
      {
        schedulePolicyDigest: parsed.schedulePolicyDigest,
        policyBundleDigest: this.dependencies.policyBundleDigest,
        roleIdentityPolicyDigest: parsed.roleIdentityPolicyDigest
      },
      this.dependencies.documents
    );
    if (
      !isFactoryCanaryReservationCurrentAt(
        document.value,
        factoryTimestampSchema.parse(this.dependencies.now())
      )
    ) {
      throw new Error("Scheduled draft PR canary authority is not currently valid.");
    }
    const event = completion.event;
    if (
      completion.state !== "completed" ||
      completion.run.schemaVersion !== "agentlab.schedule-run.v2" ||
      completion.run.schedulePolicyDigest !== parsed.schedulePolicyDigest ||
      completion.run.factoryPolicyBundleDigest !== this.dependencies.policyBundleDigest ||
      completion.run.roleIdentityPolicyDigest !== parsed.roleIdentityPolicyDigest ||
      event.schemaVersion !== "agentlab.schedule-event.v2" ||
      event.taskId !== task.contract.taskId ||
      event.canaryReservationDigest !== parsed.reservationDigest ||
      event.result !== "ready-for-broker" ||
      event.preparationState !== "prepared" ||
      event.taskState !== "pr-proposed" ||
      event.contractDigest !== task.contractDigest
    ) {
      throw new Error("Scheduled draft PR work lacks its exact completed scheduler handoff.");
    }
    return document.digest;
  }
}
