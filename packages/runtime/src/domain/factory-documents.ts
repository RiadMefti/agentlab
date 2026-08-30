import type {
  EvidenceBundle,
  FactoryControlEvent,
  FactoryAgentRunRecord,
  FactoryGateObservation,
  FactoryPatchProposal,
  FactoryPolicyDecision,
  FactoryPolicyEvaluationRecord,
  FactoryPullRequestProposal,
  FactoryPullRequestRecord,
  FactoryReviewResult,
  FactorySkillPackage,
  FactoryTaskUsageRecord,
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
  taskContract(input: unknown): CanonicalFactoryDocument<ImmutableTaskContract>;
  taskEvent(input: unknown): CanonicalFactoryDocument<TaskEvent>;
  evidenceBundle(input: unknown): CanonicalFactoryDocument<EvidenceBundle>;
  controlEvent(input: unknown): CanonicalFactoryDocument<FactoryControlEvent>;
  policyDecision(input: unknown): CanonicalFactoryDocument<FactoryPolicyDecision>;
  policyEvaluation(input: unknown): CanonicalFactoryDocument<FactoryPolicyEvaluationRecord>;
  skillPackage(input: unknown): CanonicalFactoryDocument<FactorySkillPackage>;
  agentRun(input: unknown): CanonicalFactoryDocument<FactoryAgentRunRecord>;
  gateObservation(input: unknown): CanonicalFactoryDocument<FactoryGateObservation>;
  patchProposal(input: unknown): CanonicalFactoryDocument<FactoryPatchProposal>;
  reviewResult(input: unknown): CanonicalFactoryDocument<FactoryReviewResult>;
  pullRequestProposal(input: unknown): CanonicalFactoryDocument<FactoryPullRequestProposal>;
  pullRequestRecord(input: unknown): CanonicalFactoryDocument<FactoryPullRequestRecord>;
  taskUsage(input: unknown): CanonicalFactoryDocument<FactoryTaskUsageRecord>;
}
