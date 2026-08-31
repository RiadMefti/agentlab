import { factoryIdentifierSchema } from "@agentlab/contracts";
import { z } from "zod";

import type { FactoryDocumentCodec } from "../domain/factory-documents.js";
import type { FactoryArtifactStore } from "../domain/factory-artifact-store.js";
import type {
  FactoryPreparationAuthorityIssueInput,
  IssuedFactoryPreparationAuthority
} from "../domain/factory-preparation-authority.js";
import type {
  FactoryPreparationRepository,
  FactoryPreparationSnapshot
} from "../domain/factory-preparation-repository.js";

const utf8Encoder = new TextEncoder();

export interface FactoryPreparationAuthorityIssuerPort {
  issue(input: FactoryPreparationAuthorityIssueInput): IssuedFactoryPreparationAuthority;
}

export interface RegisterFactoryPreparationInput extends FactoryPreparationAuthorityIssueInput {
  readonly correlationId: unknown;
}

export interface FactoryPreparationIntakeServiceOptions {
  readonly controlPlaneActorId: string;
  readonly createEventId: () => string;
}

/** Issues authority and atomically registers one immutable preparation chain. */
export class FactoryPreparationIntakeService {
  readonly #controlPlaneActorId: string;

  public constructor(
    private readonly documents: FactoryDocumentCodec,
    private readonly issuer: FactoryPreparationAuthorityIssuerPort,
    private readonly preparations: Pick<FactoryPreparationRepository, "register">,
    private readonly artifacts: Pick<FactoryArtifactStore, "putText">,
    private readonly options: FactoryPreparationIntakeServiceOptions
  ) {
    this.#controlPlaneActorId = factoryIdentifierSchema.parse(options.controlPlaneActorId);
  }

  public async register(
    input: RegisterFactoryPreparationInput
  ): Promise<FactoryPreparationSnapshot> {
    const issued = this.issuer.issue(input);
    const initialEvent = this.documents.preparationEvent({
      schemaVersion: "agentlab.preparation-event.v1",
      eventId: z.uuid().parse(this.options.createEventId()),
      taskId: issued.request.value.taskId,
      sequence: 1,
      requestDigest: issued.request.digest,
      authorityDigest: issued.authority.digest,
      previousEventDigest: null,
      kind: "registered",
      from: null,
      to: "registered",
      actor: {
        kind: "control-plane",
        role: "policy-engine",
        id: this.#controlPlaneActorId,
        sessionId: null
      },
      occurredAt: issued.authority.value.issuedAt,
      reasonCode: "request-registered",
      summary: null,
      correlationId: z.uuid().parse(input.correlationId)
    });
    await this.#publishCanonical(issued.request.json, issued.request.digest, "intake request");
    await this.#publishCanonical(
      issued.authority.json,
      issued.authority.digest,
      "preparation authority"
    );
    return this.preparations.register(issued.request, issued.authority, initialEvent);
  }

  async #publishCanonical(content: string, expectedDigest: string, label: string): Promise<void> {
    const stored = await this.artifacts.putText(content);
    if (
      stored.digest !== expectedDigest ||
      stored.sizeBytes !== utf8Encoder.encode(content).byteLength
    ) {
      throw new Error(`Published ${label} artifact does not match its canonical document.`);
    }
  }
}
