import {
  factoryMaintenanceDiscoveryPolicySchema,
  factorySkillPackageSchema,
  skillManifestSchema,
  type FactoryMaintenanceDiscoveryOutput,
  type FactoryMaintenanceDiscoveryPolicy,
  type FactoryMaintenanceDiscoveryRun,
  type FactorySchedulePolicy,
  type FactorySkillPackage,
  type Sha256Digest,
  type SkillManifest
} from "@agentlab/contracts";

import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../../packages/runtime/src/domain/factory-documents.js";
import { NodeFactoryDocumentCodec } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import { testFactorySchedulePolicy } from "./factory-schedule.js";
import { testDigest } from "./factory.js";

export const TEST_MAINTENANCE_DISCOVERY_RUN_ID = "81000000-0000-4000-8000-000000000001";
export const TEST_MAINTENANCE_DISCOVERY_EXECUTION_ID = "81000000-0000-4000-8000-000000000002";
export const TEST_MAINTENANCE_DISCOVERY_CORRELATION_ID = "81000000-0000-4000-8000-000000000003";

export interface FactoryMaintenanceDiscoveryFixture {
  readonly documents: FactoryDocumentCodec;
  readonly policy: FactoryMaintenanceDiscoveryPolicy;
  readonly policyDocument: CanonicalFactoryDocument<FactoryMaintenanceDiscoveryPolicy>;
  readonly schedulePolicy: FactorySchedulePolicy;
  readonly scheduleDocument: CanonicalFactoryDocument<FactorySchedulePolicy>;
  readonly skill: SkillManifest;
  readonly skillPackage: FactorySkillPackage;
  readonly skillPackageDigest: Sha256Digest;
  readonly run: CanonicalFactoryDocument<FactoryMaintenanceDiscoveryRun>;
}

export function testFactoryMaintenanceDiscoveryFixture(): FactoryMaintenanceDiscoveryFixture {
  const documents: FactoryDocumentCodec = new NodeFactoryDocumentCodec();
  const packageInput = factorySkillPackageSchema.parse({
    schemaVersion: "agentlab.skill-package.v1",
    manifest: {
      schemaVersion: "agentlab.skill-manifest.v1",
      id: "maintenance/discover",
      version: "1.0.0",
      instructionPath: "skills/maintenance/discover/SKILL.md",
      description: "Find bounded, evidenced, low-risk repository maintenance.",
      roles: ["maintenance-scout"],
      triggers: ["scheduled"],
      inputSchemaDigest: testDigest("1"),
      outputSchemaDigest: testDigest("2"),
      requestedCapabilities: readOnlyCapabilities(),
      riskCeiling: "R0",
      allowedFromStates: ["intake"],
      allowedToStates: ["intake"],
      providerCompatibility: { mode: "allowlist", providers: ["codex"] },
      budgetCeiling: discoveryBudget(),
      requiredEvidence: ["discovery"],
      dependencyDigests: []
    },
    files: {
      "skills/maintenance/discover/SKILL.md": [
        "# Maintenance discovery",
        "",
        "Inspect only. Report concrete R1 maintenance with exact tracked-file evidence."
      ].join("\n")
    }
  });
  const skillPackage = documents.skillPackage(packageInput);
  const skill = skillManifestSchema.parse({
    ...skillPackage.value.manifest,
    packageDigest: skillPackage.digest
  });
  const policy = factoryMaintenanceDiscoveryPolicySchema.parse({
    schemaVersion: "agentlab.maintenance-discovery-policy.v1",
    id: "agentlab/daily-maintenance-discovery",
    version: "1.0.0",
    profile: {
      id: "codex-maintenance-scout",
      provider: "codex",
      model: "gpt-5.4",
      reasoning: "high",
      resourceLimits: {
        maxProcesses: 16,
        maxMemoryBytes: 2 * 1_024 * 1_024 * 1_024,
        cpuQuotaPercent: 200
      }
    },
    skill,
    maximumFindingsPerTick: 3,
    maximumAdmissionsPerTick: 2,
    minimumConfidence: 80,
    allowedChangeClasses: ["bug", "documentation", "tests", "non-behavioral-refactor"],
    allowedIncludePaths: ["README.md", "docs/**", "packages/**", "tests/**", ".github/**"],
    excludedPaths: ["packages/**/dist/**"],
    protectedPaths: [".github/**", "packages/launcher/**"],
    maximumRiskTier: "R1"
  });
  const schedulePolicy = testFactorySchedulePolicy({
    maximumTasksPerTick: 2,
    maximumCandidatesPerTick: 3
  });
  const policyDocument = documents.maintenanceDiscoveryPolicy(policy);
  const scheduleDocument = documents.schedulePolicy(schedulePolicy);
  const run = documents.maintenanceDiscoveryRun({
    schemaVersion: "agentlab.maintenance-discovery-run.v1",
    runId: TEST_MAINTENANCE_DISCOVERY_RUN_ID,
    discoveryPolicyDigest: policyDocument.digest,
    discoveryPolicy: policy,
    schedulePolicyDigest: scheduleDocument.digest,
    schedulePolicy,
    factoryPolicyBundleDigest: testDigest("3"),
    preparationGrantDigest: testDigest("4"),
    roleIdentityPolicyDigest: testDigest("5"),
    repository: { id: "owner/agentlab", baseRevision: "a".repeat(40) },
    scheduledFor: "2026-08-31T12:00:00.000Z",
    deadlineAt: "2026-08-31T12:30:00.000Z",
    createdAt: "2026-08-31T12:05:00.000Z",
    correlationId: TEST_MAINTENANCE_DISCOVERY_CORRELATION_ID
  });
  return {
    documents,
    policy,
    policyDocument,
    schedulePolicy,
    scheduleDocument,
    skill,
    skillPackage: skillPackage.value,
    skillPackageDigest: skillPackage.digest,
    run
  };
}

export function testFactoryMaintenanceDiscoveryOutput(): FactoryMaintenanceDiscoveryOutput {
  return {
    schemaVersion: "agentlab.maintenance-discovery-output.v1",
    findings: [
      {
        findingKey: "docs/missing-factory-boundary",
        changeClass: "documentation",
        proposedRiskTier: "R1",
        priority: 90,
        confidence: 95,
        title: "Document the factory boundary",
        summary: "Clarify the durable daily factory boundary in the operations guide.",
        rationale: "The current guide omits the bounded autonomous intake stage.",
        acceptanceCriteria: ["The daily discovery and canary admission stages are explicit."],
        affectedPaths: ["docs/factory-operations.md"],
        evidence: [
          {
            path: "docs/factory-operations.md",
            lineStart: 1,
            lineEnd: 20,
            observation: "The documented cycle begins at the scheduler."
          }
        ]
      }
    ]
  };
}

export function discoveryBudget(): FactoryMaintenanceDiscoveryPolicy["skill"]["budgetCeiling"] {
  return {
    wallClockSeconds: 900,
    maxAgentTurns: 20,
    maxToolCalls: 100,
    maxInputTokens: 200_000,
    maxOutputTokens: 20_000,
    maxCostMicrousd: 2_000_000,
    maxProcesses: 16,
    maxOutputBytes: 2_000_000,
    maxWorkers: 1,
    maxRepairAttempts: 0,
    maxChangedFiles: 0,
    maxChangedLines: 0
  };
}

function readOnlyCapabilities() {
  return {
    filesystem: "read" as const,
    git: "read" as const,
    remoteRepository: "none" as const,
    process: "sandboxed" as const,
    network: { mode: "off" as const },
    commandAllowlist: [],
    secretRefs: []
  };
}
