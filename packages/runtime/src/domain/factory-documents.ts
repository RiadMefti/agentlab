import type {
  EvidenceBundle,
  FactoryControlEvent,
  FactoryCanaryApproval,
  FactoryCanaryCohort,
  FactoryCanaryTaskReservation,
  FactoryConfigurationCandidate,
  FactoryEvalAssessment,
  FactoryEvalAttestationRecord,
  FactoryEvalAttestationStatement,
  FactoryEvalCaseBank,
  FactoryEvalGraderDescriptor,
  FactoryEvalGraderEvidence,
  FactoryEvalGraderRequest,
  FactoryEvalInvocationFailureEvidence,
  FactoryEvalHarnessDescriptor,
  FactoryEvalProductionEvent,
  FactoryEvalProductionJob,
  FactoryEvalSample,
  FactoryEvalSubjectEvidence,
  FactoryEvalSubjectRequest,
  FactoryExternalPullRequestCandidate,
  FactoryExternalPullRequestFeedbackEvent,
  FactoryExternalPullRequestFeedbackPolicy,
  FactoryExternalPullRequestFeedbackRecord,
  FactoryExternalPullRequestFeedbackRun,
  FactoryExternalPullRequestRepairAdmissionPolicy,
  FactoryExternalPullRequestRepairAuthorization,
  FactoryExternalPullRequestRepairDecision,
  FactoryExternalPullRequestDiscoveryEvent,
  FactoryExternalPullRequestDiscoveryPolicy,
  FactoryExternalPullRequestDiscoveryRun,
  FactoryExternalPullRequestDiscoverySnapshot,
  FactoryExternalPullRequestReviewBundle,
  FactoryExternalPullRequestReviewEvent,
  FactoryExternalPullRequestReviewPolicy,
  FactoryExternalPullRequestReviewResult,
  FactoryExternalPullRequestReviewerRecord,
  FactoryExternalPullRequestReviewerRequest,
  FactoryExternalPullRequestReviewRun,
  FactoryEvalRun,
  FactoryEvalSuite,
  FactoryDsseEnvelope,
  FactorySignedEvalAttestation,
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
  FactoryRoleIdentityPolicy,
  FactoryScheduleEvent,
  FactorySchedulePolicy,
  FactoryScheduleRun,
  FactorySkillPackage,
  FactoryTaskUsageRecord,
  FactoryIntakeRequest,
  FactoryMaintenanceDiscoveryEvent,
  FactoryMaintenanceDiscoveryOutput,
  FactoryMaintenanceDiscoveryPolicy,
  FactoryMaintenanceDiscoveryRun,
  FactoryMaintenanceDiscoveryRunRecord,
  FactoryMaintenanceDiscoveryRunRequest,
  FactoryMaintenanceFinding,
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
  externalPullRequestRepairAdmissionPolicy(
    input: unknown
  ): CanonicalFactoryDocument<FactoryExternalPullRequestRepairAdmissionPolicy>;
  externalPullRequestRepairAuthorization(
    input: unknown
  ): CanonicalFactoryDocument<FactoryExternalPullRequestRepairAuthorization>;
  externalPullRequestRepairDecision(
    input: unknown
  ): CanonicalFactoryDocument<FactoryExternalPullRequestRepairDecision>;
  externalPullRequestFeedbackPolicy(
    input: unknown
  ): CanonicalFactoryDocument<FactoryExternalPullRequestFeedbackPolicy>;
  externalPullRequestFeedbackRun(
    input: unknown
  ): CanonicalFactoryDocument<FactoryExternalPullRequestFeedbackRun>;
  externalPullRequestFeedbackEvent(
    input: unknown
  ): CanonicalFactoryDocument<FactoryExternalPullRequestFeedbackEvent>;
  externalPullRequestFeedbackRecord(
    input: unknown
  ): CanonicalFactoryDocument<FactoryExternalPullRequestFeedbackRecord>;
  externalPullRequestReviewPolicy(
    input: unknown
  ): CanonicalFactoryDocument<FactoryExternalPullRequestReviewPolicy>;
  externalPullRequestReviewRun(
    input: unknown
  ): CanonicalFactoryDocument<FactoryExternalPullRequestReviewRun>;
  externalPullRequestReviewEvent(
    input: unknown
  ): CanonicalFactoryDocument<FactoryExternalPullRequestReviewEvent>;
  externalPullRequestReviewerRequest(
    input: unknown
  ): CanonicalFactoryDocument<FactoryExternalPullRequestReviewerRequest>;
  externalPullRequestReviewerRecord(
    input: unknown
  ): CanonicalFactoryDocument<FactoryExternalPullRequestReviewerRecord>;
  externalPullRequestReviewResult(
    input: unknown
  ): CanonicalFactoryDocument<FactoryExternalPullRequestReviewResult>;
  externalPullRequestReviewBundle(
    input: unknown
  ): CanonicalFactoryDocument<FactoryExternalPullRequestReviewBundle>;
  externalPullRequestDiscoveryPolicy(
    input: unknown
  ): CanonicalFactoryDocument<FactoryExternalPullRequestDiscoveryPolicy>;
  externalPullRequestDiscoveryRun(
    input: unknown
  ): CanonicalFactoryDocument<FactoryExternalPullRequestDiscoveryRun>;
  externalPullRequestDiscoveryEvent(
    input: unknown
  ): CanonicalFactoryDocument<FactoryExternalPullRequestDiscoveryEvent>;
  externalPullRequestDiscoverySnapshot(
    input: unknown
  ): CanonicalFactoryDocument<FactoryExternalPullRequestDiscoverySnapshot>;
  externalPullRequestCandidate(
    input: unknown
  ): CanonicalFactoryDocument<FactoryExternalPullRequestCandidate>;
  intakeRequest(input: unknown): CanonicalFactoryDocument<FactoryIntakeRequest>;
  maintenanceDiscoveryPolicy(
    input: unknown
  ): CanonicalFactoryDocument<FactoryMaintenanceDiscoveryPolicy>;
  maintenanceDiscoveryRun(input: unknown): CanonicalFactoryDocument<FactoryMaintenanceDiscoveryRun>;
  maintenanceDiscoveryEvent(
    input: unknown
  ): CanonicalFactoryDocument<FactoryMaintenanceDiscoveryEvent>;
  maintenanceDiscoveryRunRequest(
    input: unknown
  ): CanonicalFactoryDocument<FactoryMaintenanceDiscoveryRunRequest>;
  maintenanceDiscoveryRunRecord(
    input: unknown
  ): CanonicalFactoryDocument<FactoryMaintenanceDiscoveryRunRecord>;
  maintenanceDiscoveryOutput(
    input: unknown
  ): CanonicalFactoryDocument<FactoryMaintenanceDiscoveryOutput>;
  maintenanceFinding(input: unknown): CanonicalFactoryDocument<FactoryMaintenanceFinding>;
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
  configurationCandidate(input: unknown): CanonicalFactoryDocument<FactoryConfigurationCandidate>;
  evalSuite(input: unknown): CanonicalFactoryDocument<FactoryEvalSuite>;
  evalCaseBank(input: unknown): CanonicalFactoryDocument<FactoryEvalCaseBank>;
  evalHarnessDescriptor(input: unknown): CanonicalFactoryDocument<FactoryEvalHarnessDescriptor>;
  evalGraderDescriptor(input: unknown): CanonicalFactoryDocument<FactoryEvalGraderDescriptor>;
  evalProductionJob(input: unknown): CanonicalFactoryDocument<FactoryEvalProductionJob>;
  evalProductionEvent(input: unknown): CanonicalFactoryDocument<FactoryEvalProductionEvent>;
  evalSubjectRequest(input: unknown): CanonicalFactoryDocument<FactoryEvalSubjectRequest>;
  evalSubjectEvidence(input: unknown): CanonicalFactoryDocument<FactoryEvalSubjectEvidence>;
  evalGraderRequest(input: unknown): CanonicalFactoryDocument<FactoryEvalGraderRequest>;
  evalGraderEvidence(input: unknown): CanonicalFactoryDocument<FactoryEvalGraderEvidence>;
  evalInvocationFailureEvidence(
    input: unknown
  ): CanonicalFactoryDocument<FactoryEvalInvocationFailureEvidence>;
  evalSample(input: unknown): CanonicalFactoryDocument<FactoryEvalSample>;
  evalRun(input: unknown): CanonicalFactoryDocument<FactoryEvalRun>;
  evalAssessment(input: unknown): CanonicalFactoryDocument<FactoryEvalAssessment>;
  evalAttestationStatement(
    input: unknown
  ): CanonicalFactoryDocument<FactoryEvalAttestationStatement>;
  dsseEnvelope(input: unknown): CanonicalFactoryDocument<FactoryDsseEnvelope>;
  signedEvalAttestation(input: unknown): CanonicalFactoryDocument<FactorySignedEvalAttestation>;
  evalAttestationRecord(input: unknown): CanonicalFactoryDocument<FactoryEvalAttestationRecord>;
  canaryApproval(input: unknown): CanonicalFactoryDocument<FactoryCanaryApproval>;
  canaryCohort(input: unknown): CanonicalFactoryDocument<FactoryCanaryCohort>;
  canaryTaskReservation(input: unknown): CanonicalFactoryDocument<FactoryCanaryTaskReservation>;
  executionRun(input: unknown): CanonicalFactoryDocument<FactoryExecutionRun>;
  executionEvent(input: unknown): CanonicalFactoryDocument<FactoryExecutionEvent>;
  policyDecision(input: unknown): CanonicalFactoryDocument<FactoryPolicyDecision>;
  policyEvaluation(input: unknown): CanonicalFactoryDocument<FactoryPolicyEvaluationRecord>;
  skillPackage(input: unknown): CanonicalFactoryDocument<FactorySkillPackage>;
  agentRun(input: unknown): CanonicalFactoryDocument<FactoryAgentRunRecord>;
  agentRunRequest(input: unknown): CanonicalFactoryDocument<FactoryAgentRunRequest>;
  gateObservation(input: unknown): CanonicalFactoryDocument<FactoryGateObservation>;
  resourceIsolation(input: unknown): CanonicalFactoryDocument<FactoryResourceIsolationRecord>;
  roleIdentityPolicy(input: unknown): CanonicalFactoryDocument<FactoryRoleIdentityPolicy>;
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
