import {
  factoryIdentifierSchema,
  type FactoryControlEvent,
  type Sha256Digest
} from "@agentlab/contracts";
import { z } from "zod";

import { ConflictError } from "../domain/errors.js";
import type { FactoryDocumentCodec } from "../domain/factory-documents.js";
import type {
  FactoryAuthorityState,
  FactoryControlRepository
} from "../domain/factory-task-repository.js";

const brokerAuthorityCommandSchema = z
  .object({
    expectedEnabled: z.boolean(),
    enabled: z.boolean(),
    reason: z.string().trim().min(1).max(500),
    confirmation: z.enum(["enable-draft-broker", "disable-draft-broker"])
  })
  .strict()
  .superRefine((command, context) => {
    if (command.expectedEnabled === command.enabled) {
      context.addIssue({
        code: "custom",
        path: ["expectedEnabled"],
        message: "Authority change must transition from the expected opposite state."
      });
    }
    const expectedConfirmation = command.enabled ? "enable-draft-broker" : "disable-draft-broker";
    if (command.confirmation !== expectedConfirmation) {
      context.addIssue({
        code: "custom",
        path: ["confirmation"],
        message: "Authority change confirmation does not match the requested state."
      });
    }
  });

export type FactoryBrokerAuthorityCommand = z.infer<typeof brokerAuthorityCommandSchema>;

export interface FactoryAuthorityInspection {
  readonly schemaVersion: "agentlab.authority-inspection.v1";
  readonly schedulerEnabled: boolean;
  readonly prBrokerEnabled: boolean;
  readonly recentBrokerEvents: readonly FactoryControlEvent[];
}

export interface FactoryBrokerAuthorityChange {
  readonly schemaVersion: "agentlab.authority-change-result.v1";
  readonly changed: true;
  readonly schedulerEnabled: boolean;
  readonly prBrokerEnabled: boolean;
  readonly event: FactoryControlEvent;
  readonly eventDigest: Sha256Digest;
}

export interface FactoryAuthorityOperatorDependencies {
  readonly controls: Pick<FactoryControlRepository, "state" | "record" | "history">;
  readonly documents: Pick<FactoryDocumentCodec, "controlEvent">;
  readonly operatorId: string;
  readonly now: () => string;
  readonly createId: () => string;
}

/** Human-only local administration boundary; it cannot execute work or access remote credentials. */
export class FactoryAuthorityOperator {
  readonly #operatorId: string;

  public constructor(private readonly dependencies: FactoryAuthorityOperatorDependencies) {
    this.#operatorId = factoryIdentifierSchema.parse(dependencies.operatorId);
  }

  public async inspect(): Promise<FactoryAuthorityInspection> {
    const [state, recentBrokerEvents] = await Promise.all([
      this.dependencies.controls.state(),
      this.dependencies.controls.history("pr-broker", 20)
    ]);
    return inspection(state, recentBrokerEvents);
  }

  public async setBrokerAuthority(input: unknown): Promise<FactoryBrokerAuthorityChange> {
    const command = brokerAuthorityCommandSchema.parse(input);
    const event = this.dependencies.documents.controlEvent({
      schemaVersion: "agentlab.control-event.v1",
      eventId: this.dependencies.createId(),
      control: "pr-broker",
      enabled: command.enabled,
      actor: {
        kind: "human",
        role: "requester",
        id: this.#operatorId,
        sessionId: null
      },
      occurredAt: this.dependencies.now(),
      reason: command.reason
    });
    const state = await this.dependencies.controls.record(event, command.expectedEnabled);
    if (state === null) {
      throw new ConflictError(
        "Factory broker authority changed concurrently; inspect state before retrying."
      );
    }
    if (state.prBroker !== command.enabled) {
      throw new Error("Factory broker authority repository returned an inconsistent state.");
    }
    return {
      schemaVersion: "agentlab.authority-change-result.v1",
      changed: true,
      schedulerEnabled: state.scheduler,
      prBrokerEnabled: state.prBroker,
      event: event.value,
      eventDigest: event.digest
    };
  }
}

function inspection(
  state: FactoryAuthorityState,
  recentBrokerEvents: readonly FactoryControlEvent[]
): FactoryAuthorityInspection {
  return {
    schemaVersion: "agentlab.authority-inspection.v1",
    schedulerEnabled: state.scheduler,
    prBrokerEnabled: state.prBroker,
    recentBrokerEvents
  };
}
