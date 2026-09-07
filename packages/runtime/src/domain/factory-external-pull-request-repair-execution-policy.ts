import type {
  FactoryExternalPullRequestRepairExecutionPolicy,
  ProviderId
} from "@agentlab/contracts";

import {
  factoryBudgetFits,
  factoryCapabilitiesFit,
  factoryRiskRank
} from "./factory-authority-limits.js";
import type { FactorySkillSource, ResolvedFactorySkill } from "./factory-skill.js";

export interface ResolvedExternalPullRequestRepairer {
  readonly profile: FactoryExternalPullRequestRepairExecutionPolicy["repairerProfile"];
  readonly skills: readonly ResolvedFactorySkill[];
}

/** Resolves the complete repair skill closure before reading untrusted review evidence. */
export async function resolveExternalPullRequestRepairer(
  source: FactorySkillSource,
  policy: FactoryExternalPullRequestRepairExecutionPolicy
): Promise<ResolvedExternalPullRequestRepairer> {
  const profile = policy.repairerProfile;
  const skills = await Promise.all(profile.skillDigests.map((digest) => source.resolve(digest)));
  for (const skill of skills)
    validateSkill(skill, profile.provider, profile.capabilities, profile.budget);
  const available = new Set(profile.skillDigests);
  for (const skill of skills) {
    if (skill.manifest.dependencyDigests.some((digest) => !available.has(digest))) {
      throw new Error(`External repair skill ${skill.manifest.id} has an unpinned dependency.`);
    }
  }
  return { profile, skills };
}

function validateSkill(
  skill: ResolvedFactorySkill,
  provider: ProviderId,
  capabilities: FactoryExternalPullRequestRepairExecutionPolicy["repairerProfile"]["capabilities"],
  budget: FactoryExternalPullRequestRepairExecutionPolicy["repairerProfile"]["budget"]
): void {
  if (
    skill.packageDigest !== skill.manifest.packageDigest ||
    !skill.manifest.roles.includes("repairer") ||
    !skill.manifest.allowedFromStates.includes("repairing") ||
    !skill.manifest.allowedToStates.includes("verifying") ||
    factoryRiskRank(skill.manifest.riskCeiling) < factoryRiskRank("R1")
  ) {
    throw new Error(`Skill ${skill.manifest.id} is not authorized for external PR repair.`);
  }
  const compatibility = skill.manifest.providerCompatibility;
  if (compatibility.mode === "allowlist" && !compatibility.providers.includes(provider)) {
    throw new Error(`External repair skill ${skill.manifest.id} forbids provider ${provider}.`);
  }
  if (!factoryCapabilitiesFit(skill.manifest.requestedCapabilities, capabilities)) {
    throw new Error(`External repair skill ${skill.manifest.id} exceeds repairer capabilities.`);
  }
  if (!factoryBudgetFits(budget, skill.manifest.budgetCeiling)) {
    throw new Error(`External repairer ${provider} exceeds skill ${skill.manifest.id} budget.`);
  }
}
