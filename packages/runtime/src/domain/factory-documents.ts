import type {
  EvidenceBundle,
  FactoryControlEvent,
  FactoryAgentRunRecord,
  FactoryGateObservation,
  FactoryPatchProposal,
  FactoryPlan,
  FactoryPolicyDecision,
  FactoryPolicyEvaluationRecord,
  FactoryPullRequestProposal,
  FactoryPullRequestRecord,
  FactoryPreparationAuthority,
  FactoryPreparationBundle,
  FactoryPreparationEvent,
  FactoryPreparationRunRecord,
  FactoryPreparationRunRequest,
  FactoryQualification,
  FactoryReviewResult,
  FactoryResourceIsolationRecord,
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
  policyDecision(input: unknown): CanonicalFactoryDocument<FactoryPolicyDecision>;
  policyEvaluation(input: unknown): CanonicalFactoryDocument<FactoryPolicyEvaluationRecord>;
  skillPackage(input: unknown): CanonicalFactoryDocument<FactorySkillPackage>;
  agentRun(input: unknown): CanonicalFactoryDocument<FactoryAgentRunRecord>;
  gateObservation(input: unknown): CanonicalFactoryDocument<FactoryGateObservation>;
  resourceIsolation(input: unknown): CanonicalFactoryDocument<FactoryResourceIsolationRecord>;
  patchProposal(input: unknown): CanonicalFactoryDocument<FactoryPatchProposal>;
  reviewResult(input: unknown): CanonicalFactoryDocument<FactoryReviewResult>;
  pullRequestProposal(input: unknown): CanonicalFactoryDocument<FactoryPullRequestProposal>;
  pullRequestRecord(input: unknown): CanonicalFactoryDocument<FactoryPullRequestRecord>;
  taskUsage(input: unknown): CanonicalFactoryDocument<FactoryTaskUsageRecord>;
}
