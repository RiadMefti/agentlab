import {
  factoryLedgerAuthorityPolicySchema,
  factoryLedgerAuthorityRequestSchema,
  factoryLedgerAuthorityIntentSchema,
  factoryLedgerReadPolicySchema,
  factoryTimestampSchema,
  type FactoryLedgerAuthorityPolicy,
  type FactoryLedgerAuthorityResponse,
  type FactoryLedgerReadPolicy,
  type Sha256Digest
} from "@agentlab/contracts";

import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../domain/factory-documents.js";
import type { FactoryLedgerAuthorityRepository } from "../domain/factory-ledger-authority-repository.js";
import { ConflictError } from "../domain/errors.js";
import { factoryTimestampMilliseconds } from "../domain/factory-timestamp.js";

export interface FactoryLedgerAuthorityDependencies {
  readonly peerPolicy: FactoryLedgerReadPolicy;
  readonly peerPolicyDigest: Sha256Digest;
  readonly authorityPolicy: FactoryLedgerAuthorityPolicy;
  readonly authorityPolicyDigest: Sha256Digest;
  readonly repository: FactoryLedgerAuthorityRepository;
  readonly documents: Pick<FactoryDocumentCodec, "controlEvent">;
  readonly encode: <T>(value: T) => CanonicalFactoryDocument<T>;
  readonly now: () => string;
  readonly createId: () => string;
}

/** Kernel identity + two reviewed grants, never a caller-supplied actor or role. */
export class FactoryLedgerAuthority {
  readonly #peers: FactoryLedgerReadPolicy;
  readonly #authority: FactoryLedgerAuthorityPolicy;

  public constructor(private readonly dependencies: FactoryLedgerAuthorityDependencies) {
    this.#peers = factoryLedgerReadPolicySchema.parse(dependencies.peerPolicy);
    this.#authority = factoryLedgerAuthorityPolicySchema.parse(dependencies.authorityPolicy);
    if (
      dependencies.encode(this.#peers).digest !== dependencies.peerPolicyDigest ||
      dependencies.encode(this.#authority).digest !== dependencies.authorityPolicyDigest ||
      this.#authority.grants.some(
        (grant) =>
          !this.#peers.principals.some(
            (peer) => peer.uid === grant.uid && peer.id === grant.id && peer.role === "operator"
          )
      )
    ) {
      throw new Error(
        "Ledger authority requires pinned policies and distinct operator principals."
      );
    }
  }

  public async execute(uid: number, input: unknown): Promise<FactoryLedgerAuthorityResponse> {
    const parsed = factoryLedgerAuthorityRequestSchema.safeParse(input);
    const denied = {
      schemaVersion: "agentlab.ledger-authority-response.v1" as const,
      requestId: parsed.success ? parsed.data.requestId : null,
      status: "denied" as const
    };
    const grant = this.#authority.grants.find((entry) => entry.uid === uid);
    const now = factoryTimestampSchema.parse(this.dependencies.now());
    if (
      !parsed.success ||
      grant === undefined ||
      parsed.data.peerPolicyDigest !== this.dependencies.peerPolicyDigest ||
      parsed.data.authorityPolicyDigest !== this.dependencies.authorityPolicyDigest ||
      now >= this.#peers.expiresAt ||
      now >= this.#authority.expiresAt
    )
      return denied;
    const request = parsed.data;
    if (request.operation === "authority.inspect") {
      const [scheduler, prBroker, mergeBroker] = await Promise.all([
        this.dependencies.repository.authorityHead("scheduler"),
        this.dependencies.repository.authorityHead("pr-broker"),
        this.dependencies.repository.authorityHead("merge-broker")
      ]);
      return { ...denied, status: "inspection", scheduler, prBroker, mergeBroker };
    }
    if (request.operation === "authority.receipt") {
      const receipt = await this.dependencies.repository.findAuthorityReceipt(
        uid,
        request.idempotencyKey
      );
      if (
        receipt?.value.intentDigest !== request.intentDigest ||
        receipt.value.intent.principalId !== grant.id ||
        !grant.controls.some(({ control }) => control === receipt.value.intent.command.control)
      )
        return denied;
      return {
        ...denied,
        status: "receipt",
        receipt: receipt.value,
        receiptDigest: receipt.digest
      };
    }
    const command = request.command;
    const control = grant.controls.find((entry) => entry.control === command.control);
    if (
      control === undefined ||
      (command.enabled && !control.allowEnable) ||
      command.expiresAt <= now ||
      command.expiresAt > this.#peers.expiresAt ||
      command.expiresAt > this.#authority.expiresAt ||
      factoryTimestampMilliseconds(command.expiresAt) - factoryTimestampMilliseconds(now) > 120_000
    )
      return denied;
    const intent = this.dependencies.encode(
      factoryLedgerAuthorityIntentSchema.parse({
        schemaVersion: "agentlab.ledger-authority-intent.v1",
        principalUid: uid,
        principalId: grant.id,
        peerPolicyDigest: request.peerPolicyDigest,
        authorityPolicyDigest: request.authorityPolicyDigest,
        command
      })
    );
    const event = this.dependencies.documents.controlEvent({
      schemaVersion: "agentlab.control-event.v1",
      eventId: this.dependencies.createId(),
      control: command.control,
      enabled: command.enabled,
      actor: { kind: "human", role: "requester", id: grant.id, sessionId: null },
      occurredAt: now,
      reason: command.reason
    });
    try {
      const receipt = await this.dependencies.repository.changeAuthority(
        intent,
        event,
        this.dependencies.now
      );
      return {
        ...denied,
        status: "receipt",
        receipt: receipt.value,
        receiptDigest: receipt.digest
      };
    } catch (error: unknown) {
      if (error instanceof ConflictError) return denied;
      throw error;
    }
  }
}
