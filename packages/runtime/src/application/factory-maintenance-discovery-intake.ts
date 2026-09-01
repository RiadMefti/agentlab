import {
  factoryIdentifierSchema,
  type FactoryMaintenanceDiscoveryPolicy,
  type FactoryMaintenanceDiscoveryRun,
  type FactoryMaintenanceFinding,
  type FactoryPreparationState,
  type Sha256Digest
} from "@agentlab/contracts";
import { z } from "zod";

import { ConflictError } from "../domain/errors.js";
import type { FactoryIntakeDeduplicator } from "../domain/factory-intake-deduplicator.js";
import type {
  FactoryPreparationRepository,
  FactoryPreparationSnapshot
} from "../domain/factory-preparation-repository.js";
import { factoryTimestampAddSeconds } from "../domain/factory-timestamp.js";
import type {
  FactoryPreparationAuthorityIssuerPort,
  FactoryPreparationIntakeService
} from "./factory-preparation-intake-service.js";
import type { FactorySkillPackagePublisher } from "./factory-skill-package-publisher.js";

const requesterId = "agentlab-maintenance-discovery";

export interface FactoryMaintenanceDiscoveryAdmissionResult {
  readonly status: "admitted" | "existing";
  readonly taskId: string;
  readonly state: FactoryPreparationState;
  readonly requestDigest: Sha256Digest;
  readonly authorityDigest: Sha256Digest;
}

export interface FactoryMaintenanceDiscoveryIntakeDependencies {
  readonly repositoryId: string;
  readonly conversationId: string;
  readonly authorityLifetimeSeconds: number;
  readonly preparations: Pick<FactoryPreparationRepository, "findByDeduplicationKey">;
  readonly deduplicator: FactoryIntakeDeduplicator;
  readonly preparationSkills: Pick<FactorySkillPackagePublisher, "publish">;
  readonly authorityIssuer: FactoryPreparationAuthorityIssuerPort;
  readonly intake: Pick<FactoryPreparationIntakeService, "register">;
  readonly createId: () => string;
}

/** Converts one deterministically admitted finding into scheduled control-plane intake. */
export class FactoryMaintenanceDiscoveryIntake {
  readonly #repositoryId: string;
  readonly #conversationId: string;

  public constructor(private readonly dependencies: FactoryMaintenanceDiscoveryIntakeDependencies) {
    this.#repositoryId = factoryIdentifierSchema.parse(dependencies.repositoryId);
    this.#conversationId = z.uuid().parse(dependencies.conversationId);
    if (
      !Number.isSafeInteger(dependencies.authorityLifetimeSeconds) ||
      dependencies.authorityLifetimeSeconds < 60 ||
      dependencies.authorityLifetimeSeconds > 604_800
    ) {
      throw new Error("Discovery intake authority lifetime is invalid.");
    }
  }

  public publishPreparationSkills(): Promise<void> {
    return this.dependencies.preparationSkills.publish();
  }

  public async admit(
    run: FactoryMaintenanceDiscoveryRun,
    policy: FactoryMaintenanceDiscoveryPolicy,
    finding: FactoryMaintenanceFinding
  ): Promise<FactoryMaintenanceDiscoveryAdmissionResult> {
    if (
      run.repository.id !== this.#repositoryId ||
      finding.runId !== run.runId ||
      finding.candidate.findingKey.length === 0
    ) {
      throw new Error("Maintenance finding does not match its trusted discovery run.");
    }
    const requestKind = finding.candidate.changeClass === "bug" ? "bug" : "feature";
    const sourceRef = `maintenance-discovery:${finding.candidate.findingKey}`;
    const deduplicationKey = this.dependencies.deduplicator.key({
      repositoryId: this.#repositoryId,
      requestKind,
      sourceRef
    });
    const body = renderRequestBody(finding);
    const existing = await this.dependencies.preparations.findByDeduplicationKey(
      this.#repositoryId,
      deduplicationKey
    );
    if (existing !== null) {
      this.#assertExisting(existing, sourceRef, finding.candidate.title, body);
      return result("existing", existing);
    }
    const request = {
      schemaVersion: "agentlab.intake-request.v1" as const,
      taskId: z.uuid().parse(this.dependencies.createId()),
      conversationId: this.#conversationId,
      createdAt: finding.discoveredAt,
      deduplicationKey,
      repository: run.repository,
      requestSources: [{ kind: "other" as const, ref: sourceRef }],
      trigger: "scheduled" as const,
      requester: {
        kind: "control-plane" as const,
        role: "requester" as const,
        id: requesterId,
        sessionId: null
      },
      title: finding.candidate.title,
      body
    };
    const snapshot = await this.dependencies.intake.register({
      request,
      issuedAt: finding.discoveredAt,
      expiresAt: factoryTimestampAddSeconds(
        finding.discoveredAt,
        this.dependencies.authorityLifetimeSeconds
      ),
      supersedesContractDigest: null,
      correlationId: z.uuid().parse(this.dependencies.createId())
    });
    if (
      snapshot.authority.maximumRiskTier !== policy.maximumRiskTier ||
      snapshot.authority.policyBundleDigest !== run.factoryPolicyBundleDigest
    ) {
      throw new Error("Discovery intake returned authority outside its reviewed policy pins.");
    }
    return result("admitted", snapshot);
  }

  #assertExisting(
    existing: FactoryPreparationSnapshot,
    sourceRef: string,
    title: string,
    body: string
  ): void {
    const source = existing.request.requestSources[0];
    if (
      existing.request.conversationId !== this.#conversationId ||
      existing.request.requestSources.length !== 1 ||
      source?.kind !== "other" ||
      source.ref !== sourceRef ||
      existing.request.trigger !== "scheduled" ||
      existing.request.requester.kind !== "control-plane" ||
      existing.request.requester.role !== "requester" ||
      existing.request.requester.id !== requesterId ||
      existing.request.requester.sessionId !== null ||
      existing.request.title !== title ||
      existing.request.body !== body
    ) {
      throw new ConflictError(
        "Maintenance finding identity already exists with different immutable content."
      );
    }
    let reissued;
    try {
      reissued = this.dependencies.authorityIssuer.issue({
        request: existing.request,
        issuedAt: existing.authority.issuedAt,
        expiresAt: existing.authority.expiresAt,
        supersedesContractDigest: existing.authority.supersedesContractDigest
      });
    } catch {
      throw new ConflictError("Existing maintenance request no longer matches current authority.");
    }
    if (reissued.authority.digest !== existing.authorityDigest) {
      throw new ConflictError("Existing maintenance request was issued under different authority.");
    }
  }
}

function renderRequestBody(finding: FactoryMaintenanceFinding): string {
  const candidate = finding.candidate;
  return [
    `Autonomously discovered ${candidate.changeClass} maintenance request.`,
    "",
    "Summary:",
    candidate.summary,
    "",
    "Rationale:",
    candidate.rationale,
    "",
    "Acceptance criteria:",
    ...candidate.acceptanceCriteria.map((criterion) => `- ${criterion}`),
    "",
    "Affected paths:",
    ...candidate.affectedPaths.map((path) => `- ${path}`),
    "",
    "Observed evidence:",
    ...candidate.evidence.map(
      ({ path, lineStart, lineEnd, observation }) =>
        `- ${path}${lineStart === null ? "" : `:${String(lineStart)}-${String(lineEnd)}`}: ${observation}`
    )
  ].join("\n");
}

function result(
  status: "admitted" | "existing",
  snapshot: FactoryPreparationSnapshot
): FactoryMaintenanceDiscoveryAdmissionResult {
  return {
    status,
    taskId: snapshot.request.taskId,
    state: snapshot.state,
    requestDigest: snapshot.requestDigest,
    authorityDigest: snapshot.authorityDigest
  };
}
