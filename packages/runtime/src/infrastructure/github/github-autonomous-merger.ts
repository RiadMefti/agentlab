import {
  gitObjectIdSchema,
  type FactoryAutonomousMergeAuthorization,
  type FactoryAutonomousMergeRecord
} from "@agentlab/contracts";
import { z } from "zod";

import {
  FactoryAutonomousMergeQuarantineError,
  type FactoryAutonomousMerger,
  type FactoryAutonomousMergerIdentity,
  type FactoryAutonomousMergeEnqueueResult,
  type FactoryAutonomousMergeRemoteSnapshot
} from "../../domain/factory-autonomous-merge-broker.js";
import type { GitHubGraphqlApi } from "./github-graphql-client.js";

const graphqlIdSchema = z.string().trim().min(1).max(256);
const pullRequestSchema = z
  .object({
    id: graphqlIdSchema,
    number: z.number().int().positive(),
    url: z.url().max(2_048),
    state: z.enum(["OPEN", "CLOSED", "MERGED"]),
    isDraft: z.boolean(),
    merged: z.boolean(),
    mergedAt: z.iso.datetime().nullable(),
    baseRefOid: gitObjectIdSchema,
    headRefOid: gitObjectIdSchema,
    mergeCommit: z.object({ oid: gitObjectIdSchema }).nullable(),
    mergeQueueEntry: z.object({ id: graphqlIdSchema }).nullable()
  })
  .strict();

const queryResponseSchema = z
  .object({
    data: z
      .object({
        repository: z.object({ pullRequest: pullRequestSchema.nullable() }).nullable()
      })
      .nullable()
      .optional(),
    errors: z
      .array(z.object({ message: z.string().max(1_024) }))
      .max(32)
      .optional()
  })
  .loose();

const markReadyResponseSchema = z
  .object({
    data: z
      .object({
        markPullRequestReadyForReview: z.object({ pullRequest: pullRequestSchema }).nullable()
      })
      .nullable()
      .optional(),
    errors: z
      .array(z.object({ message: z.string().max(1_024) }))
      .max(32)
      .optional()
  })
  .loose();

const enqueueResponseSchema = z
  .object({
    data: z
      .object({
        enqueuePullRequest: z
          .object({ mergeQueueEntry: z.object({ id: graphqlIdSchema }) })
          .nullable()
      })
      .nullable()
      .optional(),
    errors: z
      .array(z.object({ message: z.string().max(1_024) }))
      .max(32)
      .optional()
  })
  .loose();

const pullRequestQuery = `
  query AgentLabAutonomousMergePullRequest($owner: String!, $name: String!, $number: Int!) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $number) {
        id number url state isDraft merged mergedAt baseRefOid headRefOid
        mergeCommit { oid }
        mergeQueueEntry { id }
      }
    }
  }
`;

const markReadyMutation = `
  mutation AgentLabMarkPullRequestReadyForReview(
    $input: MarkPullRequestReadyForReviewInput!
  ) {
    markPullRequestReadyForReview(input: $input) {
      pullRequest {
        id number url state isDraft merged mergedAt baseRefOid headRefOid
        mergeCommit { oid }
        mergeQueueEntry { id }
      }
    }
  }
`;

const enqueueMutation = `
  mutation AgentLabEnqueuePullRequest($input: EnqueuePullRequestInput!) {
    enqueuePullRequest(input: $input) { mergeQueueEntry { id } }
  }
`;

export interface GitHubAutonomousMergerOptions {
  readonly repositoryId: string;
  readonly mergerId: string;
  readonly api: GitHubGraphqlApi;
}

/** Fixed GraphQL adapter: read exact PR, mark ready, enqueue, and reconcile ambiguous responses. */
export class GitHubAutonomousMerger implements FactoryAutonomousMerger {
  readonly #repositoryId: string;
  readonly #owner: string;
  readonly #name: string;
  readonly #mergerId: string;

  public constructor(private readonly options: GitHubAutonomousMergerOptions) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/u.test(options.repositoryId)) {
      throw new Error("GitHub autonomous merger repository must be a lowercase owner/name pair.");
    }
    if (!/^[a-z0-9][a-z0-9._/-]*$/u.test(options.mergerId)) {
      throw new Error("GitHub autonomous merger ID is invalid.");
    }
    const [owner, name] = options.repositoryId.split("/");
    if (owner === undefined || name === undefined) throw new Error("GitHub repository is invalid.");
    this.#repositoryId = options.repositoryId;
    this.#owner = owner;
    this.#name = name;
    this.#mergerId = options.mergerId;
  }

  public identity(): FactoryAutonomousMergerIdentity {
    return { repositoryId: this.#repositoryId, mergerId: this.#mergerId };
  }

  public async observe(
    authorization: FactoryAutonomousMergeAuthorization
  ): Promise<FactoryAutonomousMergeRemoteSnapshot> {
    this.#assertAuthorization(authorization);
    const response = queryResponseSchema.parse(
      await this.options.api.request(pullRequestQuery, this.#queryVariables(authorization))
    );
    assertNoGraphqlErrors(response.errors);
    const pullRequest = response.data?.repository?.pullRequest;
    if (pullRequest === null || pullRequest === undefined) {
      throw new FactoryAutonomousMergeQuarantineError(
        "GitHub no longer returns the authorized pull request."
      );
    }
    return this.#snapshot(pullRequest);
  }

  public async markReadyForReview(
    authorization: FactoryAutonomousMergeAuthorization
  ): Promise<FactoryAutonomousMergeRemoteSnapshot> {
    const before = await this.observe(authorization);
    this.#assertSnapshotIdentity(authorization, before);
    if (!before.draft) return before;
    try {
      const response = markReadyResponseSchema.parse(
        await this.options.api.request(markReadyMutation, {
          input: {
            pullRequestId: before.pullRequestNodeId,
            clientMutationId: authorization.authorizationId
          }
        })
      );
      assertNoGraphqlErrors(response.errors);
      const pullRequest = response.data?.markPullRequestReadyForReview?.pullRequest;
      if (pullRequest === undefined) throw new Error("GitHub omitted the ready-for-review result.");
      this.#assertSnapshotIdentity(authorization, this.#snapshot(pullRequest));
    } catch (error: unknown) {
      const reconciled = await this.observe(authorization);
      if (!reconciled.draft) return reconciled;
      throw error;
    }
    return this.observe(authorization);
  }

  public async enqueue(
    authorization: FactoryAutonomousMergeAuthorization
  ): Promise<FactoryAutonomousMergeEnqueueResult> {
    const before = await this.observe(authorization);
    this.#assertSnapshotIdentity(authorization, before);
    if (before.mergeQueueEntryId !== null) {
      return { snapshot: before, mergeQueueEntryId: before.mergeQueueEntryId, created: false };
    }
    if (before.merged) {
      throw new FactoryAutonomousMergeQuarantineError(
        "GitHub reports a merge without the journal's merge-queue entry identity."
      );
    }
    let mergeQueueEntryId: string;
    try {
      const response = enqueueResponseSchema.parse(
        await this.options.api.request(enqueueMutation, {
          input: {
            pullRequestId: before.pullRequestNodeId,
            expectedHeadOid: authorization.expectedHeadRevision,
            clientMutationId: authorization.authorizationId
          }
        })
      );
      assertNoGraphqlErrors(response.errors);
      mergeQueueEntryId = required(
        response.data?.enqueuePullRequest?.mergeQueueEntry.id,
        "merge-queue entry"
      );
    } catch (error: unknown) {
      const reconciled = await this.observe(authorization);
      if (reconciled.mergeQueueEntryId !== null) {
        return {
          snapshot: reconciled,
          mergeQueueEntryId: reconciled.mergeQueueEntryId,
          created: false
        };
      }
      throw error;
    }
    const snapshot = await this.observe(authorization);
    if (snapshot.mergeQueueEntryId !== null && snapshot.mergeQueueEntryId !== mergeQueueEntryId) {
      throw new FactoryAutonomousMergeQuarantineError(
        "GitHub merge-queue entry changed during enqueue readback."
      );
    }
    return { snapshot, mergeQueueEntryId, created: true };
  }

  public async verifyRecord(
    authorization: FactoryAutonomousMergeAuthorization,
    record: FactoryAutonomousMergeRecord
  ): Promise<void> {
    const snapshot = await this.observe(authorization);
    this.#assertSnapshotIdentity(authorization, snapshot);
    if (
      !snapshot.merged ||
      snapshot.state !== "closed" ||
      snapshot.mergedRevision !== record.mergedRevision ||
      snapshot.mergedAt !== record.mergedAt ||
      record.expectedHeadRevision !== authorization.expectedHeadRevision
    ) {
      throw new FactoryAutonomousMergeQuarantineError(
        "GitHub merge readback does not match the durable merge record."
      );
    }
  }

  #queryVariables(authorization: FactoryAutonomousMergeAuthorization) {
    return {
      owner: this.#owner,
      name: this.#name,
      number: authorization.pullRequestNumber
    };
  }

  #snapshot(pullRequest: z.infer<typeof pullRequestSchema>): FactoryAutonomousMergeRemoteSnapshot {
    return {
      repositoryId: this.#repositoryId,
      pullRequestNodeId: pullRequest.id,
      pullRequestNumber: pullRequest.number,
      pullRequestUrl: pullRequest.url,
      state: pullRequest.state === "OPEN" ? "open" : "closed",
      draft: pullRequest.isDraft,
      merged: pullRequest.merged || pullRequest.state === "MERGED",
      baseRevision: pullRequest.baseRefOid,
      headRevision: pullRequest.headRefOid,
      mergeQueueEntryId: pullRequest.mergeQueueEntry?.id ?? null,
      mergedRevision: pullRequest.mergeCommit?.oid ?? null,
      mergedAt: pullRequest.mergedAt
    };
  }

  #assertAuthorization(authorization: FactoryAutonomousMergeAuthorization): void {
    if (authorization.repositoryId !== this.#repositoryId) {
      throw new Error("GitHub autonomous merger received authority outside its fixed boundary.");
    }
  }

  #assertSnapshotIdentity(
    authorization: FactoryAutonomousMergeAuthorization,
    snapshot: FactoryAutonomousMergeRemoteSnapshot
  ): void {
    if (
      snapshot.repositoryId !== authorization.repositoryId ||
      snapshot.pullRequestNumber !== authorization.pullRequestNumber ||
      snapshot.pullRequestUrl !== authorization.pullRequestUrl ||
      snapshot.baseRevision !== authorization.expectedBaseRevision ||
      snapshot.headRevision !== authorization.expectedHeadRevision
    ) {
      throw new FactoryAutonomousMergeQuarantineError(
        "GitHub pull request changed its authorized repository, URL, base, or head."
      );
    }
  }
}

function assertNoGraphqlErrors(errors: readonly { readonly message: string }[] | undefined): void {
  if (errors !== undefined && errors.length > 0) {
    throw new Error("GitHub rejected the bounded autonomous merge operation.");
  }
}

function required<Value>(value: Value | null | undefined, label: string): Value {
  if (value === null || value === undefined) throw new Error(`GitHub omitted ${label}.`);
  return value;
}
