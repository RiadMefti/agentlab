import type {
  FactoryActorRole,
  FactoryBudget,
  FactoryCapabilityGrant,
  FactoryPreparationAuthority,
  FactoryPreparationPhase,
  FactorySkillPackage,
  FactoryTaskState,
  ImmutableTaskContract,
  ProviderId,
  Sha256Digest,
  SkillManifest
} from "@agentlab/contracts";

import {
  factoryBudgetFits,
  factoryCapabilitiesFit,
  factoryRiskRank,
  mergeFactoryCapabilities,
  minimumFactoryBudget
} from "./factory-authority-limits.js";

export type FactorySkillPhase = ImmutableTaskContract["skillPlan"][number]["phase"];

export interface ResolvedFactorySkill {
  readonly packageDigest: Sha256Digest;
  readonly package: FactorySkillPackage;
  readonly manifest: SkillManifest;
  readonly instructions: string;
}

export interface FactorySkillSource {
  resolve(packageDigest: Sha256Digest): Promise<ResolvedFactorySkill>;
}

export interface FactorySkillSelection {
  readonly phase: FactorySkillPhase;
  readonly skills: readonly ResolvedFactorySkill[];
  readonly capabilities: FactoryCapabilityGrant;
  readonly budget: FactoryBudget;
}

export async function resolveFactoryPreparationSkill(
  source: FactorySkillSource,
  authority: FactoryPreparationAuthority,
  phase: FactoryPreparationPhase
): Promise<ResolvedFactorySkill> {
  const profile = authority.preparationProfiles.find((candidate) => candidate.phase === phase);
  const authorized = authority.skills.find(
    (candidate) => candidate.manifest.id === profile?.skillId
  );
  if (profile === undefined || authorized?.phase !== phase) {
    throw new Error(`Preparation authority has no pinned ${phase} skill and worker profile.`);
  }
  const resolved = await source.resolve(authorized.manifest.packageDigest);
  if (
    resolved.packageDigest !== authorized.manifest.packageDigest ||
    !sameJsonValue(resolved.manifest, authorized.manifest)
  ) {
    throw new Error(`Preparation skill ${authorized.manifest.id} does not match its authority.`);
  }
  const compatibility = resolved.manifest.providerCompatibility;
  if (compatibility.mode === "allowlist" && !compatibility.providers.includes(profile.provider)) {
    throw new Error(`Preparation skill ${resolved.manifest.id} forbids its pinned provider.`);
  }
  if (!factoryCapabilitiesFit(resolved.manifest.requestedCapabilities, profile.capabilities)) {
    throw new Error(`Preparation skill ${resolved.manifest.id} exceeds its worker capabilities.`);
  }
  if (!factoryBudgetFits(profile.budget, resolved.manifest.budgetCeiling)) {
    throw new Error(`Preparation worker ${profile.id} exceeds its skill budget ceiling.`);
  }
  return resolved;
}

const phasePolicy: Readonly<
  Record<
    FactorySkillPhase,
    {
      readonly role: FactoryActorRole;
      readonly from: FactoryTaskState;
      readonly to: FactoryTaskState;
    }
  >
> = {
  qualify: { role: "qualifier", from: "intake", to: "qualified" },
  specify: { role: "specifier", from: "qualified", to: "specified" },
  plan: { role: "planner", from: "specified", to: "planned" },
  implement: { role: "implementer", from: "executing", to: "verifying" },
  verify: { role: "gate-runner", from: "verifying", to: "reviewing" },
  review: { role: "reviewer", from: "reviewing", to: "pr-proposed" },
  repair: { role: "repairer", from: "repairing", to: "verifying" }
};

/** Resolves the complete immutable skill DAG before any worker is started. */
export async function resolveFactorySkillPlan(
  source: FactorySkillSource,
  contract: ImmutableTaskContract
): Promise<readonly ResolvedFactorySkill[]> {
  const byId = new Map(contract.skillPlan.map((entry) => [entry.id, entry]));
  const resolved = new Map<string, ResolvedFactorySkill>();
  for (const entry of contract.skillPlan) {
    const skill = await source.resolve(entry.packageDigest);
    if (
      skill.packageDigest !== entry.packageDigest ||
      skill.manifest.packageDigest !== entry.packageDigest ||
      skill.manifest.id !== entry.id ||
      skill.manifest.version !== entry.version
    ) {
      throw new Error(`Skill package ${entry.id} does not match the immutable task plan.`);
    }
    const policy = phasePolicy[entry.phase];
    if (
      !skill.manifest.roles.includes(policy.role) ||
      !skill.manifest.allowedFromStates.includes(policy.from) ||
      !skill.manifest.allowedToStates.includes(policy.to)
    ) {
      throw new Error(`Skill ${entry.id} is not authorized for its planned phase.`);
    }
    if (factoryRiskRank(contract.riskTier) > factoryRiskRank(skill.manifest.riskCeiling)) {
      throw new Error(`Skill ${entry.id} does not permit task risk ${contract.riskTier}.`);
    }
    if (!factoryCapabilitiesFit(skill.manifest.requestedCapabilities, contract.capabilities)) {
      throw new Error(`Skill ${entry.id} requests capabilities outside the task contract.`);
    }
    const dependencyDigests = entry.dependsOn.map((id) => {
      const dependency = byId.get(id);
      if (dependency === undefined) throw new Error(`Skill ${entry.id} has an unknown dependency.`);
      return dependency.packageDigest;
    });
    if (!sameSet(skill.manifest.dependencyDigests, dependencyDigests)) {
      throw new Error(`Skill ${entry.id} dependency digests do not match the task DAG.`);
    }
    resolved.set(entry.id, skill);
  }
  return topologicalSkillIds(contract).map((id) => {
    const skill = resolved.get(id);
    if (skill === undefined) throw new Error(`Resolved skill ${id} disappeared.`);
    return skill;
  });
}

export function selectFactorySkills(input: {
  readonly contract: ImmutableTaskContract;
  readonly resolved: readonly ResolvedFactorySkill[];
  readonly phase: FactorySkillPhase;
  readonly provider: ProviderId;
}): FactorySkillSelection {
  const phaseIds = new Set(
    input.contract.skillPlan.filter(({ phase }) => phase === input.phase).map(({ id }) => id)
  );
  const phaseSkills = input.resolved.filter(({ manifest }) => phaseIds.has(manifest.id));
  const incompatible = phaseSkills.filter(({ manifest }) => {
    const compatibility = manifest.providerCompatibility;
    return compatibility.mode === "allowlist" && !compatibility.providers.includes(input.provider);
  });
  if (incompatible.length > 0) {
    throw new Error(
      `Planned skill ${incompatible[0]?.manifest.id ?? "unknown"} is not compatible with provider ${input.provider}.`
    );
  }
  if (phaseSkills.length === 0) throw new Error(`Task has no skill for phase ${input.phase}.`);
  return {
    phase: input.phase,
    skills: phaseSkills,
    capabilities: phaseSkills
      .map(({ manifest }) => manifest.requestedCapabilities)
      .reduce(mergeFactoryCapabilities),
    budget: phaseSkills
      .map(({ manifest }) => manifest.budgetCeiling)
      .reduce(minimumFactoryBudget, input.contract.budget)
  };
}

function topologicalSkillIds(contract: ImmutableTaskContract): readonly string[] {
  const entries = new Map(contract.skillPlan.map((entry) => [entry.id, entry]));
  const emitted = new Set<string>();
  const result: string[] = [];
  const visit = (id: string): void => {
    if (emitted.has(id)) return;
    const entry = entries.get(id);
    if (entry === undefined) throw new Error(`Unknown skill ${id}.`);
    for (const dependency of entry.dependsOn) visit(dependency);
    emitted.add(id);
    result.push(id);
  };
  for (const entry of contract.skillPlan) visit(entry.id);
  return result;
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}

function sameJsonValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => sameJsonValue(value, right[index]))
    );
  }
  if (!isJsonObject(left) || !isJsonObject(right)) return false;
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.prototype.hasOwnProperty.call(right, key) && sameJsonValue(left[key], right[key])
    )
  );
}

function isJsonObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
