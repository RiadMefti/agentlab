import type {
  FactoryPullRequestAuthorityRecord,
  FactoryPullRequestRecord,
  FactoryPullRequestUpdateRecord,
  Sha256Digest
} from "@agentlab/contracts";

export interface FactoryPullRequestAuthorityCoordinates {
  readonly taskId: string;
  readonly contractDigest: Sha256Digest;
  readonly initialProposalDigest: Sha256Digest;
  readonly repositoryId: string;
  readonly number: number;
  readonly url: string;
  readonly baseRevision: string;
  readonly headRevision: string;
  readonly branchName: string;
  readonly brokerId: string;
}

export function factoryPullRequestAuthorityCoordinates(
  record: FactoryPullRequestAuthorityRecord
): FactoryPullRequestAuthorityCoordinates {
  return {
    taskId: record.taskId,
    contractDigest: record.contractDigest,
    initialProposalDigest:
      record.schemaVersion === "agentlab.pull-request-record.v1"
        ? record.proposalDigest
        : record.initialProposalDigest,
    repositoryId: record.repositoryId,
    number: record.number,
    url: record.url,
    baseRevision: record.baseRevision,
    headRevision: record.headRevision,
    branchName: record.branchName,
    brokerId: record.brokerId
  };
}

export function isInitialPullRequestRecord(
  record: FactoryPullRequestAuthorityRecord
): record is FactoryPullRequestRecord {
  return record.schemaVersion === "agentlab.pull-request-record.v1";
}

export function isPullRequestUpdateRecord(
  record: FactoryPullRequestAuthorityRecord
): record is FactoryPullRequestUpdateRecord {
  return record.schemaVersion === "agentlab.pull-request-update-record.v1";
}
