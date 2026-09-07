import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  FactoryExternalPullRequestRepairQualificationBundle,
  FactoryExternalPullRequestReplacementDraftEvent,
  FactoryExternalPullRequestReplacementDraftPolicy,
  FactoryExternalPullRequestReplacementDraftRecord,
  FactoryExternalPullRequestReplacementDraftRun
} from "@agentlab/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { FactoryExternalPullRequestReplacementDraftService } from "../../packages/runtime/src/application/factory-external-pull-request-replacement-draft-service.js";
import type { FactoryExternalPullRequestReplacementDraftBroker } from "../../packages/runtime/src/domain/factory-external-pull-request-replacement-draft-broker.js";
import type {
  FactoryExternalPullRequestReplacementDraftCandidate,
  FactoryExternalPullRequestReplacementDraftJournalSnapshot,
  FactoryExternalPullRequestReplacementDraftRepository
} from "../../packages/runtime/src/domain/factory-external-pull-request-replacement-draft-repository.js";
import type { CanonicalFactoryDocument } from "../../packages/runtime/src/domain/factory-documents.js";
import { FileFactoryArtifactStore } from "../../packages/runtime/src/infrastructure/filesystem/file-factory-artifact-store.js";
import {
  externalPullRequestRepairQualificationRun,
  testExternalPullRequestRepairQualificationFixture
} from "../helpers/factory-external-pull-request-repair-qualification.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("FactoryExternalPullRequestReplacementDraftService", () => {
  it("records both durable intents before the exact remote effects and completes verification", async () => {
    const fixture = await serviceFixture();
    const result = await fixture.service.tick(pins(fixture));
    expect(result).toMatchObject({ status: "completed", completed: 1, stale: 0, blocked: 0 });
    expect(fixture.repository.snapshot?.history.map(({ kind }) => kind)).toEqual([
      "registered",
      "branch-publish-intent-recorded",
      "branch-published",
      "pull-request-open-intent-recorded",
      "pull-request-opened",
      "completed"
    ]);
    expect(fixture.remote.stateAtBranchWrite).toBe("branch-publish-intent-recorded");
    expect(fixture.remote.stateAtDraftWrite).toBe("pull-request-open-intent-recorded");
    expect(fixture.remote.proposal?.branchName).toMatch(/^agentlab\/external-repair\/pr-42-/u);
    expect(fixture.remote.proposal?.body).toContain("does not modify the contributor's branch");
  });

  it("blocks before registration when either scheduler or broker authority is disabled", async () => {
    const fixture = await serviceFixture({ scheduler: true, prBroker: false });
    await expect(fixture.service.preflight()).resolves.toMatchObject({
      status: "blocked",
      reasonCodes: ["pr-broker-disabled"]
    });
    await expect(fixture.service.tick(pins(fixture))).resolves.toMatchObject({
      status: "blocked",
      inspected: 0
    });
    expect(fixture.remote.branchWrites).toBe(0);
    expect(fixture.repository.snapshot).toBeNull();
  });

  it("terminally marks a moved original head stale without a remote mutation", async () => {
    const fixture = await serviceFixture();
    fixture.remote.originalHead = "f".repeat(40);
    await expect(fixture.service.tick(pins(fixture))).resolves.toMatchObject({
      status: "blocked",
      stale: 1
    });
    expect(fixture.repository.snapshot?.state).toBe("stale");
    expect(fixture.remote.branchWrites).toBe(0);
  });

  it("quarantines a remotely drifted draft instead of fabricating completion", async () => {
    const fixture = await serviceFixture();
    fixture.remote.failVerification = true;
    await expect(fixture.service.tick(pins(fixture))).resolves.toMatchObject({
      status: "blocked",
      quarantined: 1
    });
    expect(fixture.repository.snapshot?.state).toBe("quarantined");
    expect(fixture.repository.snapshot?.record?.replacementPullRequestNumber).toBe(99);
  });
});

async function serviceFixture(controls = { scheduler: true, prBroker: true }) {
  const qualification = testExternalPullRequestRepairQualificationFixture();
  const qualificationRun = externalPullRequestRepairQualificationRun(qualification);
  const qualificationBundle = {
    value: {
      qualificationRunId: qualificationRun.value.qualificationRunId,
      runDigest: qualificationRun.digest,
      repositoryId: qualificationRun.value.repositoryId,
      pullRequestNumber: qualificationRun.value.pullRequestNumber,
      repairBundleDigest: qualification.repairBundle.digest,
      qualificationPolicyDigest: qualification.policyDocument.digest,
      repairedPatchArtifact: qualification.repairBundle.value.patchArtifact,
      changeSet: qualification.repairBundle.value.changeSet,
      decision: "qualified",
      publicationMode: "replacement-draft",
      remoteWrite: false
    },
    digest: `sha256:${"b".repeat(64)}`,
    json: ""
  } as unknown as CanonicalFactoryDocument<FactoryExternalPullRequestRepairQualificationBundle>;
  const candidate: FactoryExternalPullRequestReplacementDraftCandidate = {
    qualificationRun,
    qualificationBundle,
    repairBundle: qualification.repairBundle
  };
  const policy = qualification.documents.externalPullRequestReplacementDraftPolicy({
    schemaVersion: "agentlab.external-pull-request-replacement-draft-policy.v1",
    id: "agentlab/external-pull-request-replacement-draft",
    version: "1.0.0",
    repositoryId: qualificationRun.value.repositoryId,
    brokerId: "github-app/external-repair",
    publisherId: "github-user/77",
    brokerUserId: 1003,
    qualificationPolicyDigest: qualification.policyDocument.digest,
    roleIdentityPolicyDigest: qualification.policy.roleIdentityPolicyDigest,
    branchPrefix: "agentlab/external-repair",
    requiredStatusChecks: ["verify", "factory-sandbox"],
    maximumPatchBytes: qualification.policy.maximumPatchBytes,
    maximumCandidatesPerTick: 3,
    operationDeadlineSeconds: 900,
    maximumRiskTier: "R1",
    draft: true,
    contributorBranchWrite: false,
    forcePush: false,
    approval: false,
    autoMerge: false,
    release: false
  });
  const root = mkdtempSync(join(tmpdir(), "agentlab-replacement-service-"));
  roots.push(root);
  const artifacts = new FileFactoryArtifactStore(join(root, "artifacts"));
  await artifacts.putText(qualification.repairedPatch);
  const repository = new MemoryRepository(candidate, qualification.documents);
  const remote = new FakeBroker(
    repository,
    qualificationRun.value.repositoryId,
    qualificationRun.value.expectedBaseRevision,
    qualificationRun.value.expectedHeadRevision,
    qualification.documents
  );
  const service = new FactoryExternalPullRequestReplacementDraftService({
    repositoryRoot: "/srv/agentlab",
    publicationPolicy: policy,
    repository,
    controls: { state: () => Promise.resolve(controls) },
    artifacts,
    documents: qualification.documents,
    remote,
    now: () => "2026-09-01T13:00:00.000Z",
    createId: idFactory()
  });
  return { service, policy, repository, remote };
}

class MemoryRepository implements FactoryExternalPullRequestReplacementDraftRepository {
  public snapshot: FactoryExternalPullRequestReplacementDraftJournalSnapshot | null = null;
  #available = true;
  public constructor(
    private readonly candidate: FactoryExternalPullRequestReplacementDraftCandidate,
    private readonly documents: ReturnType<
      typeof testExternalPullRequestRepairQualificationFixture
    >["documents"]
  ) {}
  public listQualified() {
    if (!this.#available) return Promise.resolve([]);
    return Promise.resolve([this.candidate]);
  }
  public listActive() {
    return Promise.resolve(
      this.snapshot === null || ["completed", "stale", "quarantined"].includes(this.snapshot.state)
        ? []
        : [this.snapshot]
    );
  }
  public findCandidate() {
    return Promise.resolve(this.candidate);
  }
  public register(
    _policy: CanonicalFactoryDocument<FactoryExternalPullRequestReplacementDraftPolicy>,
    run: CanonicalFactoryDocument<FactoryExternalPullRequestReplacementDraftRun>,
    event: CanonicalFactoryDocument<FactoryExternalPullRequestReplacementDraftEvent>
  ) {
    this.#available = false;
    this.snapshot = snapshot(run, [event], null);
    return Promise.resolve(this.snapshot);
  }
  public append(event: CanonicalFactoryDocument<FactoryExternalPullRequestReplacementDraftEvent>) {
    if (this.snapshot === null) return Promise.resolve(null);
    const run = this.documents.externalPullRequestReplacementDraftRun(this.snapshot.run);
    const history = this.snapshot.history.map((value) =>
      this.documents.externalPullRequestReplacementDraftEvent(value)
    );
    this.snapshot = snapshot(run, [...history, event], this.snapshot.record);
    return Promise.resolve(this.snapshot);
  }
  public record(
    event: CanonicalFactoryDocument<FactoryExternalPullRequestReplacementDraftEvent>,
    record: CanonicalFactoryDocument<FactoryExternalPullRequestReplacementDraftRecord>
  ) {
    if (this.snapshot === null) return Promise.resolve(null);
    const run = this.documents.externalPullRequestReplacementDraftRun(this.snapshot.run);
    const history = this.snapshot.history.map((value) =>
      this.documents.externalPullRequestReplacementDraftEvent(value)
    );
    this.snapshot = snapshot(run, [...history, event], record.value);
    return Promise.resolve(this.snapshot);
  }
  public close() {
    return undefined;
  }
}

class FakeBroker implements FactoryExternalPullRequestReplacementDraftBroker {
  public originalHead: string;
  public branchWrites = 0;
  public failVerification = false;
  public stateAtBranchWrite: string | null = null;
  public stateAtDraftWrite: string | null = null;
  public proposal:
    | Parameters<FactoryExternalPullRequestReplacementDraftBroker["publishBranch"]>[0]["proposal"]
    | null = null;
  public constructor(
    private readonly repository: MemoryRepository,
    private readonly repositoryId: string,
    private readonly base: string,
    head: string,
    private readonly documents: ReturnType<
      typeof testExternalPullRequestRepairQualificationFixture
    >["documents"]
  ) {
    this.originalHead = head;
  }
  public identity() {
    return { repositoryId: this.repositoryId, brokerId: "github-app/external-repair" };
  }
  public inspectOriginal() {
    return Promise.resolve({
      repositoryId: this.repositoryId,
      number: 42,
      url: `https://github.com/${this.repositoryId}/pull/42`,
      state: "open" as const,
      baseBranch: "main",
      baseRevision: this.base,
      headRevision: this.originalHead,
      governance: governance()
    });
  }
  public publishBranch(
    input: Parameters<FactoryExternalPullRequestReplacementDraftBroker["publishBranch"]>[0]
  ) {
    this.branchWrites += 1;
    this.stateAtBranchWrite = this.repository.snapshot?.state ?? null;
    this.proposal = input.proposal;
    return Promise.resolve({ headRevision: "e".repeat(40), created: true });
  }
  public openDraft(
    input: Parameters<FactoryExternalPullRequestReplacementDraftBroker["openDraft"]>[0]
  ) {
    this.stateAtDraftWrite = this.repository.snapshot?.state ?? null;
    return Promise.resolve({
      created: true,
      record: this.documents.externalPullRequestReplacementDraftRecord({
        schemaVersion: "agentlab.external-pull-request-replacement-draft-record.v1",
        publicationRunId: input.proposal.publicationRunId,
        runDigest: input.proposal.runDigest,
        proposalDigest: this.documents.externalPullRequestReplacementDraftProposal(input.proposal)
          .digest,
        qualificationBundleDigest: input.proposal.qualificationBundleDigest,
        repositoryId: input.proposal.repositoryId,
        originalPullRequestNumber: 42,
        originalPullRequestUrl: input.proposal.originalPullRequestUrl,
        replacementPullRequestNumber: 99,
        replacementPullRequestUrl: `https://github.com/${this.repositoryId}/pull/99`,
        baseBranch: "main",
        baseRevision: this.base,
        branchName: input.proposal.branchName,
        headRevision: input.headRevision,
        brokerId: "github-app/external-repair",
        publisherId: "github-user/77",
        draft: true,
        createdAt: "2026-09-01T13:00:01.000Z"
      }).value
    });
  }
  public verifyDraft() {
    return this.failVerification
      ? Promise.reject(new Error("remote draft drifted"))
      : Promise.resolve();
  }
}

function snapshot(
  run: CanonicalFactoryDocument<FactoryExternalPullRequestReplacementDraftRun>,
  history: readonly CanonicalFactoryDocument<FactoryExternalPullRequestReplacementDraftEvent>[],
  record: FactoryExternalPullRequestReplacementDraftRecord | null
): FactoryExternalPullRequestReplacementDraftJournalSnapshot {
  const last = history.at(-1);
  if (last === undefined) throw new Error("empty test journal");
  return {
    run: run.value,
    runDigest: run.digest,
    state: last.value.to,
    sequence: last.value.sequence,
    lastEvent: last.value,
    lastEventDigest: last.digest,
    history: history.map(({ value }) => value),
    record
  };
}
function governance() {
  return {
    requiresPullRequest: true,
    requiredApprovals: 1,
    dismissesStaleReviews: true,
    requiresCodeOwnerReviews: true,
    requiresLastPushApproval: true,
    enforcesAdmins: true,
    allowsForcePushes: false,
    allowsDeletions: false,
    requiredStatusChecks: ["verify", "factory-sandbox"]
  };
}
function pins(fixture: Awaited<ReturnType<typeof serviceFixture>>) {
  return {
    expectedPublicationPolicyDigest: fixture.policy.digest,
    expectedQualificationPolicyDigest: fixture.policy.value.qualificationPolicyDigest,
    expectedRoleIdentityPolicyDigest: fixture.policy.value.roleIdentityPolicyDigest
  };
}
function idFactory() {
  let id = 1;
  return () => `97000000-0000-4000-8000-${String(id++).padStart(12, "0")}`;
}
