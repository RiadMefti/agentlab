import type {
  FactoryActorRole,
  FactoryBudget,
  FactoryCapabilityGrant,
  FactoryRiskTier,
  FactorySkillPackage,
  FactoryTaskState,
  ImmutableTaskContract,
  ProviderId,
  Sha256Digest,
  SkillManifest
} from "@agentlab/contracts";

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
    if (riskRank(contract.riskTier) > riskRank(skill.manifest.riskCeiling)) {
      throw new Error(`Skill ${entry.id} does not permit task risk ${contract.riskTier}.`);
    }
    if (!capabilitiesFit(skill.manifest.requestedCapabilities, contract.capabilities)) {
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
      .reduce(mergeCapabilities),
    budget: phaseSkills
      .map(({ manifest }) => manifest.budgetCeiling)
      .reduce(minimumBudget, input.contract.budget)
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

function capabilitiesFit(
  requested: FactoryCapabilityGrant,
  granted: FactoryCapabilityGrant
): boolean {
  return (
    accessRank(requested.filesystem) <= accessRank(granted.filesystem) &&
    accessRank(requested.git) <= accessRank(granted.git) &&
    accessRank(requested.remoteRepository) <= accessRank(granted.remoteRepository) &&
    accessRank(requested.process) <= accessRank(granted.process) &&
    networkFits(requested.network, granted.network) &&
    requested.commandAllowlist.every((command) => granted.commandAllowlist.includes(command)) &&
    requested.secretRefs.every((secret) => granted.secretRefs.includes(secret))
  );
}

function mergeCapabilities(
  left: FactoryCapabilityGrant,
  right: FactoryCapabilityGrant
): FactoryCapabilityGrant {
  return {
    filesystem: maximumAccess(left.filesystem, right.filesystem),
    git: maximumAccess(left.git, right.git),
    remoteRepository: maximumAccess(left.remoteRepository, right.remoteRepository),
    process: maximumAccess(left.process, right.process),
    network:
      left.network.mode === "off" && right.network.mode === "off"
        ? { mode: "off" }
        : {
            mode: "allowlist",
            hosts: unique([
              ...(left.network.mode === "allowlist" ? left.network.hosts : []),
              ...(right.network.mode === "allowlist" ? right.network.hosts : [])
            ])
          },
    commandAllowlist: unique([...left.commandAllowlist, ...right.commandAllowlist]),
    secretRefs: unique([...left.secretRefs, ...right.secretRefs])
  };
}

function minimumBudget(left: FactoryBudget, right: FactoryBudget): FactoryBudget {
  return {
    wallClockSeconds: Math.min(left.wallClockSeconds, right.wallClockSeconds),
    maxAgentTurns: Math.min(left.maxAgentTurns, right.maxAgentTurns),
    maxToolCalls: Math.min(left.maxToolCalls, right.maxToolCalls),
    maxInputTokens: Math.min(left.maxInputTokens, right.maxInputTokens),
    maxOutputTokens: Math.min(left.maxOutputTokens, right.maxOutputTokens),
    maxCostMicrousd: Math.min(left.maxCostMicrousd, right.maxCostMicrousd),
    maxProcesses: Math.min(left.maxProcesses, right.maxProcesses),
    maxOutputBytes: Math.min(left.maxOutputBytes, right.maxOutputBytes),
    maxWorkers: Math.min(left.maxWorkers, right.maxWorkers),
    maxRepairAttempts: Math.min(left.maxRepairAttempts, right.maxRepairAttempts),
    maxChangedFiles: Math.min(left.maxChangedFiles, right.maxChangedFiles),
    maxChangedLines: Math.min(left.maxChangedLines, right.maxChangedLines)
  };
}

function networkFits(
  requested: FactoryCapabilityGrant["network"],
  granted: FactoryCapabilityGrant["network"]
): boolean {
  if (requested.mode === "off") return true;
  if (granted.mode === "off") return false;
  return requested.hosts.every((host) => granted.hosts.includes(host));
}

function maximumAccess<Value extends string>(left: Value, right: Value): Value {
  return accessRank(left) >= accessRank(right) ? left : right;
}

function accessRank(value: string): number {
  if (value === "none") return 0;
  if (value === "read") return 1;
  return 2;
}

function riskRank(tier: FactoryRiskTier): number {
  return ["R0", "R1", "R2", "R3", "R4"].indexOf(tier);
}

function unique<Value>(values: readonly Value[]): Value[] {
  return [...new Set(values)];
}

function sameSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value) => right.includes(value));
}
