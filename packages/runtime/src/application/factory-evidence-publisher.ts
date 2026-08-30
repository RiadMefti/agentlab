import {
  evidenceItemSchema,
  factoryAgentRunRecordSchema,
  factoryGateObservationSchema,
  factoryPatchProposalSchema,
  factoryReviewDecisionSchema,
  factoryReviewResultSchema,
  type FactoryAgentRunRequest,
  type FactoryPatchProposal,
  type FactoryProcessIsolation,
  type FactoryPullRequestProposal,
  type FactoryPullRequestRecord,
  type FactoryReviewResult,
  type FactoryBudgetUsage,
  type EvidenceItem,
  type Sha256Digest
} from "@agentlab/contracts";

import type { FactoryAgentExecutionOutput } from "../domain/factory-agent-executor.js";
import type { FactoryArtifactStore } from "../domain/factory-artifact-store.js";
import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../domain/factory-documents.js";
import type { FactoryGateExecutionOutput } from "../domain/factory-gate.js";
import type { ResolvedFactorySkill } from "../domain/factory-skill.js";
import type { FactoryTaskSnapshot } from "../domain/factory-task-repository.js";
import type { FactoryWorkspacePatch } from "../domain/factory-workspace.js";
import type {
  FactoryEvidenceCredential,
  FactoryEvidenceIngress
} from "./factory-evidence-ingress.js";

export interface PublishedFactoryAgentRun {
  readonly document: ReturnType<FactoryDocumentCodec["agentRun"]>;
  readonly actor: {
    readonly kind: "agent";
    readonly role: "implementer" | "repairer" | "reviewer";
    readonly id: string;
    readonly sessionId: string | null;
  };
}

export interface FactoryEvidencePublisherCredentials {
  readonly controlPlane: FactoryEvidenceCredential;
  readonly executionObserver: FactoryEvidenceCredential;
  readonly gateObserver: FactoryEvidenceCredential;
  readonly prBroker: FactoryEvidenceCredential;
}

export interface FactoryEvidencePublisherDependencies {
  readonly evidenceIngress: FactoryEvidenceIngress;
  readonly credentials: Partial<FactoryEvidencePublisherCredentials>;
  readonly artifacts: FactoryArtifactStore;
  readonly documents: FactoryDocumentCodec;
  readonly now: () => string;
  readonly createId: () => string;
}

/** Converts directly observed execution facts into immutable artifacts and append-only evidence. */
export class FactoryEvidencePublisher {
  public constructor(private readonly dependencies: FactoryEvidencePublisherDependencies) {}

  public async agentRun(
    task: FactoryTaskSnapshot,
    request: FactoryAgentRunRequest,
    output: FactoryAgentExecutionOutput
  ): Promise<PublishedFactoryAgentRun> {
    const stdoutArtifact = await this.#textArtifact(output.stdout, "text/plain");
    const stderrArtifact = await this.#textArtifact(output.stderr, "text/plain");
    const finalOutputArtifact =
      output.finalOutput === null
        ? null
        : await this.#textArtifact(output.finalOutput, "text/plain");
    const record = this.dependencies.documents.agentRun(
      factoryAgentRunRecordSchema.parse({
        schemaVersion: "agentlab.agent-run-record.v1",
        executionId: request.executionId,
        taskId: request.taskId,
        contractDigest: request.contractDigest,
        role: request.role,
        attempt: request.attempt,
        provider: request.provider,
        providerVersion: output.providerVersion,
        harnessVersion: output.harnessVersion,
        model: request.model,
        reasoning: request.reasoning,
        providerSessionId: output.providerSessionId,
        status: output.status,
        startedAt: output.startedAt,
        finishedAt: output.finishedAt,
        exitCode: output.exitCode,
        stdoutArtifact,
        stderrArtifact,
        finalOutputArtifact,
        usage: output.usage,
        usageComplete: output.usageComplete,
        errorCode: output.errorCode
      })
    );
    const artifact = await this.#documentArtifact(
      record,
      "application/vnd.agentlab.agent-run-record.v1+json"
    );
    const isolationRecord = this.dependencies.documents.resourceIsolation({
      schemaVersion: "agentlab.resource-isolation-record.v1",
      taskId: task.contract.taskId,
      contractDigest: task.contractDigest,
      policyBundleDigest: task.contract.gateProfile.policyDigest,
      subjectDigest: task.contractDigest,
      attempt: request.attempt,
      execution: { kind: "agent", executionId: request.executionId },
      isolation: output.isolation,
      result: output.status === "succeeded" ? "enforced" : "failed",
      observedAt: output.finishedAt
    });
    const isolationArtifact = await this.#documentArtifact(
      isolationRecord,
      "application/vnd.agentlab.resource-isolation-record.v1+json"
    );
    const actor = {
      kind: "agent",
      role: request.role,
      id: `worker/${request.executionId}`,
      sessionId: output.providerSessionId
    } as const;
    await this.#append(this.#credential("executionObserver"), task, [
      evidenceItemSchema.parse({
        id: this.dependencies.createId(),
        kind: "execution",
        result: output.status === "succeeded" ? "pass" : "fail",
        subjectDigest: task.contractDigest,
        artifact,
        producer: actor,
        createdAt: output.finishedAt,
        claims: [
          { name: "execution-id", value: request.executionId },
          { name: "isolation-id", value: output.isolation.isolationId },
          { name: "provider", value: request.provider },
          { name: "status", value: output.status }
        ]
      }),
      evidenceItemSchema.parse({
        id: this.dependencies.createId(),
        kind: "provenance",
        result: isolationRecord.value.result === "enforced" ? "pass" : "fail",
        subjectDigest: task.contractDigest,
        artifact: isolationArtifact,
        producer: resourceIsolationActor,
        createdAt: output.finishedAt,
        claims: resourceIsolationClaims(isolationRecord.value.isolation, [
          { name: "execution-id", value: request.executionId },
          { name: "policy-bundle-digest", value: task.contract.gateProfile.policyDigest }
        ])
      })
    ]);
    return { document: record, actor };
  }

  public async skillPlan(
    task: FactoryTaskSnapshot,
    skills: readonly ResolvedFactorySkill[]
  ): Promise<void> {
    const items = await Promise.all(
      skills.map(async (skill) => {
        const document = this.dependencies.documents.skillPackage(skill.package);
        if (document.digest !== skill.packageDigest) {
          throw new Error(`Resolved skill ${skill.manifest.id} changed after resolution.`);
        }
        const artifact = await this.#documentArtifact(
          document,
          "application/vnd.agentlab.skill-package.v1+json"
        );
        return evidenceItemSchema.parse({
          id: this.dependencies.createId(),
          kind: "skill",
          result: "pass",
          subjectDigest: task.contractDigest,
          artifact,
          producer: controlPlaneGateActor,
          createdAt: this.dependencies.now(),
          claims: [
            { name: "skill-id", value: skill.manifest.id },
            { name: "skill-version", value: skill.manifest.version },
            { name: "package-digest", value: skill.packageDigest }
          ]
        });
      })
    );
    await this.#append(this.#credential("controlPlane"), task, items);
  }

  public async patch(
    task: FactoryTaskSnapshot,
    executionId: string,
    workspacePatch: FactoryWorkspacePatch
  ): Promise<CanonicalFactoryDocument<FactoryPatchProposal>> {
    if (workspacePatch.changeSet.changedFiles === 0 || workspacePatch.patch.length === 0) {
      throw new Error("A factory implementation must produce a non-empty patch.");
    }
    const patchArtifact = await this.#textArtifact(
      workspacePatch.patch,
      "text/x-diff; charset=utf-8"
    );
    const proposal = this.dependencies.documents.patchProposal(
      factoryPatchProposalSchema.parse({
        schemaVersion: "agentlab.patch-proposal.v1",
        taskId: task.contract.taskId,
        contractDigest: task.contractDigest,
        executionId,
        baseRevision: task.contract.repository.baseRevision,
        changeSet: workspacePatch.changeSet,
        patchArtifact,
        createdAt: this.dependencies.now()
      })
    );
    const proposalArtifact = await this.#documentArtifact(
      proposal,
      "application/vnd.agentlab.patch-proposal.v1+json"
    );
    await this.#append(this.#credential("controlPlane"), task, [
      evidenceItemSchema.parse({
        id: this.dependencies.createId(),
        kind: "patch",
        result: "pass",
        subjectDigest: proposal.digest,
        artifact: proposalArtifact,
        producer: controlPlaneGateActor,
        createdAt: proposal.value.createdAt,
        claims: [
          { name: "patch-digest", value: patchArtifact.digest },
          { name: "base-revision", value: proposal.value.baseRevision },
          { name: "execution-id", value: executionId }
        ]
      })
    ]);
    return proposal;
  }

  public async gate(
    task: FactoryTaskSnapshot,
    subjectDigest: Sha256Digest,
    output: FactoryGateExecutionOutput,
    attempt: number
  ): Promise<void> {
    const stdoutArtifact = await this.#textArtifact(output.stdout, "text/plain");
    const stderrArtifact = await this.#textArtifact(output.stderr, "text/plain");
    const observation = this.dependencies.documents.gateObservation(
      factoryGateObservationSchema.parse({
        schemaVersion: "agentlab.gate-observation.v1",
        gateId: output.gateId,
        taskId: task.contract.taskId,
        contractDigest: task.contractDigest,
        baseRevision: task.contract.repository.baseRevision,
        result: output.result,
        command: output.command,
        startedAt: output.startedAt,
        finishedAt: output.finishedAt,
        exitCode: output.exitCode,
        stdoutArtifact,
        stderrArtifact
      })
    );
    const artifact = await this.#documentArtifact(
      observation,
      "application/vnd.agentlab.gate-observation.v1+json"
    );
    const isolationRecord = this.dependencies.documents.resourceIsolation({
      schemaVersion: "agentlab.resource-isolation-record.v1",
      taskId: task.contract.taskId,
      contractDigest: task.contractDigest,
      policyBundleDigest: task.contract.gateProfile.policyDigest,
      subjectDigest,
      attempt,
      execution: { kind: "gate", gateId: output.gateId },
      isolation: output.isolation,
      result: output.result === "pass" ? "enforced" : "failed",
      observedAt: output.finishedAt
    });
    const isolationArtifact = await this.#documentArtifact(
      isolationRecord,
      "application/vnd.agentlab.resource-isolation-record.v1+json"
    );
    await this.#append(this.#credential("gateObserver"), task, [
      evidenceItemSchema.parse({
        id: this.dependencies.createId(),
        kind: output.evidenceKind,
        result: output.result === "pass" ? "pass" : "fail",
        subjectDigest,
        artifact,
        producer: ciGateActor,
        createdAt: output.finishedAt,
        claims: [
          { name: "gate-id", value: output.gateId },
          { name: "gate-result", value: output.result },
          { name: "isolation-id", value: output.isolation.isolationId }
        ]
      }),
      evidenceItemSchema.parse({
        id: this.dependencies.createId(),
        kind: "provenance",
        result: isolationRecord.value.result === "enforced" ? "pass" : "fail",
        subjectDigest,
        artifact: isolationArtifact,
        producer: resourceIsolationActor,
        createdAt: output.finishedAt,
        claims: resourceIsolationClaims(isolationRecord.value.isolation, [
          { name: "gate-id", value: output.gateId },
          { name: "policy-bundle-digest", value: task.contract.gateProfile.policyDigest }
        ])
      })
    ]);
  }

  public async internalGate(
    task: FactoryTaskSnapshot,
    subjectDigest: Sha256Digest,
    gateId: string,
    result: "pass" | "fail",
    summary: string
  ): Promise<void> {
    const artifact = await this.#textArtifact(summary, "text/plain");
    await this.#append(this.#credential("controlPlane"), task, [
      evidenceItemSchema.parse({
        id: this.dependencies.createId(),
        kind: "test",
        result,
        subjectDigest,
        artifact,
        producer: controlPlaneGateActor,
        createdAt: this.dependencies.now(),
        claims: [
          { name: "gate-id", value: gateId },
          { name: "gate-result", value: result }
        ]
      })
    ]);
  }

  public parseReviewDecision(output: string | null) {
    if (output === null) throw new Error("Independent reviewer returned no final output.");
    try {
      return factoryReviewDecisionSchema.parse(JSON.parse(output) as unknown);
    } catch (error: unknown) {
      throw new Error("Independent reviewer output does not match the required JSON schema.", {
        cause: error
      });
    }
  }

  public async review(input: {
    readonly task: FactoryTaskSnapshot;
    readonly patch: CanonicalFactoryDocument<FactoryPatchProposal>;
    readonly reviewerRun: PublishedFactoryAgentRun;
    readonly decision: ReturnType<FactoryEvidencePublisher["parseReviewDecision"]>;
    readonly implementer: PublishedFactoryAgentRun["actor"];
  }): Promise<CanonicalFactoryDocument<FactoryReviewResult>> {
    const reviewer = input.reviewerRun.actor;
    if (
      reviewer.role !== "reviewer" ||
      reviewer.sessionId === null ||
      input.implementer.sessionId === null ||
      reviewer.id === input.implementer.id ||
      reviewer.sessionId === input.implementer.sessionId
    ) {
      throw new Error("Independent review requires a distinct identified worker session.");
    }
    const review = this.dependencies.documents.reviewResult(
      factoryReviewResultSchema.parse({
        ...input.decision,
        schemaVersion: "agentlab.review-result.v1",
        taskId: input.task.contract.taskId,
        contractDigest: input.task.contractDigest,
        patchProposalDigest: input.patch.digest,
        executionId: input.patch.value.executionId,
        reviewerRunId: input.reviewerRun.document.value.executionId,
        createdAt: this.dependencies.now()
      })
    );
    const artifact = await this.#documentArtifact(
      review,
      "application/vnd.agentlab.review-result.v1+json"
    );
    const passed = review.value.verdict === "approved";
    const items = [
      evidenceItemSchema.parse({
        id: this.dependencies.createId(),
        kind: "review",
        result: passed ? "pass" : "fail",
        subjectDigest: input.patch.digest,
        artifact,
        producer: reviewer,
        createdAt: review.value.createdAt,
        claims: [
          { name: "verdict", value: review.value.verdict },
          { name: "reviewer-run-id", value: review.value.reviewerRunId }
        ]
      }),
      evidenceItemSchema.parse({
        id: this.dependencies.createId(),
        kind: "test",
        result: passed ? "pass" : "fail",
        subjectDigest: input.patch.digest,
        artifact,
        producer: controlPlaneGateActor,
        createdAt: review.value.createdAt,
        claims: [
          { name: "gate-id", value: "independent-review" },
          { name: "gate-result", value: passed ? "pass" : "fail" }
        ]
      })
    ];
    await this.#append(this.#credential("executionObserver"), input.task, items);
    return review;
  }

  public async taskUsage(
    task: FactoryTaskSnapshot,
    patchProposalDigest: Sha256Digest,
    usage: FactoryBudgetUsage,
    complete: boolean
  ): Promise<ReturnType<FactoryDocumentCodec["taskUsage"]>> {
    const record = this.dependencies.documents.taskUsage({
      schemaVersion: "agentlab.task-usage-record.v1",
      taskId: task.contract.taskId,
      contractDigest: task.contractDigest,
      patchProposalDigest,
      usage,
      complete,
      calculatedAt: this.dependencies.now()
    });
    const artifact = await this.#documentArtifact(
      record,
      "application/vnd.agentlab.task-usage-record.v1+json"
    );
    await this.#append(this.#credential("controlPlane"), task, [
      evidenceItemSchema.parse({
        id: this.dependencies.createId(),
        kind: "usage",
        result: complete ? "pass" : "informational",
        subjectDigest: patchProposalDigest,
        artifact,
        producer: controlPlaneGateActor,
        createdAt: record.value.calculatedAt,
        claims: [
          { name: "usage-complete", value: String(complete) },
          { name: "patch-proposal-digest", value: patchProposalDigest }
        ]
      })
    ]);
    return record;
  }

  public async pullRequest(input: {
    readonly task: FactoryTaskSnapshot;
    readonly proposal: CanonicalFactoryDocument<FactoryPullRequestProposal>;
    readonly record: FactoryPullRequestRecord;
    readonly authorizingPolicyItem: EvidenceItem;
  }): Promise<void> {
    if (
      input.authorizingPolicyItem.kind !== "policy" ||
      input.authorizingPolicyItem.result !== "pass" ||
      input.authorizingPolicyItem.subjectDigest !== input.proposal.value.patchProposalDigest
    ) {
      throw new Error("Pull-request evidence requires the exact passing policy item.");
    }
    const proposalArtifact = await this.#documentArtifact(
      input.proposal,
      "application/vnd.agentlab.pull-request-proposal.v1+json"
    );
    const recordDocument = this.dependencies.documents.pullRequestRecord(input.record);
    const recordArtifact = await this.#documentArtifact(
      recordDocument,
      "application/vnd.agentlab.pull-request-record.v1+json"
    );
    await this.#append(this.#credential("prBroker"), input.task, [
      evidenceItemSchema.parse({
        ...input.authorizingPolicyItem,
        id: this.dependencies.createId()
      }),
      evidenceItemSchema.parse({
        id: this.dependencies.createId(),
        kind: "pull-request",
        result: "pass",
        subjectDigest: input.proposal.value.patchProposalDigest,
        artifact: recordArtifact,
        producer: {
          kind: "broker",
          role: "pr-broker",
          id: input.record.brokerId,
          sessionId: null
        },
        createdAt: input.record.createdAt,
        claims: [
          { name: "pull-request-number", value: String(input.record.number) },
          { name: "head-revision", value: input.record.headRevision },
          { name: "proposal-digest", value: input.proposal.digest },
          { name: "proposal-artifact", value: proposalArtifact.digest }
        ]
      })
    ]);
  }

  async #textArtifact(content: string, mediaType: string) {
    const stored = await this.dependencies.artifacts.putText(content);
    return { digest: stored.digest, mediaType, sizeBytes: stored.sizeBytes };
  }

  async #documentArtifact<Value>(document: CanonicalFactoryDocument<Value>, mediaType: string) {
    const artifact = await this.#textArtifact(document.json, mediaType);
    if (artifact.digest !== document.digest) {
      throw new Error("Published factory document digest changed in artifact storage.");
    }
    return artifact;
  }

  #credential(name: keyof FactoryEvidencePublisherCredentials): FactoryEvidenceCredential {
    const credential = this.dependencies.credentials[name];
    if (credential === undefined) {
      throw new Error(`Factory evidence publisher has no ${name} capability.`);
    }
    return credential;
  }

  async #append(
    credential: FactoryEvidenceCredential,
    task: FactoryTaskSnapshot,
    items: readonly EvidenceItem[]
  ): Promise<void> {
    await this.dependencies.evidenceIngress.append(credential, {
      taskId: task.contract.taskId,
      contractDigest: task.contractDigest,
      items
    });
  }
}

const controlPlaneGateActor = {
  kind: "control-plane",
  role: "gate-runner",
  id: "agentlab-local-gates",
  sessionId: null
} as const;

const ciGateActor = {
  kind: "ci",
  role: "gate-runner",
  id: "agentlab-local-sandbox",
  sessionId: null
} as const;

const resourceIsolationActor = {
  kind: "ci",
  role: "gate-runner",
  id: "agentlab-resource-isolator",
  sessionId: null
} as const;

function resourceIsolationClaims(
  isolation: FactoryProcessIsolation,
  additional: readonly { readonly name: string; readonly value: string }[]
) {
  return [
    ...additional,
    { name: "isolation-id", value: isolation.isolationId },
    { name: "isolation-mechanism", value: isolation.mechanism.id },
    { name: "isolation-version", value: isolation.mechanism.version },
    { name: "scope-name", value: isolation.scopeName }
  ];
}
