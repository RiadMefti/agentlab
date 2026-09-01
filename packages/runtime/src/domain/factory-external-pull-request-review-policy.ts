import type { FactoryExternalPullRequestReviewPolicy, ProviderId } from "@agentlab/contracts";

import { factoryBudgetFits, factoryCapabilitiesFit } from "./factory-authority-limits.js";
import type { FactorySkillSource, ResolvedFactorySkill } from "./factory-skill.js";

export interface ResolvedExternalPullRequestReviewer {
  readonly profile: FactoryExternalPullRequestReviewPolicy["reviewerProfiles"][number];
  readonly skills: readonly ResolvedFactorySkill[];
}

/** Resolves the complete reviewed skill set before any untrusted repository content is read. */
export async function resolveExternalPullRequestReviewers(
  source: FactorySkillSource,
  policy: FactoryExternalPullRequestReviewPolicy
): Promise<readonly ResolvedExternalPullRequestReviewer[]> {
  const reviewers: ResolvedExternalPullRequestReviewer[] = [];
  for (const profile of policy.reviewerProfiles) {
    const skills = await Promise.all(profile.skillDigests.map((digest) => source.resolve(digest)));
    for (const skill of skills)
      validateSkill(skill, profile.provider, profile.capabilities, profile.budget);
    const available = new Set(profile.skillDigests);
    for (const skill of skills) {
      if (skill.manifest.dependencyDigests.some((digest) => !available.has(digest))) {
        throw new Error(`External review skill ${skill.manifest.id} has an unpinned dependency.`);
      }
    }
    reviewers.push({ profile, skills });
  }
  return reviewers;
}

function validateSkill(
  skill: ResolvedFactorySkill,
  provider: ProviderId,
  capabilities: FactoryExternalPullRequestReviewPolicy["reviewerProfiles"][number]["capabilities"],
  budget: FactoryExternalPullRequestReviewPolicy["reviewerProfiles"][number]["budget"]
): void {
  if (
    skill.packageDigest !== skill.manifest.packageDigest ||
    !skill.manifest.roles.includes("reviewer") ||
    !skill.manifest.allowedFromStates.includes("reviewing") ||
    !skill.manifest.allowedToStates.includes("pr-proposed")
  ) {
    throw new Error(`Skill ${skill.manifest.id} is not authorized for external PR review.`);
  }
  const compatibility = skill.manifest.providerCompatibility;
  if (compatibility.mode === "allowlist" && !compatibility.providers.includes(provider)) {
    throw new Error(`External review skill ${skill.manifest.id} forbids provider ${provider}.`);
  }
  if (!factoryCapabilitiesFit(skill.manifest.requestedCapabilities, capabilities)) {
    throw new Error(`External review skill ${skill.manifest.id} exceeds reviewer capabilities.`);
  }
  if (!factoryBudgetFits(budget, skill.manifest.budgetCeiling)) {
    throw new Error(`External reviewer ${provider} exceeds skill ${skill.manifest.id} budget.`);
  }
}
