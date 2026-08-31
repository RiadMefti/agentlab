import type {
  EvidenceBundle,
  FactoryControlEvent,
  FactoryAgentRunRequest,
  FactoryExecutionEvent,
  FactoryExecutionRun,
  FactoryAgentRunRecord,
  FactoryGateObservation,
  FactoryPatchProposal,
  FactoryPlan,
  FactoryPolicyDecision,
  FactoryPolicyEvaluationRecord,
  FactoryPullRequestObservation,
  FactoryPullRequestRepairAuthorization,
  FactoryPullRequestRepairRun,
  FactoryPullRequestProposal,
  FactoryPullRequestRecord,
  FactoryPullRequestDispatchEvent,
  FactoryPullRequestDispatchRun,
  FactoryPullRequestAuthorityRecord,
  FactoryPullRequestUpdateEvent,
  FactoryPullRequestUpdateProposal,
  FactoryPullRequestUpdateRecord,
  FactoryPullRequestUpdateRun,
  FactoryPreparationAuthority,
  FactoryPreparationBundle,
  FactoryPreparationEvent,
  FactoryPreparationRunRecord,
  FactoryPreparationRunRequest,
  FactoryQualification,
  FactoryReviewResult,
  FactoryResourceIsolationRecord,
  FactoryScheduleEvent,
  FactorySchedulePolicy,
  FactoryScheduleRun,
  FactorySkillPackage,
  FactoryTaskUsageRecord,
  FactoryIntakeRequest,
  FactorySpecification,
  ImmutableTaskContract,
  Sha256Digest,
  TaskEvent
} from "@agentlab/contracts";

export interface CanonicalFactoryDocument<Value> {
  readonly value: Value;
  readonly json: string;
  readonly digest: Sha256Digest;
}

/** Canonical encoding and hashing port; callers never hash ad-hoc JSON. */
export interface FactoryDocumentCodec {
  intakeRequest(input: unknown): CanonicalFactoryDocument<FactoryIntakeRequest>;
  qualification(input: unknown): CanonicalFactoryDocument<FactoryQualification>;
  specification(input: unknown): CanonicalFactoryDocument<FactorySpecification>;
  plan(input: unknown): CanonicalFactoryDocument<FactoryPlan>;
  preparationAuthority(input: unknown): CanonicalFactoryDocument<FactoryPreparationAuthority>;
  preparationBundle(input: unknown): CanonicalFactoryDocument<FactoryPreparationBundle>;
  preparationEvent(input: unknown): CanonicalFactoryDocument<FactoryPreparationEvent>;
  preparationRunRequest(input: unknown): CanonicalFactoryDocument<FactoryPreparationRunRequest>;
  preparationRunRecord(input: unknown): CanonicalFactoryDocument<FactoryPreparationRunRecord>;
  taskContract(input: unknown): CanonicalFactoryDocument<ImmutableTaskContract>;
  taskEvent(input: unknown): CanonicalFactoryDocument<TaskEvent>;
  evidenceBundle(input: unknown): CanonicalFactoryDocument<EvidenceBundle>;
  controlEvent(input: unknown): CanonicalFactoryDocument<FactoryControlEvent>;
  executionRun(input: unknown): CanonicalFactoryDocument<FactoryExecutionRun>;
  executionEvent(input: unknown): CanonicalFactoryDocument<FactoryExecutionEvent>;
  policyDecision(input: unknown): CanonicalFactoryDocument<FactoryPolicyDecision>;
  policyEvaluation(input: unknown): CanonicalFactoryDocument<FactoryPolicyEvaluationRecord>;
  skillPackage(input: unknown): CanonicalFactoryDocument<FactorySkillPackage>;
  agentRun(input: unknown): CanonicalFactoryDocument<FactoryAgentRunRecord>;
  agentRunRequest(input: unknown): CanonicalFactoryDocument<FactoryAgentRunRequest>;
  gateObservation(input: unknown): CanonicalFactoryDocument<FactoryGateObservation>;
  resourceIsolation(input: unknown): CanonicalFactoryDocument<FactoryResourceIsolationRecord>;
  schedulePolicy(input: unknown): CanonicalFactoryDocument<FactorySchedulePolicy>;
  scheduleRun(input: unknown): CanonicalFactoryDocument<FactoryScheduleRun>;
  scheduleEvent(input: unknown): CanonicalFactoryDocument<FactoryScheduleEvent>;
  patchProposal(input: unknown): CanonicalFactoryDocument<FactoryPatchProposal>;
  reviewResult(input: unknown): CanonicalFactoryDocument<FactoryReviewResult>;
  pullRequestObservation(input: unknown): CanonicalFactoryDocument<FactoryPullRequestObservation>;
  pullRequestRepairAuthorization(
    input: unknown
  ): CanonicalFactoryDocument<FactoryPullRequestRepairAuthorization>;
  pullRequestRepairRun(input: unknown): CanonicalFactoryDocument<FactoryPullRequestRepairRun>;
  pullRequestProposal(input: unknown): CanonicalFactoryDocument<FactoryPullRequestProposal>;
  pullRequestRecord(input: unknown): CanonicalFactoryDocument<FactoryPullRequestRecord>;
  pullRequestAuthorityRecord(
    input: unknown
  ): CanonicalFactoryDocument<FactoryPullRequestAuthorityRecord>;
  pullRequestUpdateProposal(
    input: unknown
  ): CanonicalFactoryDocument<FactoryPullRequestUpdateProposal>;
  pullRequestUpdateRecord(input: unknown): CanonicalFactoryDocument<FactoryPullRequestUpdateRecord>;
  pullRequestUpdateRun(input: unknown): CanonicalFactoryDocument<FactoryPullRequestUpdateRun>;
  pullRequestUpdateEvent(input: unknown): CanonicalFactoryDocument<FactoryPullRequestUpdateEvent>;
  pullRequestDispatchRun(input: unknown): CanonicalFactoryDocument<FactoryPullRequestDispatchRun>;
  pullRequestDispatchEvent(
    input: unknown
  ): CanonicalFactoryDocument<FactoryPullRequestDispatchEvent>;
  taskUsage(input: unknown): CanonicalFactoryDocument<FactoryTaskUsageRecord>;
}
