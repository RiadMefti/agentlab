import type { Sha256Digest } from "@agentlab/contracts";

import type {
  FactoryDraftPullRequestBroker,
  FactoryRemoteRepositorySnapshot
} from "../domain/factory-pull-request-broker.js";
import type { FactoryControlRepository } from "../domain/factory-task-repository.js";
import { factoryRepositoryGovernanceDenials } from "./factory-pull-request-policy.js";
import type {
  FactoryPullRequestOutcome,
  FactoryPullRequestService
} from "./factory-pull-request-service.js";

export interface FactoryBrokerPreflight {
  readonly schemaVersion: "agentlab.broker-preflight.v1";
  readonly status: "ready" | "blocked";
  readonly repository: FactoryRemoteRepositorySnapshot;
  readonly policyBundleDigest: Sha256Digest;
  readonly authorityEnabled: boolean;
  readonly reasonCodes: readonly string[];
}

export interface FactoryBrokerOperatorDependencies {
  readonly repositoryId: string;
  readonly policyBundleDigest: Sha256Digest;
  readonly costPolicyConfigured: boolean;
  readonly remote: Pick<FactoryDraftPullRequestBroker, "inspect">;
  readonly controls: Pick<FactoryControlRepository, "state">;
  readonly pullRequests: Pick<FactoryPullRequestService, "openDraft">;
}

/** Public authority-plane boundary; this process has no model or provider execution dependency. */
export class FactoryBrokerOperator {
  public constructor(private readonly dependencies: FactoryBrokerOperatorDependencies) {}

  public async preflight(): Promise<FactoryBrokerPreflight> {
    const [repository, authority] = await Promise.all([
      this.dependencies.remote.inspect(this.dependencies.repositoryId),
      this.dependencies.controls.state()
    ]);
    if (repository.repositoryId !== this.dependencies.repositoryId) {
      throw new Error("Broker preflight returned another repository identity.");
    }
    const reasonCodes = [
      ...factoryRepositoryGovernanceDenials(repository.governance),
      ...(this.dependencies.costPolicyConfigured ? [] : ["cost-policy-unconfigured"]),
      ...(authority.prBroker ? [] : ["pr-broker-disabled"])
    ].sort();
    return {
      schemaVersion: "agentlab.broker-preflight.v1",
      status: reasonCodes.length === 0 ? "ready" : "blocked",
      repository,
      policyBundleDigest: this.dependencies.policyBundleDigest,
      authorityEnabled: authority.prBroker,
      reasonCodes
    };
  }

  public openDraft(input: unknown): Promise<FactoryPullRequestOutcome> {
    if (!this.dependencies.costPolicyConfigured) {
      return Promise.resolve({
        status: "denied",
        reasonCodes: ["cost-policy-unconfigured"],
        decision: null
      });
    }
    return this.dependencies.pullRequests.openDraft(input);
  }
}
