import {
  factoryLedgerReadPolicySchema,
  factoryLedgerReadRequestSchema,
  factoryLedgerReadResponseSchema,
  factoryTimestampSchema,
  type FactoryLedgerReadPolicy,
  type FactoryLedgerReadResponse,
  type Sha256Digest
} from "@agentlab/contracts";

import type {
  FactoryControlRepository,
  FactoryTaskRepository
} from "../domain/factory-task-repository.js";

export interface FactoryLedgerQueryDependencies {
  readonly policy: FactoryLedgerReadPolicy;
  readonly policyDigest: Sha256Digest;
  readonly controls: Pick<FactoryControlRepository, "state">;
  readonly tasks: Pick<FactoryTaskRepository, "findById">;
  readonly now: () => string;
}

/** Explicit read capabilities only. Mutations must arrive through future reviewed use cases. */
export class FactoryLedgerQueries {
  readonly #policy: FactoryLedgerReadPolicy;

  public constructor(private readonly dependencies: FactoryLedgerQueryDependencies) {
    this.#policy = factoryLedgerReadPolicySchema.parse(dependencies.policy);
  }

  public async execute(
    authenticatedUid: number,
    input: unknown
  ): Promise<FactoryLedgerReadResponse> {
    const parsed = factoryLedgerReadRequestSchema.safeParse(input);
    const denied = {
      schemaVersion: "agentlab.ledger-read-response.v1" as const,
      requestId: parsed.success ? parsed.data.requestId : null,
      status: "denied" as const
    };
    const principal = this.#policy.principals.find(({ uid }) => uid === authenticatedUid);
    if (
      !parsed.success ||
      principal === undefined ||
      parsed.data.peerPolicyDigest !== this.dependencies.policyDigest ||
      factoryTimestampSchema.parse(this.dependencies.now()) >= this.#policy.expiresAt
    )
      return denied;
    const request = parsed.data;
    if (request.operation === "authority.read") {
      const state = await this.dependencies.controls.state();
      return factoryLedgerReadResponseSchema.parse({
        ...denied,
        status: "authority",
        scheduler: state.scheduler,
        prBroker: state.prBroker,
        mergeBroker: state.mergeBroker ?? false
      });
    }
    if (
      !principal.tasks.some(
        ({ taskId, contractDigest }) =>
          taskId === request.taskId && contractDigest === request.contractDigest
      )
    )
      return denied;
    const snapshot = await this.dependencies.tasks.findById(request.taskId);
    if (snapshot?.contractDigest !== request.contractDigest) return denied;
    return factoryLedgerReadResponseSchema.parse({ ...denied, status: "task", snapshot });
  }
}
