import { z } from "zod";

import {
  factoryActorSchema,
  factoryBudgetSchema,
  factoryIdentifierSchema,
  factorySemanticVersionSchema,
  factoryTimestampSchema,
  gitObjectIdSchema,
  sha256DigestSchema
} from "./factory.js";

export const factoryCanaryStageSchema = z.enum([
  "read-only-shadow",
  "local-proposal",
  "brokered-draft-pr"
]);
export type FactoryCanaryStage = z.infer<typeof factoryCanaryStageSchema>;

/** Exact provider-neutral identity of one factory configuration under evaluation. */
export const factoryConfigurationCandidateSchema = z
  .object({
    schemaVersion: z.literal("agentlab.factory-candidate.v1"),
    candidateId: factoryIdentifierSchema,
    version: factorySemanticVersionSchema,
    repositoryId: factoryIdentifierSchema,
    baseRevision: gitObjectIdSchema,
    policyBundleDigest: sha256DigestSchema,
    schedulePolicyDigest: sha256DigestSchema.nullable(),
    harnessDigest: sha256DigestSchema,
    providerConfigurationDigest: sha256DigestSchema,
    skillPackageDigests: z.array(sha256DigestSchema).max(64),
    createdAt: factoryTimestampSchema
  })
  .strict()
  .superRefine((candidate, context) => {
    if (new Set(candidate.skillPackageDigests).size !== candidate.skillPackageDigests.length) {
      context.addIssue({
        code: "custom",
        path: ["skillPackageDigests"],
        message: "Factory candidate skill package digests must be unique."
      });
    }
  });
export type FactoryConfigurationCandidate = z.infer<typeof factoryConfigurationCandidateSchema>;

export const factoryEvalSuiteSchema = z
  .object({
    schemaVersion: z.literal("agentlab.eval-suite.v1"),
    id: z.literal("agentlab/software-factory"),
    version: factorySemanticVersionSchema,
    caseBankDigest: sha256DigestSchema,
    caseIds: z.array(factoryIdentifierSchema).min(1).max(256),
    trialsPerCase: z.number().int().min(2).max(20),
    thresholds: z
      .object({
        minimumChallengerSuccessBasisPoints: z.number().int().min(0).max(10_000),
        minimumChallengerSafetyBasisPoints: z.number().int().min(0).max(10_000),
        minimumSuccessLowerConfidenceBasisPoints: z.number().int().min(0).max(10_000),
        minimumSafetyLowerConfidenceBasisPoints: z.number().int().min(0).max(10_000),
        maximumSuccessRegressionBasisPoints: z.number().int().min(0).max(10_000),
        maximumFalsePositiveBasisPoints: z.number().int().min(0).max(10_000),
        maximumFlakyCaseBasisPoints: z.number().int().min(0).max(10_000),
        maximumCostRatioBasisPoints: z.number().int().min(0).max(1_000_000),
        maximumP95LatencyMilliseconds: z.number().int().min(1).max(86_400_000),
        minimumHumanSampleSize: z.number().int().min(1).max(256)
      })
      .strict(),
    maximumCanaryStage: factoryCanaryStageSchema,
    canaryLimits: z
      .object({
        maximumTasks: z.number().int().min(1).max(32),
        maximumBudget: factoryBudgetSchema,
        maximumLifetimeSeconds: z.number().int().min(3_600).max(604_800)
      })
      .strict()
  })
  .strict()
  .superRefine((suite, context) => {
    if (new Set(suite.caseIds).size !== suite.caseIds.length) {
      context.addIssue({
        code: "custom",
        path: ["caseIds"],
        message: "Eval suite case IDs must be unique."
      });
    }
    if (suite.thresholds.minimumHumanSampleSize > suite.caseIds.length * suite.trialsPerCase) {
      context.addIssue({
        code: "custom",
        path: ["thresholds", "minimumHumanSampleSize"],
        message: "Human sample size cannot exceed the complete matched sample set."
      });
    }
  });
export type FactoryEvalSuite = z.infer<typeof factoryEvalSuiteSchema>;

const evalOutcomeSchema = z
  .object({
    taskSuccess: z.boolean(),
    safetyPass: z.boolean(),
    criticalSafetyViolation: z.boolean(),
    falsePositive: z.boolean(),
    costMicrousd: z.number().int().min(0).max(1_000_000_000_000),
    latencyMilliseconds: z.number().int().min(1).max(86_400_000),
    outputDigest: sha256DigestSchema,
    traceDigest: sha256DigestSchema
  })
  .strict()
  .superRefine((outcome, context) => {
    if (outcome.criticalSafetyViolation && outcome.safetyPass) {
      context.addIssue({
        code: "custom",
        path: ["criticalSafetyViolation"],
        message: "A critical safety violation cannot be recorded as a safety pass."
      });
    }
  });

export const factoryEvalSampleSchema = z
  .object({
    caseId: factoryIdentifierSchema,
    trial: z.number().int().min(1).max(20),
    seedDigest: sha256DigestSchema,
    fixtureDigest: sha256DigestSchema,
    graderEvidenceDigest: sha256DigestSchema,
    baseline: evalOutcomeSchema,
    challenger: evalOutcomeSchema
  })
  .strict();
export type FactoryEvalSample = z.infer<typeof factoryEvalSampleSchema>;

/** Complete matched trials emitted by one credentialless trusted eval runner. */
export const factoryEvalRunSchema = z
  .object({
    schemaVersion: z.literal("agentlab.eval-run.v1"),
    runId: z.uuid(),
    suiteDigest: sha256DigestSchema,
    suite: factoryEvalSuiteSchema,
    baselineCandidateDigest: sha256DigestSchema,
    baselineCandidate: factoryConfigurationCandidateSchema,
    challengerCandidateDigest: sha256DigestSchema,
    challengerCandidate: factoryConfigurationCandidateSchema,
    samples: z.array(factoryEvalSampleSchema).min(2).max(5_120),
    actor: factoryActorSchema,
    startedAt: factoryTimestampSchema,
    completedAt: factoryTimestampSchema,
    correlationId: z.uuid()
  })
  .strict()
  .superRefine((run, context) => {
    if (run.completedAt < run.startedAt) {
      context.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "Eval run completion must not precede its start."
      });
    }
    if (
      (run.actor.kind !== "control-plane" && run.actor.kind !== "ci") ||
      run.actor.role !== "gate-runner"
    ) {
      context.addIssue({
        code: "custom",
        path: ["actor"],
        message: "Eval runs require a trusted gate-runner actor."
      });
    }
    if (run.baselineCandidateDigest === run.challengerCandidateDigest) {
      context.addIssue({
        code: "custom",
        path: ["challengerCandidateDigest"],
        message: "Baseline and challenger candidates must differ."
      });
    }
    const coordinates = run.samples.map(({ caseId, trial }) => `${caseId}\0${String(trial)}`);
    if (new Set(coordinates).size !== coordinates.length) {
      context.addIssue({
        code: "custom",
        path: ["samples"],
        message: "Eval sample case/trial coordinates must be unique."
      });
    }
  });
export type FactoryEvalRun = z.infer<typeof factoryEvalRunSchema>;

export const factoryEvalMetricsSchema = z
  .object({
    caseCount: z.number().int().min(1).max(256),
    sampleCount: z.number().int().min(2).max(5_120),
    baselineSuccessBasisPoints: z.number().int().min(0).max(10_000),
    challengerSuccessBasisPoints: z.number().int().min(0).max(10_000),
    challengerSafetyBasisPoints: z.number().int().min(0).max(10_000),
    successLowerConfidenceBasisPoints: z.number().int().min(0).max(10_000),
    safetyLowerConfidenceBasisPoints: z.number().int().min(0).max(10_000),
    successRegressionBasisPoints: z.number().int().min(0).max(10_000),
    falsePositiveBasisPoints: z.number().int().min(0).max(10_000),
    flakyCaseCount: z.number().int().min(0).max(256),
    flakyCaseBasisPoints: z.number().int().min(0).max(10_000),
    criticalSafetyViolations: z.number().int().min(0).max(5_120),
    baselineCostMicrousd: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    challengerCostMicrousd: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    costRatioBasisPoints: z.number().int().min(0).max(1_000_000),
    challengerP95LatencyMilliseconds: z.number().int().min(1).max(86_400_000)
  })
  .strict();
export type FactoryEvalMetrics = z.infer<typeof factoryEvalMetricsSchema>;

/** Deterministic policy output; a pass still grants no runtime or remote authority. */
export const factoryEvalAssessmentSchema = z
  .object({
    schemaVersion: z.literal("agentlab.eval-assessment.v1"),
    assessmentId: z.uuid(),
    runId: z.uuid(),
    runDigest: sha256DigestSchema,
    suiteDigest: sha256DigestSchema,
    baselineCandidateDigest: sha256DigestSchema,
    challengerCandidateDigest: sha256DigestSchema,
    assessedAt: factoryTimestampSchema,
    metrics: factoryEvalMetricsSchema,
    decision: z.enum(["pass", "deny"]),
    maximumEligibleStage: factoryCanaryStageSchema.nullable(),
    reasonCodes: z.array(factoryIdentifierSchema).max(32),
    actor: factoryActorSchema
  })
  .strict()
  .superRefine((assessment, context) => {
    if (new Set(assessment.reasonCodes).size !== assessment.reasonCodes.length) {
      context.addIssue({
        code: "custom",
        path: ["reasonCodes"],
        message: "Eval assessment reason codes must be unique."
      });
    }
    if (assessment.actor.kind !== "control-plane" || assessment.actor.role !== "policy-engine") {
      context.addIssue({
        code: "custom",
        path: ["actor"],
        message: "Eval assessment requires the deterministic policy actor."
      });
    }
    if ((assessment.decision === "pass") !== (assessment.maximumEligibleStage !== null)) {
      context.addIssue({
        code: "custom",
        path: ["maximumEligibleStage"],
        message: "Only a passing eval assessment may name an eligible canary stage."
      });
    }
  });
export type FactoryEvalAssessment = z.infer<typeof factoryEvalAssessmentSchema>;

/** Owner-authored request for one bounded cohort; the assessment remains a separate immutable pin. */
export const factoryCanaryRequestSchema = z
  .object({
    schemaVersion: z.literal("agentlab.canary-request.v1"),
    stage: factoryCanaryStageSchema,
    repositoryIds: z.array(factoryIdentifierSchema).length(1),
    maximumRiskTier: z.enum(["R0", "R1"]),
    maximumTasks: z.number().int().min(1).max(100),
    budget: factoryBudgetSchema,
    humanSampleReviewDigest: sha256DigestSchema,
    humanSampleSize: z.number().int().min(1).max(256),
    expiresAt: factoryTimestampSchema,
    reason: z.string().trim().min(1).max(500)
  })
  .strict();
export type FactoryCanaryRequest = z.infer<typeof factoryCanaryRequestSchema>;

export const factoryCanaryApprovalSchema = z
  .object({
    schemaVersion: z.literal("agentlab.canary-approval.v1"),
    approvalId: z.uuid(),
    assessmentDigest: sha256DigestSchema,
    challengerCandidateDigest: sha256DigestSchema,
    stage: factoryCanaryStageSchema,
    repositoryIds: z.array(factoryIdentifierSchema).length(1),
    maximumRiskTier: z.enum(["R0", "R1"]),
    maximumTasks: z.number().int().min(1).max(100),
    budget: factoryBudgetSchema,
    humanSampleReviewDigest: sha256DigestSchema,
    humanSampleSize: z.number().int().min(1).max(256),
    actor: factoryActorSchema,
    occurredAt: factoryTimestampSchema,
    expiresAt: factoryTimestampSchema,
    reason: z.string().trim().min(1).max(500)
  })
  .strict()
  .superRefine((approval, context) => {
    if (new Set(approval.repositoryIds).size !== approval.repositoryIds.length) {
      context.addIssue({
        code: "custom",
        path: ["repositoryIds"],
        message: "Canary approval repository IDs must be unique."
      });
    }
    if (approval.actor.kind !== "human" || approval.actor.role !== "release-controller") {
      context.addIssue({
        code: "custom",
        path: ["actor"],
        message: "Canary approval requires a human release controller."
      });
    }
    if (approval.expiresAt <= approval.occurredAt) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Canary approval must expire after it is issued."
      });
    }
  });
export type FactoryCanaryApproval = z.infer<typeof factoryCanaryApprovalSchema>;

/** Bounded cohort authority. Auto-merge and release are structurally impossible in v1. */
export const factoryCanaryCohortSchema = z
  .object({
    schemaVersion: z.literal("agentlab.canary-cohort.v1"),
    cohortId: z.uuid(),
    assessmentDigest: sha256DigestSchema,
    runDigest: sha256DigestSchema,
    challengerCandidateDigest: sha256DigestSchema,
    approvalDigest: sha256DigestSchema,
    stage: factoryCanaryStageSchema,
    repositoryIds: z.array(factoryIdentifierSchema).length(1),
    maximumRiskTier: z.enum(["R0", "R1"]),
    maximumTasks: z.number().int().min(1).max(100),
    budget: factoryBudgetSchema,
    issuedAt: factoryTimestampSchema,
    expiresAt: factoryTimestampSchema,
    autoMerge: z.literal(false),
    release: z.literal(false)
  })
  .strict()
  .superRefine((cohort, context) => {
    if (new Set(cohort.repositoryIds).size !== cohort.repositoryIds.length) {
      context.addIssue({
        code: "custom",
        path: ["repositoryIds"],
        message: "Canary cohort repository IDs must be unique."
      });
    }
    if (cohort.expiresAt <= cohort.issuedAt) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Canary cohort must expire after issuance."
      });
    }
  });
export type FactoryCanaryCohort = z.infer<typeof factoryCanaryCohortSchema>;
