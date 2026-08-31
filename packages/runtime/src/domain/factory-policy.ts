import {
  factoryCostPolicySchema,
  factoryTimestampSchema,
  type EvidenceItem,
  type EvidenceKind,
  type FactoryApprovalPolicy,
  type FactoryApprovalRecord,
  type FactoryApprovalStage,
  type FactoryBudgetUsage,
  type FactoryChangeSet,
  type FactoryCostPolicy,
  type FactoryPolicyDecision,
  type FactoryPolicyOutcome,
  type FactoryResourceLimits,
  type FactoryRiskTier,
  type ImmutableTaskContract,
  type Sha256Digest
} from "@agentlab/contracts";

import type { CanonicalFactoryDocument } from "./factory-documents.js";
import { factoryRiskRank, maximumFactoryRisk } from "./factory-authority-limits.js";
import type { FactoryAuthorityState } from "./factory-task-repository.js";
import {
  repositoryPathIsInScope,
  repositoryPathMatches,
  repositoryPatternsMayOverlap
} from "./repository-path-policy.js";

export interface FactoryPolicyEvaluation {
  readonly contract: CanonicalFactoryDocument<ImmutableTaskContract>;
  readonly stage: FactoryApprovalStage;
  readonly approvalSubjectDigest: Sha256Digest;
  readonly now: string;
  readonly currentBaseRevision: string;
  readonly changeSet: FactoryChangeSet;
  readonly usage: FactoryBudgetUsage;
  readonly usageComplete: boolean;
  readonly evidence: readonly EvidenceItem[];
  readonly approvals: readonly FactoryApprovalRecord[];
  readonly authority: FactoryAuthorityState;
  readonly scheduled: boolean;
}

interface FactoryRiskProfile {
  readonly id: string;
  readonly tier: FactoryRiskTier;
  readonly version: string;
  readonly writeAllowed: boolean;
  readonly networkAllowlistAllowed: boolean;
  readonly minimumIndependentReviews: number;
  readonly resourceLimits: FactoryResourceLimits;
  readonly minimumHumanApprovals: Readonly<Record<FactoryApprovalStage, number | "forbidden">>;
  readonly requiredGateIds: Readonly<Record<FactoryApprovalStage, readonly string[]>>;
  readonly requiredEvidence: Readonly<Record<FactoryApprovalStage, readonly EvidenceKind[]>>;
}

export interface FactoryProtectedPathRule {
  readonly pattern: string;
  readonly minimumRiskTier: FactoryRiskTier;
}

interface FactoryPolicyBundleBase {
  readonly id: string;
  readonly version: string;
  readonly protectedPaths: readonly FactoryProtectedPathRule[];
  readonly profiles: Readonly<Record<FactoryRiskTier, FactoryRiskProfile>>;
}

export interface FactoryPolicyBundleV1 extends FactoryPolicyBundleBase {
  readonly schemaVersion: "agentlab.factory-policy.v1";
}

export interface FactoryPolicyBundleV2 extends FactoryPolicyBundleBase {
  readonly schemaVersion: "agentlab.factory-policy.v2";
  readonly costPolicy: FactoryCostPolicy;
}

export type FactoryPolicyBundle = FactoryPolicyBundleV1 | FactoryPolicyBundleV2;

export interface FactoryStageRequirements {
  readonly gateIds: readonly string[];
  readonly evidenceKinds: readonly EvidenceKind[];
  readonly minimumIndependentReviews: number;
  readonly resourceLimits: FactoryResourceLimits;
}

export interface FactoryApprovalRoleBindings {
  readonly execution: readonly string[];
  readonly pullRequestCreation: readonly string[];
  readonly merge: readonly string[];
  readonly release: readonly string[];
}

export interface FactoryContractControls {
  readonly gateProfile: ImmutableTaskContract["gateProfile"];
  readonly writeAllowed: boolean;
  readonly networkAllowlistAllowed: boolean;
  readonly minimumIndependentReviews: number;
  readonly requireDistinctReviewSession: boolean;
  readonly approvals: FactoryApprovalPolicy;
}

const preparationGates = ["contract-validation", "scope-validation", "policy-validation"] as const;
const r1PullRequestGates = [
  ...preparationGates,
  "format",
  "architecture",
  "typecheck",
  "lint",
  "test",
  "build",
  "secret-scan",
  "independent-review"
] as const;
const r2PullRequestGates = [
  ...r1PullRequestGates,
  "integration-test",
  "dependency-audit",
  "security-scan"
] as const;
const r3PullRequestGates = [...r2PullRequestGates, "protected-owner-review", "provenance"] as const;

const noEvidence: readonly EvidenceKind[] = [];
const executionEvidence = ["contract", "policy"] as const satisfies readonly EvidenceKind[];
const r1PullRequestEvidence = [
  "contract",
  "policy",
  "skill",
  "execution",
  "patch",
  "usage",
  "test",
  "build",
  "security",
  "review",
  "provenance"
] as const satisfies readonly EvidenceKind[];
const mergeEvidence = [
  ...r1PullRequestEvidence,
  "pull-request"
] as const satisfies readonly EvidenceKind[];
const releaseEvidence = [
  ...mergeEvidence,
  "merge",
  "sbom",
  "provenance"
] as const satisfies readonly EvidenceKind[];
const baselinePolicyVersion = "1.4.0";
const baselineGateProfileVersion = "1.3.0";

export const unconfiguredFactoryCostPolicy = factoryCostPolicySchema.parse({
  schemaVersion: "agentlab.cost-policy.v1",
  id: "agentlab/unconfigured-costs",
  version: "1.0.0",
  rules: []
});

function profile(input: {
  readonly tier: FactoryRiskTier;
  readonly writeAllowed: boolean;
  readonly networkAllowlistAllowed: boolean;
  readonly minimumIndependentReviews: number;
  readonly executionApprovals: number;
  readonly pullRequestApprovals: number | "forbidden";
  readonly mergeApprovals: number | "forbidden";
  readonly releaseApprovals: number | "forbidden";
  readonly pullRequestGates: readonly string[];
  readonly pullRequestEvidence: readonly EvidenceKind[];
  readonly resourceLimits: FactoryResourceLimits;
}): FactoryRiskProfile {
  return {
    id: `baseline/${input.tier.toLowerCase()}`,
    tier: input.tier,
    version: baselineGateProfileVersion,
    writeAllowed: input.writeAllowed,
    networkAllowlistAllowed: input.networkAllowlistAllowed,
    minimumIndependentReviews: input.minimumIndependentReviews,
    resourceLimits: input.resourceLimits,
    minimumHumanApprovals: {
      execution: input.executionApprovals,
      "pull-request-creation": input.pullRequestApprovals,
      merge: input.mergeApprovals,
      release: input.releaseApprovals
    },
    requiredGateIds: {
      execution: preparationGates,
      "pull-request-creation": input.pullRequestGates,
      merge: input.pullRequestGates,
      release: [...input.pullRequestGates, "release-provenance", "canary"]
    },
    requiredEvidence: {
      execution: executionEvidence,
      "pull-request-creation": input.pullRequestEvidence,
      merge: input.pullRequestEvidence.length === 0 ? noEvidence : mergeEvidence,
      release: input.releaseApprovals === "forbidden" ? noEvidence : releaseEvidence
    }
  };
}

function resourceLimits(
  maxProcesses: number,
  memoryGibibytes: number,
  cpuQuotaPercent: number
): FactoryResourceLimits {
  return {
    maxProcesses,
    maxMemoryBytes: memoryGibibytes * 1_024 * 1_024 * 1_024,
    cpuQuotaPercent
  };
}

export const defaultFactoryPolicyBundle: FactoryPolicyBundleV2 = {
  schemaVersion: "agentlab.factory-policy.v2",
  id: "agentlab/baseline",
  version: baselinePolicyVersion,
  costPolicy: unconfiguredFactoryCostPolicy,
  protectedPaths: [
    { pattern: "apps/**", minimumRiskTier: "R2" },
    { pattern: "packages/*/src/**", minimumRiskTier: "R2" },
    { pattern: ".github/**", minimumRiskTier: "R3" },
    { pattern: ".gitignore", minimumRiskTier: "R3" },
    { pattern: "AGENTS.md", minimumRiskTier: "R3" },
    { pattern: "SECURITY.md", minimumRiskTier: "R3" },
    { pattern: "docs/architecture.md", minimumRiskTier: "R3" },
    { pattern: "docs/decisions/**", minimumRiskTier: "R3" },
    { pattern: "docs/releasing.md", minimumRiskTier: "R3" },
    { pattern: "LICENSE", minimumRiskTier: "R3" },
    { pattern: "release/**", minimumRiskTier: "R3" },
    { pattern: "scripts/**", minimumRiskTier: "R3" },
    { pattern: "**/tsconfig*.json", minimumRiskTier: "R3" },
    { pattern: "eslint.config.*", minimumRiskTier: "R3" },
    { pattern: "vitest.config.*", minimumRiskTier: "R3" },
    { pattern: "**/package.json", minimumRiskTier: "R3" },
    { pattern: "package-lock.json", minimumRiskTier: "R3" },
    { pattern: "bun.lock", minimumRiskTier: "R3" },
    { pattern: "pnpm-lock.yaml", minimumRiskTier: "R3" },
    { pattern: "yarn.lock", minimumRiskTier: "R3" },
    { pattern: "**/migrations/**", minimumRiskTier: "R3" },
    { pattern: "**/migrations.*", minimumRiskTier: "R3" },
    { pattern: "**/*auth*", minimumRiskTier: "R3" },
    { pattern: "**/*security*", minimumRiskTier: "R3" },
    { pattern: "**/*secret*", minimumRiskTier: "R3" },
    { pattern: "**/*credential*", minimumRiskTier: "R3" },
    { pattern: ".env*", minimumRiskTier: "R4" },
    { pattern: "**/.env*", minimumRiskTier: "R4" },
    { pattern: "packages/contracts/src/factory.ts", minimumRiskTier: "R3" },
    { pattern: "packages/runtime/src/**/factory-*.ts", minimumRiskTier: "R3" },
    { pattern: "packages/runtime/src/infrastructure/github/**", minimumRiskTier: "R3" },
    { pattern: "packages/runtime/src/infrastructure/providers/**", minimumRiskTier: "R3" },
    { pattern: "packages/runtime/src/infrastructure/process/**", minimumRiskTier: "R3" },
    {
      pattern: "packages/runtime/src/infrastructure/tmux/shell-command.ts",
      minimumRiskTier: "R3"
    }
  ],
  profiles: {
    R0: profile({
      tier: "R0",
      writeAllowed: false,
      networkAllowlistAllowed: false,
      minimumIndependentReviews: 0,
      executionApprovals: 0,
      pullRequestApprovals: "forbidden",
      mergeApprovals: "forbidden",
      releaseApprovals: "forbidden",
      pullRequestGates: [],
      pullRequestEvidence: [],
      resourceLimits: resourceLimits(8, 1, 100)
    }),
    R1: profile({
      tier: "R1",
      writeAllowed: true,
      networkAllowlistAllowed: false,
      minimumIndependentReviews: 1,
      executionApprovals: 0,
      pullRequestApprovals: 0,
      mergeApprovals: 1,
      releaseApprovals: "forbidden",
      pullRequestGates: r1PullRequestGates,
      pullRequestEvidence: r1PullRequestEvidence,
      resourceLimits: resourceLimits(32, 4, 400)
    }),
    R2: profile({
      tier: "R2",
      writeAllowed: true,
      networkAllowlistAllowed: true,
      minimumIndependentReviews: 2,
      executionApprovals: 0,
      pullRequestApprovals: 0,
      mergeApprovals: 1,
      releaseApprovals: 1,
      pullRequestGates: r2PullRequestGates,
      pullRequestEvidence: r1PullRequestEvidence,
      resourceLimits: resourceLimits(64, 8, 800)
    }),
    R3: profile({
      tier: "R3",
      writeAllowed: true,
      networkAllowlistAllowed: true,
      minimumIndependentReviews: 2,
      executionApprovals: 1,
      pullRequestApprovals: 1,
      mergeApprovals: 2,
      releaseApprovals: 2,
      pullRequestGates: r3PullRequestGates,
      pullRequestEvidence: [...r1PullRequestEvidence, "provenance"],
      resourceLimits: resourceLimits(64, 8, 800)
    }),
    R4: profile({
      tier: "R4",
      writeAllowed: false,
      networkAllowlistAllowed: false,
      minimumIndependentReviews: 0,
      executionApprovals: 0,
      pullRequestApprovals: "forbidden",
      mergeApprovals: "forbidden",
      releaseApprovals: "forbidden",
      pullRequestGates: [],
      pullRequestEvidence: [],
      resourceLimits: resourceLimits(8, 1, 100)
    })
  }
};

export function factoryPolicyBundleMediaType(bundle: FactoryPolicyBundle): string {
  const version = bundle.schemaVersion === "agentlab.factory-policy.v1" ? 1 : 2;
  return `application/vnd.agentlab.factory-policy.v${String(version)}+json`;
}

/** Deterministic policy evaluator. It can deny or require humans; it never invokes a model. */
export class FactoryPolicyEngine {
  public constructor(
    private readonly policyBundleDigest: Sha256Digest,
    private readonly bundle: FactoryPolicyBundle = defaultFactoryPolicyBundle
  ) {}

  public get bundleDigest(): Sha256Digest {
    return this.policyBundleDigest;
  }

  public requirements(
    tier: FactoryRiskTier,
    stage: FactoryApprovalStage
  ): FactoryStageRequirements {
    const profile = this.bundle.profiles[tier];
    return {
      gateIds: [...profile.requiredGateIds[stage]],
      evidenceKinds: [...profile.requiredEvidence[stage]],
      minimumIndependentReviews: profile.minimumIndependentReviews,
      resourceLimits: { ...profile.resourceLimits }
    };
  }

  /** Classifies the complete prospective capability and write scope before any worker starts. */
  public minimumRiskTier(
    input: Pick<ImmutableTaskContract, "scope" | "capabilities">
  ): FactoryRiskTier {
    return prospectiveRisk(input, this.bundle);
  }

  /** Derives authority-bearing contract controls from policy, never from model output. */
  public contractControls(
    tier: FactoryRiskTier,
    approvalRoles: FactoryApprovalRoleBindings
  ): FactoryContractControls {
    const profile = this.bundle.profiles[tier];
    return {
      gateProfile: {
        id: profile.id,
        version: profile.version,
        policyDigest: this.policyBundleDigest
      },
      writeAllowed: profile.writeAllowed,
      networkAllowlistAllowed: profile.networkAllowlistAllowed,
      minimumIndependentReviews: profile.minimumIndependentReviews,
      requireDistinctReviewSession: profile.minimumIndependentReviews > 0,
      approvals: {
        execution: approvalRequirement(
          profile.minimumHumanApprovals.execution,
          approvalRoles.execution
        ),
        pullRequestCreation: approvalRequirement(
          profile.minimumHumanApprovals["pull-request-creation"],
          approvalRoles.pullRequestCreation
        ),
        merge: approvalRequirement(profile.minimumHumanApprovals.merge, approvalRoles.merge),
        release: approvalRequirement(profile.minimumHumanApprovals.release, approvalRoles.release)
      }
    };
  }

  public evaluate(input: FactoryPolicyEvaluation): FactoryPolicyDecision {
    const profileForContract = this.bundle.profiles[input.contract.value.riskTier];
    const detectedRiskFloor = effectiveRisk(input.contract.value, input.changeSet, this.bundle);
    const effectiveRiskTier = maximumFactoryRisk(input.contract.value.riskTier, detectedRiskFloor);
    const denials = new Set<string>();

    const evaluationTime = factoryTimestampSchema.safeParse(input.now);
    if (!evaluationTime.success) {
      denials.add("invalid-evaluation-time");
    } else if (evaluationTime.data >= input.contract.value.expiresAt) {
      denials.add("contract-expired");
    }
    if (input.currentBaseRevision !== input.contract.value.repository.baseRevision) {
      denials.add("base-revision-mismatch");
    }
    if (input.contract.value.gateProfile.policyDigest !== this.policyBundleDigest) {
      denials.add("policy-digest-mismatch");
    }
    if (
      input.contract.value.gateProfile.id !== profileForContract.id ||
      input.contract.value.gateProfile.version !== profileForContract.version
    ) {
      denials.add("gate-profile-mismatch");
    }
    if (factoryRiskRank(detectedRiskFloor) > factoryRiskRank(input.contract.value.riskTier)) {
      denials.add("risk-underclassified");
    }
    for (const reason of capabilityDenials(input.contract.value, profileForContract)) {
      denials.add(reason);
    }
    for (const reason of approvalPolicyDenials(input.contract.value, profileForContract)) {
      denials.add(reason);
    }
    for (const reason of changeSetDenials(input.contract.value, input.changeSet)) {
      denials.add(reason);
    }
    for (const reason of budgetDenials(input.contract.value, input.usage)) denials.add(reason);
    if (!input.usageComplete) denials.add("usage-incomplete");
    if (input.scheduled && !input.authority.scheduler) denials.add("scheduler-disabled");
    if (input.stage === "pull-request-creation" && !input.authority.prBroker) {
      denials.add("pr-broker-disabled");
    }

    const requiredGateIds = profileForContract.requiredGateIds[input.stage];
    const requiredEvidence = mergedEvidenceRequirements(
      profileForContract.requiredEvidence[input.stage],
      input.stage === "execution" ? [] : input.contract.value.requiredEvidence
    );
    for (const reason of evidenceDenials(
      input.evidence,
      requiredGateIds,
      requiredEvidence,
      input.contract.digest,
      this.policyBundleDigest,
      input.approvalSubjectDigest
    )) {
      denials.add(reason);
    }
    if (input.stage !== "execution") {
      for (const reason of patchImplementationDenials(
        input.evidence,
        input.contract.digest,
        input.approvalSubjectDigest
      )) {
        denials.add(reason);
      }
      for (const reason of resourceIsolationDenials(
        input.evidence,
        input.contract.digest,
        input.approvalSubjectDigest,
        this.policyBundleDigest
      )) {
        denials.add(reason);
      }
    }
    if (
      input.stage !== "execution" &&
      independentReviewerCount(input.evidence, input.approvalSubjectDigest) <
        profileForContract.minimumIndependentReviews
    ) {
      denials.add("insufficient-independent-review");
    }

    const approvalRequirement = stageApprovalRequirement(input.contract.value, input.stage);
    const profileApprovalMinimum = profileForContract.minimumHumanApprovals[input.stage];
    if (approvalRequirement.mode === "forbidden" || profileApprovalMinimum === "forbidden") {
      denials.add("stage-forbidden");
    }
    const requiredHumanApprovals =
      approvalRequirement.mode === "human"
        ? Math.max(
            approvalRequirement.minimumApprovals,
            numericApprovalMinimum(profileApprovalMinimum)
          )
        : numericApprovalMinimum(profileApprovalMinimum);
    const approvalResult = matchingApprovals(
      input.approvals,
      input.stage,
      input.approvalSubjectDigest,
      approvalRequirement.mode === "human" ? approvalRequirement.roles : []
    );
    if (approvalResult.rejected) denials.add("human-approval-rejected");

    const sortedDenials = [...denials].sort();
    if (sortedDenials.length > 0) {
      return decision(
        "deny",
        effectiveRiskTier,
        profileForContract,
        sortedDenials,
        requiredGateIds,
        requiredEvidence,
        requiredHumanApprovals,
        approvalResult.approved
      );
    }
    if (approvalResult.approved < requiredHumanApprovals) {
      return decision(
        "needs-human",
        effectiveRiskTier,
        profileForContract,
        ["human-approval-required"],
        requiredGateIds,
        requiredEvidence,
        requiredHumanApprovals,
        approvalResult.approved
      );
    }
    return decision(
      "allow",
      effectiveRiskTier,
      profileForContract,
      [],
      requiredGateIds,
      requiredEvidence,
      requiredHumanApprovals,
      approvalResult.approved
    );
  }
}

function effectiveRisk(
  contract: ImmutableTaskContract,
  changeSet: FactoryChangeSet,
  bundle: FactoryPolicyBundle
): FactoryRiskTier {
  let effective = prospectiveRisk(contract, bundle);
  if (changeSet.binaryPaths.length > 0) {
    effective = maximumFactoryRisk(effective, "R2");
  }
  for (const path of changeSet.changedPaths) {
    for (const rule of bundle.protectedPaths) {
      if (repositoryPathMatches(path, rule.pattern)) {
        effective = maximumFactoryRisk(effective, rule.minimumRiskTier);
      }
    }
    if (contract.scope.protectedPaths.some((pattern) => repositoryPathMatches(path, pattern))) {
      effective = maximumFactoryRisk(effective, "R3");
    }
  }
  return effective;
}

function prospectiveRisk(
  contract: Pick<ImmutableTaskContract, "scope" | "capabilities">,
  bundle: FactoryPolicyBundle
): FactoryRiskTier {
  let effective: FactoryRiskTier =
    contract.capabilities.filesystem === "workspace-write" ? "R1" : "R0";
  if (contract.capabilities.filesystem === "workspace-write") {
    // Exclusions cannot lower this pre-execution ceiling: proving arbitrary glob subtraction is
    // outside the policy language, so broad or ambiguous write scopes require the highest tier
    // they could reach. Exact changed paths are checked again after execution.
    for (const included of contract.scope.includePaths) {
      for (const rule of bundle.protectedPaths) {
        if (repositoryPatternsMayOverlap(included, rule.pattern)) {
          effective = maximumFactoryRisk(effective, rule.minimumRiskTier);
        }
      }
      if (
        contract.scope.protectedPaths.some((protectedPath) =>
          repositoryPatternsMayOverlap(included, protectedPath)
        )
      ) {
        effective = maximumFactoryRisk(effective, "R3");
      }
    }
  }
  if (contract.capabilities.network.mode === "allowlist") {
    effective = maximumFactoryRisk(effective, "R2");
  }
  if (contract.capabilities.secretRefs.length > 0) effective = "R4";
  return effective;
}

function capabilityDenials(
  contract: ImmutableTaskContract,
  profile: FactoryRiskProfile
): readonly string[] {
  const reasons: string[] = [];
  if (contract.capabilities.filesystem === "workspace-write" && !profile.writeAllowed) {
    reasons.push("workspace-write-forbidden");
  }
  if (contract.capabilities.network.mode === "allowlist" && !profile.networkAllowlistAllowed) {
    reasons.push("network-forbidden-for-tier");
  }
  if (contract.capabilities.secretRefs.length > 0) reasons.push("agent-secrets-forbidden");
  if (
    contract.capabilities.filesystem === "workspace-write" &&
    contract.agentPolicy.minimumIndependentReviews < profile.minimumIndependentReviews
  ) {
    reasons.push("review-policy-too-weak");
  }
  return reasons;
}

function approvalPolicyDenials(
  contract: ImmutableTaskContract,
  profile: FactoryRiskProfile
): readonly string[] {
  const reasons: string[] = [];
  for (const stage of [
    "execution",
    "pull-request-creation",
    "merge",
    "release"
  ] as const satisfies readonly FactoryApprovalStage[]) {
    const requirement = stageApprovalRequirement(contract, stage);
    const minimum = profile.minimumHumanApprovals[stage];
    if (minimum === "forbidden" && requirement.mode !== "forbidden") {
      reasons.push(`approval-policy/${stage}-must-be-forbidden`);
    }
    if (typeof minimum === "number" && minimum > 0) {
      if (requirement.mode !== "human" || requirement.minimumApprovals < minimum) {
        reasons.push(`approval-policy/${stage}-too-weak`);
      }
    }
    if ((stage === "merge" || stage === "release") && requirement.mode === "automatic") {
      reasons.push(`approval-policy/${stage}-automatic-forbidden`);
    }
  }
  return reasons;
}

function changeSetDenials(
  contract: ImmutableTaskContract,
  changeSet: FactoryChangeSet
): readonly string[] {
  const reasons: string[] = [];
  if (changeSet.baseRevision !== contract.repository.baseRevision) {
    reasons.push("change-set-base-mismatch");
  }
  if (changeSet.changedFiles !== changeSet.changedPaths.length) {
    reasons.push("change-set-file-count-mismatch");
  }
  for (const path of changeSet.changedPaths) {
    if (!repositoryPathIsInScope(path, contract.scope.includePaths, contract.scope.excludePaths)) {
      reasons.push("change-outside-contract-scope");
      break;
    }
  }
  return reasons;
}

function budgetDenials(
  contract: ImmutableTaskContract,
  usage: FactoryBudgetUsage
): readonly string[] {
  const budget = contract.budget;
  const reasons: string[] = [];
  const comparisons: readonly (readonly [number, number, string])[] = [
    [usage.wallClockSeconds, budget.wallClockSeconds, "wall-clock"],
    [usage.agentTurns, budget.maxAgentTurns, "agent-turns"],
    [usage.toolCalls, budget.maxToolCalls, "tool-calls"],
    [usage.inputTokens, budget.maxInputTokens, "input-tokens"],
    [usage.outputTokens, budget.maxOutputTokens, "output-tokens"],
    [usage.costMicrousd, budget.maxCostMicrousd, "cost"],
    [usage.processes, budget.maxProcesses, "processes"],
    [usage.outputBytes, budget.maxOutputBytes, "output-bytes"],
    [usage.workers, budget.maxWorkers, "workers"],
    [usage.repairAttempts, budget.maxRepairAttempts, "repair-attempts"],
    [usage.changedFiles, budget.maxChangedFiles, "changed-files"],
    [usage.changedLines, budget.maxChangedLines, "changed-lines"]
  ];
  for (const [actual, maximum, name] of comparisons) {
    if (actual > maximum) reasons.push(`budget-exceeded/${name}`);
  }
  return reasons;
}

function evidenceDenials(
  evidence: readonly EvidenceItem[],
  requiredGateIds: readonly string[],
  requiredEvidence: readonly EvidenceKind[],
  contractDigest: Sha256Digest,
  policyBundleDigest: Sha256Digest,
  approvalSubjectDigest: Sha256Digest
): readonly string[] {
  const reasons: string[] = [];
  const trustedPasses = evidence.filter(
    (item) => item.result === "pass" && evidenceProducerCanAssert(item)
  );
  for (const gate of requiredGateIds) {
    const subjectDigest = preparationGates.includes(gate as (typeof preparationGates)[number])
      ? contractDigest
      : approvalSubjectDigest;
    const passedGates = gateClaims(trustedPasses, subjectDigest);
    const failedGates = gateClaims(
      evidence.filter(
        (item) =>
          item.result === "fail" &&
          evidenceProducerCanAssert(item) &&
          item.subjectDigest === subjectDigest
      ),
      subjectDigest
    );
    if (failedGates.has(gate)) reasons.push(`gate-failed/${gate}`);
    else if (!passedGates.has(gate)) reasons.push(`missing-gate/${gate}`);
  }
  for (const kind of requiredEvidence) {
    const present = evidence.some(
      (item) =>
        item.kind === kind &&
        item.result === "pass" &&
        evidenceSubjectMatches(
          item,
          kind,
          contractDigest,
          policyBundleDigest,
          approvalSubjectDigest
        ) &&
        (kind === "review" ? item.producer.role === "reviewer" : evidenceProducerCanAssert(item))
    );
    if (!present) reasons.push(`missing-evidence/${kind}`);
  }
  return reasons;
}

function gateClaims(
  evidence: readonly EvidenceItem[],
  subjectDigest: Sha256Digest
): ReadonlySet<string> {
  return new Set(
    evidence
      .filter((item) => item.subjectDigest === subjectDigest)
      .flatMap((item) =>
        item.claims.filter((claim) => claim.name === "gate-id").map((claim) => claim.value)
      )
  );
}

function evidenceSubjectMatches(
  item: EvidenceItem,
  kind: EvidenceKind,
  contractDigest: Sha256Digest,
  policyBundleDigest: Sha256Digest,
  approvalSubjectDigest: Sha256Digest
): boolean {
  if (kind === "policy") return item.subjectDigest === policyBundleDigest;
  if (
    kind === "request" ||
    kind === "qualification" ||
    kind === "specification" ||
    kind === "plan" ||
    kind === "contract" ||
    kind === "skill" ||
    kind === "execution" ||
    kind === "command"
  ) {
    return item.subjectDigest === contractDigest;
  }
  return item.subjectDigest === approvalSubjectDigest;
}

function evidenceProducerCanAssert(item: EvidenceItem): boolean {
  if (item.kind === "execution") {
    return (
      item.producer.kind === "agent" &&
      (item.producer.role === "implementer" ||
        item.producer.role === "repairer" ||
        item.producer.role === "reviewer")
    );
  }
  if (item.kind === "review") {
    return item.producer.kind === "agent" && item.producer.role === "reviewer";
  }
  return (
    item.producer.kind === "ci" ||
    item.producer.kind === "control-plane" ||
    item.producer.kind === "broker"
  );
}

function resourceIsolationDenials(
  evidence: readonly EvidenceItem[],
  contractDigest: Sha256Digest,
  approvalSubjectDigest: Sha256Digest,
  policyBundleDigest: Sha256Digest
): readonly string[] {
  const provenance = evidence.filter(
    (item) =>
      item.kind === "provenance" &&
      item.result === "pass" &&
      item.producer.kind === "ci" &&
      item.producer.role === "gate-runner" &&
      item.producer.id === "agentlab-resource-isolator" &&
      claimValue(item, "policy-bundle-digest") === policyBundleDigest &&
      claimValue(item, "isolation-mechanism") === "linux/systemd-user-scope"
  );
  const reasons = new Set<string>();
  const successfulAgentRuns = evidence.filter(
    (item) =>
      item.kind === "execution" &&
      item.result === "pass" &&
      item.subjectDigest === contractDigest &&
      item.producer.kind === "agent"
  );
  for (const execution of successfulAgentRuns) {
    const executionId = claimValue(execution, "execution-id");
    const isolationId = claimValue(execution, "isolation-id");
    if (
      executionId === null ||
      isolationId === null ||
      !provenance.some(
        (item) =>
          item.subjectDigest === contractDigest &&
          claimValue(item, "execution-id") === executionId &&
          claimValue(item, "isolation-id") === isolationId
      )
    ) {
      reasons.add("missing-resource-isolation/agent");
    }
  }
  const successfulSandboxedGates = evidence.filter(
    (item) =>
      (item.kind === "test" ||
        item.kind === "build" ||
        item.kind === "security" ||
        item.kind === "provenance") &&
      item.result === "pass" &&
      item.subjectDigest === approvalSubjectDigest &&
      item.producer.kind === "ci" &&
      item.producer.role === "gate-runner" &&
      item.producer.id === "agentlab-local-sandbox" &&
      claimValue(item, "gate-id") !== null
  );
  for (const gate of successfulSandboxedGates) {
    const gateId = claimValue(gate, "gate-id");
    const isolationId = claimValue(gate, "isolation-id");
    if (
      gateId === null ||
      isolationId === null ||
      !provenance.some(
        (item) =>
          item.subjectDigest === approvalSubjectDigest &&
          claimValue(item, "gate-id") === gateId &&
          claimValue(item, "isolation-id") === isolationId
      )
    ) {
      reasons.add("missing-resource-isolation/gate");
    }
  }
  return [...reasons].sort();
}

function patchImplementationDenials(
  evidence: readonly EvidenceItem[],
  contractDigest: Sha256Digest,
  approvalSubjectDigest: Sha256Digest
): readonly string[] {
  const patch = evidence.find(
    (item) =>
      item.kind === "patch" &&
      item.result === "pass" &&
      item.subjectDigest === approvalSubjectDigest &&
      item.producer.kind === "control-plane" &&
      item.producer.role === "gate-runner" &&
      item.producer.id === "agentlab-local-gates"
  );
  const executionId = patch === undefined ? null : claimValue(patch, "execution-id");
  if (executionId === null) return ["missing-patch-implementation"];
  const implemented = evidence.some(
    (item) =>
      item.kind === "execution" &&
      item.result === "pass" &&
      item.subjectDigest === contractDigest &&
      item.producer.kind === "agent" &&
      (item.producer.role === "implementer" || item.producer.role === "repairer") &&
      claimValue(item, "execution-id") === executionId
  );
  return implemented ? [] : ["missing-patch-implementation"];
}

function claimValue(item: EvidenceItem, name: string): string | null {
  return item.claims.find((claim) => claim.name === name)?.value ?? null;
}

function independentReviewerCount(
  evidence: readonly EvidenceItem[],
  approvalSubjectDigest: Sha256Digest
): number {
  const implementationEvidence = evidence.filter(
    (item) => item.producer.role === "implementer" || item.producer.role === "repairer"
  );
  const implementerIds = new Set(implementationEvidence.map((item) => item.producer.id));
  const implementerSessions = new Set(
    implementationEvidence.flatMap((item) =>
      item.producer.sessionId === null ? [] : [item.producer.sessionId]
    )
  );
  const reviewers = new Set<string>();
  for (const item of evidence) {
    if (
      item.kind !== "review" ||
      item.result !== "pass" ||
      item.subjectDigest !== approvalSubjectDigest ||
      item.producer.role !== "reviewer"
    ) {
      continue;
    }
    if (item.producer.kind === "agent" && item.producer.sessionId === null) continue;
    if (
      implementerIds.has(item.producer.id) ||
      (item.producer.sessionId !== null && implementerSessions.has(item.producer.sessionId))
    ) {
      continue;
    }
    const key = actorKey(item.producer.kind, item.producer.id, item.producer.sessionId);
    reviewers.add(key);
  }
  return reviewers.size;
}

function matchingApprovals(
  approvals: readonly FactoryApprovalRecord[],
  stage: FactoryApprovalStage,
  subjectDigest: Sha256Digest,
  allowedRoles: readonly string[]
): { readonly approved: number; readonly rejected: boolean } {
  const acceptedActors = new Set<string>();
  let rejected = false;
  for (const approval of approvals) {
    if (approval.stage !== stage || approval.subjectDigest !== subjectDigest) continue;
    if (
      allowedRoles.length > 0 &&
      !approval.authorityRoles.some((role) => allowedRoles.includes(role))
    ) {
      continue;
    }
    if (approval.decision === "rejected") rejected = true;
    else acceptedActors.add(approval.actor.id);
  }
  return { approved: acceptedActors.size, rejected };
}

function stageApprovalRequirement(
  contract: ImmutableTaskContract,
  stage: FactoryApprovalStage
): ImmutableTaskContract["approvals"][keyof ImmutableTaskContract["approvals"]] {
  if (stage === "execution") return contract.approvals.execution;
  if (stage === "pull-request-creation") return contract.approvals.pullRequestCreation;
  if (stage === "merge") return contract.approvals.merge;
  return contract.approvals.release;
}

function mergedEvidenceRequirements(
  left: readonly EvidenceKind[],
  right: readonly EvidenceKind[]
): readonly EvidenceKind[] {
  return [...new Set([...left, ...right])].sort();
}

function numericApprovalMinimum(minimum: number | "forbidden"): number {
  return typeof minimum === "number" ? minimum : 0;
}

function decision(
  outcome: FactoryPolicyOutcome,
  effectiveRiskTier: FactoryRiskTier,
  profile: FactoryRiskProfile,
  reasonCodes: readonly string[],
  requiredGateIds: readonly string[],
  requiredEvidence: readonly EvidenceKind[],
  requiredHumanApprovals: number,
  satisfiedHumanApprovals: number
): FactoryPolicyDecision {
  return {
    outcome,
    effectiveRiskTier,
    profileId: profile.id,
    reasonCodes: [...reasonCodes],
    requiredGateIds: [...requiredGateIds],
    requiredEvidence: [...requiredEvidence],
    requiredHumanApprovals,
    satisfiedHumanApprovals
  };
}

function actorKey(kind: string, id: string, sessionId: string | null): string {
  return `${kind}/${id}/${sessionId ?? "none"}`;
}

function approvalRequirement(
  minimum: number | "forbidden",
  roles: readonly string[]
): FactoryApprovalPolicy["execution"] {
  if (minimum === "forbidden") return { mode: "forbidden" };
  if (minimum === 0) return { mode: "automatic" };
  if (roles.length === 0 || new Set(roles).size !== roles.length) {
    throw new Error("Human approval policy requires unique authority roles.");
  }
  return { mode: "human", minimumApprovals: minimum, roles: [...roles] };
}
