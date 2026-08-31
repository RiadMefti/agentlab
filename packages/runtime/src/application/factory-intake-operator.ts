import {
  factoryIdentifierSchema,
  factoryIntakeSubmissionSchema,
  factoryPreparationAuthorityGrantSchema,
  factoryTimestampSchema,
  sha256DigestSchema,
  type FactoryIntakeSubmission,
  type FactoryPreparationAuthorityGrant,
  type FactoryRiskTier,
  type FactoryPreparationState,
  type GitObjectId,
  type ProviderId,
  type Sha256Digest
} from "@agentlab/contracts";
import { z } from "zod";

import type { ConversationRepository } from "../domain/conversation-repository.js";
import { ConflictError } from "../domain/errors.js";
import type { FactoryCostAccounting } from "../domain/factory-cost-accounting.js";
import type { FactoryIntakeDeduplicator } from "../domain/factory-intake-deduplicator.js";
import type {
  FactoryPreparationRepository,
  FactoryPreparationSnapshot
} from "../domain/factory-preparation-repository.js";
import type { FactoryRepositoryRevisionReader } from "../domain/factory-repository-revision.js";
import { factoryTimestampAddSeconds } from "../domain/factory-timestamp.js";
import type {
  FactoryPreparationAuthorityIssuerPort,
  FactoryPreparationIntakeService
} from "./factory-preparation-intake-service.js";
import type {
  FactorySkillPackageInventoryEntry,
  FactorySkillPackagePublisher
} from "./factory-skill-package-publisher.js";

const registerCommandSchema = z
  .object({
    submission: factoryIntakeSubmissionSchema,
    expectedPolicyBundleDigest: sha256DigestSchema,
    trigger: z.enum(["manual", "scheduled"]).default("manual"),
    confirmation: z.enum(["register-request", "register-scheduled-request"])
  })
  .strict()
  .superRefine((command, context) => {
    const expected =
      command.trigger === "scheduled" ? "register-scheduled-request" : "register-request";
    if (command.confirmation !== expected) {
      context.addIssue({
        code: "custom",
        path: ["confirmation"],
        message: "Factory intake confirmation does not match its execution trigger."
      });
    }
  });

export interface FactoryIntakePreflight {
  readonly schemaVersion: "agentlab.intake-preflight.v1";
  readonly status: "ready" | "blocked";
  readonly repository: {
    readonly repositoryId: string;
    readonly baseRevision: GitObjectId;
  };
  readonly conversation: {
    readonly conversationId: string;
    readonly active: boolean;
    readonly workspaceMatches: boolean;
  };
  readonly policyBundleDigest: Sha256Digest;
  readonly authority: {
    readonly authorityId: string;
    readonly version: string;
    readonly maximumRiskTier: FactoryRiskTier;
    readonly lifetimeSeconds: number;
  };
  readonly skillPackages: readonly FactorySkillPackageInventoryEntry[];
  readonly reasonCodes: readonly string[];
}

export interface FactoryIntakeRegistrationResult {
  readonly schemaVersion: "agentlab.intake-registration-result.v1";
  readonly status: "registered" | "existing";
  readonly taskId: string;
  readonly state: FactoryPreparationState;
  readonly requestKind: "feature" | "bug";
  readonly conversationId: string;
  readonly repository: {
    readonly repositoryId: string;
    readonly baseRevision: GitObjectId;
  };
  readonly policyBundleDigest: Sha256Digest;
  readonly deduplicationKey: Sha256Digest;
  readonly requestDigest: Sha256Digest;
  readonly authorityDigest: Sha256Digest;
  readonly skillPackageDigests: readonly Sha256Digest[];
}

export interface FactoryIntakeOperatorDependencies {
  readonly repositoryId: string;
  readonly repositoryRoot: string;
  readonly conversationId: string;
  readonly operatorId: string;
  readonly authorityLifetimeSeconds: number;
  readonly policyBundleDigest: Sha256Digest;
  readonly grant: FactoryPreparationAuthorityGrant;
  readonly supportedProviders: readonly ProviderId[];
  readonly conversations: Pick<ConversationRepository, "findById">;
  readonly revisions: FactoryRepositoryRevisionReader;
  readonly preparations: Pick<FactoryPreparationRepository, "findByDeduplicationKey">;
  readonly deduplicator: FactoryIntakeDeduplicator;
  readonly skills: Pick<FactorySkillPackagePublisher, "inventory" | "publish">;
  readonly authorityIssuer: FactoryPreparationAuthorityIssuerPort;
  readonly intake: Pick<FactoryPreparationIntakeService, "register">;
  readonly costAccounting: Pick<FactoryCostAccounting, "preflight">;
  readonly now: () => string;
  readonly createId: () => string;
}

/** Trusted local boundary that derives identity, base revision, policy, and authority from config. */
export class FactoryIntakeOperator {
  readonly #repositoryId: string;
  readonly #conversationId: string;
  readonly #operatorId: string;
  readonly #grant: FactoryPreparationAuthorityGrant;
  readonly #supportedProviders: ReadonlySet<ProviderId>;

  public constructor(private readonly dependencies: FactoryIntakeOperatorDependencies) {
    this.#repositoryId = factoryIdentifierSchema.parse(dependencies.repositoryId);
    this.#conversationId = z.uuid().parse(dependencies.conversationId);
    this.#operatorId = factoryIdentifierSchema.parse(dependencies.operatorId);
    this.#grant = factoryPreparationAuthorityGrantSchema.parse(dependencies.grant);
    this.#supportedProviders = new Set(dependencies.supportedProviders);
    if (
      !Number.isSafeInteger(dependencies.authorityLifetimeSeconds) ||
      dependencies.authorityLifetimeSeconds < 60 ||
      dependencies.authorityLifetimeSeconds > this.#grant.maximumAuthorityLifetimeSeconds
    ) {
      throw new Error("Factory intake authority lifetime exceeds its repository grant.");
    }
    sha256DigestSchema.parse(dependencies.policyBundleDigest);
  }

  public async preflight(): Promise<FactoryIntakePreflight> {
    const [conversation, baseRevision] = await Promise.all([
      this.dependencies.conversations.findById(this.#conversationId),
      this.dependencies.revisions.currentRevision(this.dependencies.repositoryRoot)
    ]);
    const active = conversation?.lifecycleState === "active";
    const workspaceMatches = conversation?.workspacePath === this.dependencies.repositoryRoot;
    const reasonCodes: string[] = [];
    if (conversation === null) reasonCodes.push("conversation-not-found");
    else {
      if (!active) reasonCodes.push("conversation-not-active");
      if (!workspaceMatches) reasonCodes.push("conversation-workspace-mismatch");
    }
    if (this.#grant.maximumRiskTier !== "R1") {
      reasonCodes.push("authority-risk-tier-unsupported");
    }
    if (!this.#profilesUseSupportedProviders()) {
      reasonCodes.push("authority-provider-unsupported");
    }
    if (!this.#costPolicyComplete()) reasonCodes.push("cost-policy-incomplete");
    const uniqueReasons = [...new Set(reasonCodes)].sort();
    return {
      schemaVersion: "agentlab.intake-preflight.v1",
      status: uniqueReasons.length === 0 ? "ready" : "blocked",
      repository: { repositoryId: this.#repositoryId, baseRevision },
      conversation: {
        conversationId: this.#conversationId,
        active,
        workspaceMatches
      },
      policyBundleDigest: this.dependencies.policyBundleDigest,
      authority: {
        authorityId: this.#grant.authorityId,
        version: this.#grant.version,
        maximumRiskTier: this.#grant.maximumRiskTier,
        lifetimeSeconds: this.dependencies.authorityLifetimeSeconds
      },
      skillPackages: this.dependencies.skills.inventory(),
      reasonCodes: uniqueReasons
    };
  }

  public async register(input: unknown): Promise<FactoryIntakeRegistrationResult> {
    const command = registerCommandSchema.parse(input);
    const readiness = await this.preflight();
    if (readiness.status !== "ready") {
      throw new ConflictError(`Factory intake is blocked: ${readiness.reasonCodes.join(", ")}.`);
    }
    if (command.expectedPolicyBundleDigest !== this.dependencies.policyBundleDigest) {
      throw new ConflictError("Factory intake policy digest changed after operator review.");
    }
    const deduplicationKey = this.dependencies.deduplicator.key({
      repositoryId: this.#repositoryId,
      requestKind: command.submission.kind,
      sourceRef: command.submission.sourceRef
    });
    const existing = await this.dependencies.preparations.findByDeduplicationKey(
      this.#repositoryId,
      deduplicationKey
    );
    if (existing !== null) {
      this.#assertExistingMatches(existing, command.submission, deduplicationKey, command.trigger);
      await this.dependencies.skills.publish();
      return this.#result("existing", command.submission.kind, existing);
    }

    const createdAt = factoryTimestampSchema.parse(this.dependencies.now());
    const request = {
      schemaVersion: "agentlab.intake-request.v1" as const,
      taskId: z.uuid().parse(this.dependencies.createId()),
      conversationId: this.#conversationId,
      createdAt,
      deduplicationKey,
      repository: {
        id: this.#repositoryId,
        baseRevision: readiness.repository.baseRevision
      },
      requestSources: [localSource(command.submission)],
      trigger: command.trigger,
      requester: {
        kind: "human" as const,
        role: "requester" as const,
        id: this.#operatorId,
        sessionId: null
      },
      title: command.submission.title,
      body: command.submission.body
    };
    await this.dependencies.skills.publish();
    const snapshot = await this.dependencies.intake.register({
      request,
      issuedAt: createdAt,
      expiresAt: factoryTimestampAddSeconds(createdAt, this.dependencies.authorityLifetimeSeconds),
      supersedesContractDigest: null,
      correlationId: z.uuid().parse(this.dependencies.createId())
    });
    return this.#result("registered", command.submission.kind, snapshot);
  }

  #profilesUseSupportedProviders(): boolean {
    return [...this.#grant.preparationProfiles, ...this.#grant.workerProfiles].every((profile) =>
      this.#supportedProviders.has(profile.provider)
    );
  }

  #costPolicyComplete(): boolean {
    try {
      for (const profile of [...this.#grant.preparationProfiles, ...this.#grant.workerProfiles]) {
        this.dependencies.costAccounting.preflight({
          policyBundleDigest: this.dependencies.policyBundleDigest,
          provider: profile.provider,
          model: profile.model
        });
      }
      return true;
    } catch {
      return false;
    }
  }

  #assertExistingMatches(
    existing: FactoryPreparationSnapshot,
    submission: FactoryIntakeSubmission,
    deduplicationKey: Sha256Digest,
    trigger: "manual" | "scheduled"
  ): void {
    const request = existing.request;
    const expectedSource = localSource(submission);
    const actualSource = request.requestSources[0];
    if (
      request.conversationId !== this.#conversationId ||
      request.deduplicationKey !== deduplicationKey ||
      request.repository.id !== this.#repositoryId ||
      request.requestSources.length !== 1 ||
      actualSource?.kind !== expectedSource.kind ||
      actualSource.ref !== expectedSource.ref ||
      request.trigger !== trigger ||
      request.requester.kind !== "human" ||
      request.requester.role !== "requester" ||
      request.requester.id !== this.#operatorId ||
      request.requester.sessionId !== null ||
      request.title !== submission.title ||
      request.body !== submission.body
    ) {
      throw new ConflictError(
        "Factory request identity already exists with different immutable content."
      );
    }
    let reissued;
    try {
      reissued = this.dependencies.authorityIssuer.issue({
        request,
        issuedAt: existing.authority.issuedAt,
        expiresAt: existing.authority.expiresAt,
        supersedesContractDigest: existing.authority.supersedesContractDigest
      });
    } catch {
      throw new ConflictError("Existing factory request no longer matches current authority.");
    }
    if (reissued.authority.digest !== existing.authorityDigest) {
      throw new ConflictError("Existing factory request was issued under different authority.");
    }
  }

  #result(
    status: "registered" | "existing",
    requestKind: "feature" | "bug",
    snapshot: FactoryPreparationSnapshot
  ): FactoryIntakeRegistrationResult {
    return {
      schemaVersion: "agentlab.intake-registration-result.v1",
      status,
      taskId: snapshot.request.taskId,
      state: snapshot.state,
      requestKind,
      conversationId: snapshot.request.conversationId,
      repository: {
        repositoryId: snapshot.request.repository.id,
        baseRevision: snapshot.request.repository.baseRevision
      },
      policyBundleDigest: snapshot.authority.policyBundleDigest,
      deduplicationKey: snapshot.request.deduplicationKey,
      requestDigest: snapshot.requestDigest,
      authorityDigest: snapshot.authorityDigest,
      skillPackageDigests: this.dependencies.skills
        .inventory()
        .map(({ packageDigest }) => packageDigest)
    };
  }
}

function localSource(submission: FactoryIntakeSubmission): {
  readonly kind: "local";
  readonly ref: string;
} {
  return { kind: "local", ref: `${submission.kind}:${submission.sourceRef}` };
}
