import type {
  FactoryExternalPullRequestRepairQualificationPolicy,
  ProviderId
} from "@agentlab/contracts";

import { factoryBudgetFits, factoryCapabilitiesFit } from "./factory-authority-limits.js";
import type { FactorySkillSource, ResolvedFactorySkill } from "./factory-skill.js";

export interface ResolvedExternalPullRequestRepairQualificationReviewer {
  readonly profile: FactoryExternalPullRequestRepairQualificationPolicy["reviewerProfiles"][number];
  readonly skills: readonly ResolvedFactorySkill[];
}

/** Resolves every trusted review skill before repaired repository content is opened. */
export async function resolveExternalPullRequestRepairQualificationReviewers(
  source: FactorySkillSource,
  policy: FactoryExternalPullRequestRepairQualificationPolicy
): Promise<readonly ResolvedExternalPullRequestRepairQualificationReviewer[]> {
  const reviewers: ResolvedExternalPullRequestRepairQualificationReviewer[] = [];
  for (const profile of policy.reviewerProfiles) {
    const skills = await Promise.all(profile.skillDigests.map((digest) => source.resolve(digest)));
    for (const skill of skills) {
      validateSkill(skill, profile.provider, profile.capabilities, profile.budget);
    }
    const available = new Set(profile.skillDigests);
    for (const skill of skills) {
      if (skill.manifest.dependencyDigests.some((digest) => !available.has(digest))) {
        throw new Error(
          `External repair qualification skill ${skill.manifest.id} has an unpinned dependency.`
        );
      }
    }
    reviewers.push({ profile, skills });
  }
  return reviewers;
}

function validateSkill(
  skill: ResolvedFactorySkill,
  provider: ProviderId,
  capabilities: FactoryExternalPullRequestRepairQualificationPolicy["reviewerProfiles"][number]["capabilities"],
  budget: FactoryExternalPullRequestRepairQualificationPolicy["reviewerProfiles"][number]["budget"]
): void {
  if (
    skill.packageDigest !== skill.manifest.packageDigest ||
    !skill.manifest.roles.includes("reviewer") ||
    !skill.manifest.allowedFromStates.includes("reviewing") ||
    !skill.manifest.allowedToStates.includes("pr-proposed")
  ) {
    throw new Error(
      `Skill ${skill.manifest.id} is not authorized for external repair qualification.`
    );
  }
  const compatibility = skill.manifest.providerCompatibility;
  if (compatibility.mode === "allowlist" && !compatibility.providers.includes(provider)) {
    throw new Error(
      `External repair qualification skill ${skill.manifest.id} forbids provider ${provider}.`
    );
  }
  if (!factoryCapabilitiesFit(skill.manifest.requestedCapabilities, capabilities)) {
    throw new Error(
      `External repair qualification skill ${skill.manifest.id} exceeds reviewer capability.`
    );
  }
  if (!factoryBudgetFits(budget, skill.manifest.budgetCeiling)) {
    throw new Error(
      `External repair qualification reviewer ${provider} exceeds skill ${skill.manifest.id} budget.`
    );
  }
}
