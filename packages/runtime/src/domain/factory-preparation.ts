import {
  factoryTimestampSchema,
  type FactoryIntakeRequest,
  type FactoryPlan,
  type FactoryPreparationAuthority,
  type FactoryPreparationBundle,
  type FactoryQualification,
  type FactorySkillPlanEntry,
  type FactorySpecification,
  type ImmutableTaskContract,
  type ProviderId,
  type SkillManifest
} from "@agentlab/contracts";

import {
  factoryBudgetFits,
  factoryCapabilitiesFit,
  factoryRiskRank,
  maximumFactoryRisk
} from "./factory-authority-limits.js";
import type { CanonicalFactoryDocument, FactoryDocumentCodec } from "./factory-documents.js";
import type { FactoryPolicyEngine } from "./factory-policy.js";

export interface FactoryPreparationCompilationInput {
  readonly request: unknown;
  readonly qualification: unknown;
  readonly specification: unknown;
  readonly plan: unknown;
  readonly bundle: unknown;
  readonly contractCreatedAt: string;
  readonly contractExpiresAt: string;
}

export interface FactoryPreparationCompilation {
  readonly request: CanonicalFactoryDocument<FactoryIntakeRequest>;
  readonly authority: CanonicalFactoryDocument<FactoryPreparationAuthority>;
  readonly qualification: CanonicalFactoryDocument<FactoryQualification>;
  readonly specification: CanonicalFactoryDocument<FactorySpecification>;
  readonly plan: CanonicalFactoryDocument<FactoryPlan>;
  readonly bundle: CanonicalFactoryDocument<FactoryPreparationBundle>;
  readonly contract: CanonicalFactoryDocument<ImmutableTaskContract>;
}

export class FactoryPreparationError extends Error {
  public constructor(
    public readonly reasonCode: string,
    message: string
  ) {
    super(message);
    this.name = "FactoryPreparationError";
  }
}

/**
 * Converts untrusted, digest-linked preparation output into one immutable task contract. It may
 * narrow trusted authority or raise risk; it never grants capabilities, policy, or approval power.
 */
export class FactoryPreparationCompiler {
  readonly #authority: CanonicalFactoryDocument<FactoryPreparationAuthority>;

  public constructor(
    private readonly documents: FactoryDocumentCodec,
    private readonly policy: FactoryPolicyEngine,
    authorityInput: unknown
  ) {
    this.#authority = documents.preparationAuthority(authorityInput);
    if (this.#authority.value.policyBundleDigest !== policy.bundleDigest) {
      deny(
        "policy-digest-mismatch",
        "Preparation authority does not pin the active policy bundle."
      );
    }
  }

  public compile(input: FactoryPreparationCompilationInput): FactoryPreparationCompilation {
    const request = this.documents.intakeRequest(input.request);
    const authority = this.#authority;
    const qualification = this.documents.qualification(input.qualification);
    const specification = this.documents.specification(input.specification);
    const plan = this.documents.plan(input.plan);
    const bundle = this.documents.preparationBundle(input.bundle);
    const contractCreatedAt = factoryTimestampSchema.parse(input.contractCreatedAt);
    const contractExpiresAt = factoryTimestampSchema.parse(input.contractExpiresAt);

    this.#assertIdentityChain({ request, authority, qualification, specification, plan, bundle });
    this.#assertTimeline(
      { request, authority, qualification, specification, plan, bundle },
      contractCreatedAt,
      contractExpiresAt
    );

    if (qualification.value.disposition !== "ready") {
      deny(
        `qualification-${qualification.value.disposition}`,
        "Only a ready qualification may produce an execution contract."
      );
    }
    if (specification.value.objective !== qualification.value.objective) {
      deny(
        "objective-drift",
        "The specification objective must preserve the qualified objective exactly."
      );
    }
    for (const includePath of specification.value.scope.includePaths) {
      if (!authority.value.allowedIncludePaths.includes(includePath)) {
        deny(
          "scope-not-authorized",
          `Specification include path ${includePath} is not in the authority allowlist.`
        );
      }
    }

    const selectedSkills = this.#selectedSkills(authority.value, plan.value, bundle.value);
    if (!factoryCapabilitiesFit(plan.value.capabilities, authority.value.capabilityCeiling)) {
      deny("capability-ceiling-exceeded", "The plan requests capability beyond its authority.");
    }
    if (!factoryBudgetFits(plan.value.budget, authority.value.budgetCeiling)) {
      deny("budget-ceiling-exceeded", "The plan requests budget beyond its authority.");
    }
    for (const skill of selectedSkills) {
      if (!factoryCapabilitiesFit(skill.manifest.requestedCapabilities, plan.value.capabilities)) {
        deny(
          "skill-capability-missing",
          `Task capability does not contain the request from skill ${skill.manifest.id}.`
        );
      }
    }

    const workerProfiles = this.#selectedWorkerProfiles(authority.value, plan.value);
    this.#assertProviderCompatibility(selectedSkills, workerProfiles);
    const protectedPaths = unique([
      ...authority.value.protectedPaths,
      ...specification.value.scope.protectedPaths
    ]);
    const scope = {
      includePaths: [...specification.value.scope.includePaths],
      excludePaths: [...specification.value.scope.excludePaths],
      protectedPaths
    };
    const detectedRisk = this.policy.minimumRiskTier({
      scope,
      capabilities: plan.value.capabilities
    });
    const riskTier = maximumFactoryRisk(plan.value.proposedRiskTier, detectedRisk);
    if (factoryRiskRank(riskTier) > factoryRiskRank(authority.value.maximumRiskTier)) {
      deny(
        "risk-ceiling-exceeded",
        `Effective task risk ${riskTier} exceeds authority ${authority.value.maximumRiskTier}.`
      );
    }
    for (const skill of selectedSkills) {
      if (factoryRiskRank(riskTier) > factoryRiskRank(skill.manifest.riskCeiling)) {
        deny(
          "skill-risk-ceiling-exceeded",
          `Skill ${skill.manifest.id} does not permit effective risk ${riskTier}.`
        );
      }
    }

    const controls = this.policy.contractControls(riskTier, authority.value.approvalRoles);
    if (plan.value.capabilities.filesystem === "workspace-write" && !controls.writeAllowed) {
      deny("risk-tier-write-forbidden", `Policy forbids workspace writes at ${riskTier}.`);
    }
    if (plan.value.capabilities.network.mode === "allowlist" && !controls.networkAllowlistAllowed) {
      deny("risk-tier-network-forbidden", `Policy forbids network access at ${riskTier}.`);
    }
    if (plan.value.capabilities.secretRefs.length > 0) {
      deny("agent-secrets-forbidden", "Preparation cannot grant secrets to an agent task.");
    }
    const requiredEvidence = unique([
      "request",
      "qualification",
      "specification",
      "plan",
      ...authority.value.evidenceFloor,
      ...plan.value.requiredEvidence,
      ...selectedSkills.flatMap((skill) => skill.manifest.requiredEvidence)
    ]).sort();
    const skillPlan = selectedSkills.map<FactorySkillPlanEntry>((skill) => ({
      id: skill.manifest.id,
      version: skill.manifest.version,
      packageDigest: skill.manifest.packageDigest,
      phase: skill.phase,
      dependsOn: [...skill.dependsOn]
    }));
    const allowedProviders = unique(workerProfiles.map((profile) => profile.provider));

    const contract = this.documents.taskContract({
      schemaVersion: "agentlab.task-contract.v1",
      taskId: request.value.taskId,
      conversationId: request.value.conversationId,
      supersedesContractDigest: authority.value.supersedesContractDigest,
      createdAt: contractCreatedAt,
      expiresAt: contractExpiresAt,
      deduplicationKey: request.value.deduplicationKey,
      repository: request.value.repository,
      requestSources: request.value.requestSources,
      trigger: request.value.trigger,
      objective: specification.value.objective,
      acceptanceCriteria: specification.value.acceptanceCriteria,
      nonGoals: specification.value.nonGoals,
      scope,
      riskTier,
      skillPlan,
      agentPolicy: {
        allowedProviders,
        workerProfiles,
        minimumIndependentReviews: controls.minimumIndependentReviews,
        requireDistinctReviewSession: controls.requireDistinctReviewSession
      },
      capabilities: plan.value.capabilities,
      budget: plan.value.budget,
      gateProfile: controls.gateProfile,
      requiredEvidence,
      approvals: controls.approvals
    });

    return { request, authority, qualification, specification, plan, bundle, contract };
  }

  #assertIdentityChain(input: Omit<FactoryPreparationCompilation, "contract">): void {
    const taskId = input.request.value.taskId;
    for (const artifact of [
      input.authority,
      input.qualification,
      input.specification,
      input.plan,
      input.bundle
    ]) {
      if (artifact.value.taskId !== taskId) {
        deny("task-id-mismatch", "Preparation artifacts do not identify the same task.");
      }
    }
    if (
      input.authority.value.requestDigest !== input.request.digest ||
      input.qualification.value.requestDigest !== input.request.digest ||
      input.specification.value.requestDigest !== input.request.digest ||
      input.plan.value.requestDigest !== input.request.digest ||
      input.bundle.value.requestDigest !== input.request.digest
    ) {
      deny(
        "request-digest-mismatch",
        "Preparation artifacts do not link the exact intake request."
      );
    }
    if (
      input.specification.value.qualificationDigest !== input.qualification.digest ||
      input.plan.value.qualificationDigest !== input.qualification.digest ||
      input.bundle.value.qualificationDigest !== input.qualification.digest
    ) {
      deny(
        "qualification-digest-mismatch",
        "Specification, plan, and bundle do not link the exact qualification."
      );
    }
    if (
      input.plan.value.specificationDigest !== input.specification.digest ||
      input.bundle.value.specificationDigest !== input.specification.digest
    ) {
      deny("specification-digest-mismatch", "Plan and bundle do not link the exact specification.");
    }
    if (
      input.bundle.value.planDigest !== input.plan.digest ||
      input.bundle.value.authorityDigest !== input.authority.digest
    ) {
      deny(
        "bundle-digest-mismatch",
        "Preparation bundle does not link its exact plan and authority."
      );
    }
    if (input.authority.value.policyBundleDigest !== this.policy.bundleDigest) {
      deny(
        "policy-digest-mismatch",
        "Preparation authority does not pin the active policy bundle."
      );
    }
    if (
      input.authority.value.repository.id !== input.request.value.repository.id ||
      input.authority.value.repository.baseRevision !== input.request.value.repository.baseRevision
    ) {
      deny(
        "repository-mismatch",
        "Preparation authority does not pin the intake repository and base."
      );
    }
  }

  #assertTimeline(
    input: Omit<FactoryPreparationCompilation, "contract">,
    contractCreatedAt: string,
    contractExpiresAt: string
  ): void {
    const authority = input.authority.value;
    if (
      authority.issuedAt < input.request.value.createdAt ||
      input.qualification.value.createdAt < authority.issuedAt ||
      input.specification.value.createdAt < input.qualification.value.createdAt ||
      input.plan.value.createdAt < input.specification.value.createdAt ||
      input.bundle.value.createdAt < input.plan.value.createdAt ||
      contractCreatedAt < input.bundle.value.createdAt
    ) {
      deny("preparation-time-order", "Preparation artifacts are not in causal timestamp order.");
    }
    if (
      input.bundle.value.createdAt >= authority.expiresAt ||
      contractCreatedAt >= authority.expiresAt ||
      contractExpiresAt > authority.expiresAt ||
      contractExpiresAt <= contractCreatedAt
    ) {
      deny("authority-expired", "Contract timing is outside the preparation authority window.");
    }
    const lifetimeSeconds =
      (timestampMilliseconds(contractExpiresAt) - timestampMilliseconds(contractCreatedAt)) / 1_000;
    if (lifetimeSeconds > authority.maximumContractLifetimeSeconds) {
      deny("contract-lifetime-exceeded", "Contract lifetime exceeds the preparation authority.");
    }

    const runByPhase = new Map(input.bundle.value.runs.map((run) => [run.phase, run]));
    const qualificationRun = requiredRun(runByPhase, "qualify");
    const specificationRun = requiredRun(runByPhase, "specify");
    const planRun = requiredRun(runByPhase, "plan");
    if (
      qualificationRun.startedAt < authority.issuedAt ||
      specificationRun.startedAt < input.qualification.value.createdAt ||
      planRun.startedAt < input.specification.value.createdAt ||
      qualificationRun.finishedAt !== input.qualification.value.createdAt ||
      specificationRun.finishedAt !== input.specification.value.createdAt ||
      planRun.finishedAt !== input.plan.value.createdAt ||
      [qualificationRun, specificationRun, planRun].some(
        (run) => run.finishedAt >= authority.expiresAt
      )
    ) {
      deny("preparation-run-time-mismatch", "Preparation runs do not match the artifact timeline.");
    }
  }

  #selectedSkills(
    authority: FactoryPreparationAuthority,
    plan: FactoryPlan,
    bundle: FactoryPreparationBundle
  ): readonly FactoryPreparationAuthority["skills"][number][] {
    const authorized = new Map(authority.skills.map((skill) => [skill.manifest.id, skill]));
    const preparationIds = bundle.runs.map((run) => run.skillId);
    if (preparationIds.some((id) => plan.selectedSkillIds.includes(id))) {
      deny(
        "preparation-skill-reselected",
        "The execution plan may not reselect preparation skills."
      );
    }
    for (const run of bundle.runs) {
      const skill = authorized.get(run.skillId);
      if (skill?.phase !== run.phase || skill.manifest.packageDigest !== run.skillPackageDigest) {
        deny(
          "preparation-skill-not-authorized",
          `Preparation run ${run.phase} does not use its exact authorized skill package.`
        );
      }
    }
    for (const id of plan.selectedSkillIds) {
      const skill = authorized.get(id);
      if (skill === undefined)
        deny("execution-skill-not-authorized", `Skill ${id} is not authorized.`);
      if (skill.phase === "qualify" || skill.phase === "specify" || skill.phase === "plan") {
        deny("execution-skill-wrong-phase", `Skill ${id} is a preparation skill.`);
      }
    }

    const selectedIds = new Set([...preparationIds, ...plan.selectedSkillIds]);
    for (const id of selectedIds) {
      const skill = authorized.get(id);
      if (skill === undefined) deny("skill-not-authorized", `Skill ${id} is not authorized.`);
      for (const dependency of skill.dependsOn) {
        if (!selectedIds.has(dependency)) {
          deny(
            "skill-dependency-not-selected",
            `Selected skill ${id} is missing dependency ${dependency}.`
          );
        }
      }
    }
    const selected = topologicalSkills(authority.skills, selectedIds);
    const phases = new Set(selected.map((skill) => skill.phase));
    for (const phase of ["implement", "verify", "review"] as const) {
      if (!phases.has(phase)) {
        deny("required-execution-phase-missing", `Execution plan has no ${phase} skill.`);
      }
    }
    if (plan.budget.maxRepairAttempts > 0 && !phases.has("repair")) {
      deny("repair-skill-missing", "A non-zero repair budget requires a repair skill.");
    }
    return selected;
  }

  #selectedWorkerProfiles(
    authority: FactoryPreparationAuthority,
    plan: FactoryPlan
  ): ImmutableTaskContract["agentPolicy"]["workerProfiles"] {
    const authorized = new Map(authority.workerProfiles.map((profile) => [profile.id, profile]));
    return plan.selectedWorkerProfileIds.map((id) => {
      const profile = authorized.get(id);
      if (profile === undefined) {
        deny("worker-profile-not-authorized", `Worker profile ${id} is not authorized.`);
      }
      return profile;
    });
  }

  #assertProviderCompatibility(
    skills: readonly FactoryPreparationAuthority["skills"][number][],
    profiles: ImmutableTaskContract["agentPolicy"]["workerProfiles"]
  ): void {
    const roleForPhase = {
      implement: "implementer",
      review: "reviewer",
      repair: "repairer"
    } as const;
    for (const skill of skills) {
      if (!(skill.phase in roleForPhase)) continue;
      const phase = skill.phase as keyof typeof roleForPhase;
      const role = roleForPhase[phase];
      const compatible = profiles.some(
        (profile) =>
          profile.roles.includes(role) && providerPermitted(skill.manifest, profile.provider)
      );
      if (!compatible) {
        deny(
          "skill-provider-unavailable",
          `No selected ${role} profile is compatible with skill ${skill.manifest.id}.`
        );
      }
    }
  }
}

function topologicalSkills(
  skills: FactoryPreparationAuthority["skills"],
  selectedIds: ReadonlySet<string>
): readonly FactoryPreparationAuthority["skills"][number][] {
  const byId = new Map(skills.map((skill) => [skill.manifest.id, skill]));
  const emitted = new Set<string>();
  const ordered: FactoryPreparationAuthority["skills"][number][] = [];
  const visit = (id: string): void => {
    if (emitted.has(id)) return;
    const skill = byId.get(id);
    if (skill === undefined) deny("skill-not-authorized", `Skill ${id} is not authorized.`);
    for (const dependency of skill.dependsOn) visit(dependency);
    emitted.add(id);
    if (selectedIds.has(id)) ordered.push(skill);
  };
  for (const skill of skills) {
    if (selectedIds.has(skill.manifest.id)) visit(skill.manifest.id);
  }
  return ordered;
}

function providerPermitted(manifest: SkillManifest, provider: ProviderId): boolean {
  return (
    manifest.providerCompatibility.mode === "any-supported" ||
    manifest.providerCompatibility.providers.includes(provider)
  );
}

function requiredRun(
  runs: ReadonlyMap<string, FactoryPreparationBundle["runs"][number]>,
  phase: "qualify" | "specify" | "plan"
): FactoryPreparationBundle["runs"][number] {
  const run = runs.get(phase);
  if (run === undefined) deny("preparation-run-missing", `Preparation bundle has no ${phase} run.`);
  return run;
}

function timestampMilliseconds(timestamp: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})Z$/u.exec(timestamp);
  if (match === null) deny("invalid-timestamp", "Expected a canonical UTC millisecond timestamp.");
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millisecond = Number(match[7]);
  const adjustedYear = month <= 2 ? year - 1 : year;
  const era = Math.floor(adjustedYear / 400);
  const yearOfEra = adjustedYear - era * 400;
  const adjustedMonth = month + (month > 2 ? -3 : 9);
  const dayOfYear = Math.floor((153 * adjustedMonth + 2) / 5) + day - 1;
  const dayOfEra =
    yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  const daysSinceEpoch = era * 146_097 + dayOfEra - 719_468;
  return (((daysSinceEpoch * 24 + hour) * 60 + minute) * 60 + second) * 1_000 + millisecond;
}

function unique<Value>(values: readonly Value[]): Value[] {
  return [...new Set(values)];
}

function deny(reasonCode: string, message: string): never {
  throw new FactoryPreparationError(reasonCode, message);
}
