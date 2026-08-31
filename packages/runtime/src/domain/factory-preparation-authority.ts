import {
  factoryPreparationAuthorityGrantSchema,
  factoryTimestampSchema,
  sha256DigestSchema,
  type FactoryIntakeRequest,
  type FactoryPreparationAuthority,
  type FactoryPreparationAuthorityGrant,
  type FactoryPreparationPhase,
  type ProviderId
} from "@agentlab/contracts";

import { factoryBudgetFits, factoryCapabilitiesFit } from "./factory-authority-limits.js";
import type { CanonicalFactoryDocument, FactoryDocumentCodec } from "./factory-documents.js";
import type { FactoryPolicyEngine } from "./factory-policy.js";
import { factoryTimestampDifferenceSeconds } from "./factory-timestamp.js";

export interface FactoryPreparationAuthorityIssueInput {
  readonly request: unknown;
  readonly issuedAt: unknown;
  readonly expiresAt: unknown;
  readonly supersedesContractDigest: unknown;
}

export interface IssuedFactoryPreparationAuthority {
  readonly request: CanonicalFactoryDocument<FactoryIntakeRequest>;
  readonly authority: CanonicalFactoryDocument<FactoryPreparationAuthority>;
}

export class FactoryPreparationAuthorityError extends Error {
  public constructor(
    public readonly reasonCode: string,
    message: string
  ) {
    super(message);
    this.name = "FactoryPreparationAuthorityError";
  }
}

/** Trusted boundary that derives task-scoped authority from repository-owned policy configuration. */
export class FactoryPreparationAuthorityIssuer {
  readonly #grant: FactoryPreparationAuthorityGrant;

  public constructor(
    private readonly documents: FactoryDocumentCodec,
    private readonly policy: FactoryPolicyEngine,
    grantInput: unknown
  ) {
    this.#grant = factoryPreparationAuthorityGrantSchema.parse(grantInput);
    assertFactoryPreparationAuthorityPolicy(this.#grant);
  }

  public issue(input: FactoryPreparationAuthorityIssueInput): IssuedFactoryPreparationAuthority {
    const request = this.documents.intakeRequest(input.request);
    const issuedAt = factoryTimestampSchema.parse(input.issuedAt);
    const expiresAt = factoryTimestampSchema.parse(input.expiresAt);
    const supersedesContractDigest = sha256DigestSchema
      .nullable()
      .parse(input.supersedesContractDigest);
    const lifetimeSeconds = factoryTimestampDifferenceSeconds(issuedAt, expiresAt);
    if (issuedAt < request.value.createdAt) {
      deny(
        "authority-predates-request",
        "Preparation authority cannot predate its intake request."
      );
    }
    if (lifetimeSeconds <= 0) {
      deny("invalid-authority-lifetime", "Preparation authority must have a positive lifetime.");
    }
    if (lifetimeSeconds > this.#grant.maximumAuthorityLifetimeSeconds) {
      deny(
        "authority-lifetime-exceeded",
        "Preparation authority lifetime exceeds the repository grant."
      );
    }

    const authority = this.documents.preparationAuthority({
      schemaVersion: "agentlab.preparation-authority.v2",
      authorityId: this.#grant.authorityId,
      version: this.#grant.version,
      taskId: request.value.taskId,
      requestDigest: request.digest,
      supersedesContractDigest,
      issuedAt,
      expiresAt,
      policyBundleDigest: this.policy.bundleDigest,
      repository: request.value.repository,
      allowedIncludePaths: [...this.#grant.allowedIncludePaths],
      protectedPaths: [...this.#grant.protectedPaths],
      maximumRiskTier: this.#grant.maximumRiskTier,
      skills: this.#grant.skills,
      preparationProfiles: this.#grant.preparationProfiles,
      workerProfiles: this.#grant.workerProfiles,
      capabilityCeiling: this.#grant.capabilityCeiling,
      budgetCeiling: this.#grant.budgetCeiling,
      evidenceFloor: [...this.#grant.evidenceFloor],
      approvalRoles: this.#grant.approvalRoles,
      maximumPreparationAttempts: this.#grant.maximumPreparationAttempts,
      maximumContractLifetimeSeconds: this.#grant.maximumContractLifetimeSeconds
    });
    return { request, authority };
  }
}

type FactoryPreparationAuthorityPolicy = Pick<
  FactoryPreparationAuthorityGrant,
  "skills" | "preparationProfiles" | "workerProfiles"
>;

export function assertFactoryPreparationAuthorityPolicy(
  grant: FactoryPreparationAuthorityPolicy
): void {
  const skills = new Map(grant.skills.map((skill) => [skill.manifest.id, skill]));
  const selectedPreparationSkills = new Set(
    grant.preparationProfiles.map((profile) => profile.skillId)
  );
  const preparationSkillByPhase = new Map(
    grant.preparationProfiles.map((profile) => [profile.phase, profile.skillId])
  );
  if (selectedPreparationSkills.size !== grant.preparationProfiles.length) {
    deny(
      "preparation-skill-reused",
      "Each preparation phase requires a distinct pinned skill package."
    );
  }
  const allWorkerIds = [
    ...grant.preparationProfiles.map((profile) => profile.id),
    ...grant.workerProfiles.map((profile) => profile.id)
  ];
  if (new Set(allWorkerIds).size !== allWorkerIds.length) {
    deny("worker-id-reused", "Preparation and execution worker identities must be distinct.");
  }

  for (const profile of grant.preparationProfiles) {
    const skill = skills.get(profile.skillId);
    if (skill?.phase !== profile.phase) {
      deny(
        "preparation-skill-mismatch",
        `Preparation profile ${profile.id} does not pin an authorized ${profile.phase} skill.`
      );
    }
    if (!providerPermitted(skill.manifest.providerCompatibility, profile.provider)) {
      deny(
        "preparation-provider-incompatible",
        `Preparation profile ${profile.id} uses a provider forbidden by its skill.`
      );
    }
    if (!factoryCapabilitiesFit(skill.manifest.requestedCapabilities, profile.capabilities)) {
      deny(
        "preparation-capability-missing",
        `Preparation profile ${profile.id} cannot satisfy its skill capabilities.`
      );
    }
    if (!factoryBudgetFits(profile.budget, skill.manifest.budgetCeiling)) {
      deny(
        "preparation-budget-exceeded",
        `Preparation profile ${profile.id} exceeds its skill budget ceiling.`
      );
    }
    assertPreparationDependencies(
      profile.phase,
      skill.dependsOn,
      selectedPreparationSkills,
      skills,
      preparationSkillByPhase
    );
  }
}

function assertPreparationDependencies(
  phase: FactoryPreparationPhase,
  dependencyIds: readonly string[],
  selectedPreparationSkills: ReadonlySet<string>,
  skills: ReadonlyMap<string, FactoryPreparationAuthorityPolicy["skills"][number]>,
  preparationSkillByPhase: ReadonlyMap<FactoryPreparationPhase, string>
): void {
  for (const dependencyId of dependencyIds) {
    const dependency = skills.get(dependencyId);
    const dependencyRank = dependency === undefined ? null : preparationPhaseRank(dependency.phase);
    if (
      dependency === undefined ||
      !selectedPreparationSkills.has(dependencyId) ||
      dependencyRank === null ||
      dependencyRank >= requiredPreparationPhaseRank(phase)
    ) {
      deny(
        "preparation-dependency-invalid",
        `Preparation phase ${phase} depends on an unselected or non-predecessor skill.`
      );
    }
  }
  const predecessorPhase = directPredecessorPhase(phase);
  const predecessorSkill =
    predecessorPhase === null ? null : preparationSkillByPhase.get(predecessorPhase);
  if (predecessorPhase !== null && !dependencyIds.includes(predecessorSkill ?? "")) {
    deny(
      "preparation-dependency-missing",
      `Preparation phase ${phase} must depend on its ${predecessorPhase} skill.`
    );
  }
}

function directPredecessorPhase(phase: FactoryPreparationPhase): FactoryPreparationPhase | null {
  if (phase === "qualify") return null;
  return phase === "specify" ? "qualify" : "specify";
}

function preparationPhaseRank(phase: string): number | null {
  if (phase === "qualify") return 0;
  if (phase === "specify") return 1;
  if (phase === "plan") return 2;
  return null;
}

function requiredPreparationPhaseRank(phase: FactoryPreparationPhase): number {
  if (phase === "qualify") return 0;
  if (phase === "specify") return 1;
  return 2;
}

function providerPermitted(
  compatibility:
    | { readonly mode: "any-supported" }
    | { readonly mode: "allowlist"; readonly providers: readonly ProviderId[] },
  provider: ProviderId
): boolean {
  return compatibility.mode === "any-supported" || compatibility.providers.includes(provider);
}

function deny(reasonCode: string, message: string): never {
  throw new FactoryPreparationAuthorityError(reasonCode, message);
}
