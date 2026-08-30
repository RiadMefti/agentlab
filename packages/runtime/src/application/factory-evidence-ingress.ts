import {
  evidenceBundleSchema,
  evidenceItemSchema,
  factoryTimestampSchema,
  sha256DigestSchema,
  type EvidenceItem,
  type Sha256Digest
} from "@agentlab/contracts";
import { z } from "zod";

import { ConflictError, NotFoundError } from "../domain/errors.js";
import type { FactoryArtifactStore } from "../domain/factory-artifact-store.js";
import type { FactoryDocumentCodec } from "../domain/factory-documents.js";
import type {
  FactoryEvidenceRepository,
  FactoryTaskRepository,
  StoredEvidenceBundle
} from "../domain/factory-task-repository.js";

const appendInputSchema = z
  .object({
    taskId: z.uuid(),
    contractDigest: sha256DigestSchema,
    items: z.array(evidenceItemSchema).min(1).max(1_000)
  })
  .strict();

export type FactoryEvidenceChannel =
  "control-plane" | "execution-observer" | "gate-observer" | "pr-broker";

const factoryEvidenceCredentialBrand: unique symbol = Symbol("factory-evidence-credential");

/** An object-capability. Only the exact registered object identity is accepted. */
export interface FactoryEvidenceCredential {
  readonly [factoryEvidenceCredentialBrand]: true;
}

export interface FactoryEvidenceBinding {
  readonly credential: FactoryEvidenceCredential;
  readonly channel: FactoryEvidenceChannel;
  /** Required for a broker channel so one credential cannot impersonate another broker. */
  readonly producerId?: string;
}

export interface FactoryEvidenceIngressDependencies {
  readonly tasks: Pick<FactoryTaskRepository, "findById">;
  readonly evidence: FactoryEvidenceRepository;
  readonly artifacts: FactoryArtifactStore;
  readonly documents: FactoryDocumentCodec;
  readonly policyBundleDigest: Sha256Digest;
  readonly bindings: readonly FactoryEvidenceBinding[];
  readonly now: () => string;
  readonly createId: () => string;
}

/** Authenticates internal evidence sources before appending their immutable bundle. */
export class FactoryEvidenceIngress {
  readonly #bindings = new WeakMap<object, FactoryEvidenceBinding>();

  public constructor(private readonly dependencies: FactoryEvidenceIngressDependencies) {
    if (dependencies.bindings.length === 0 || dependencies.bindings.length > 8) {
      throw new Error("Factory evidence ingress requires between one and eight producer bindings.");
    }
    for (const binding of dependencies.bindings) {
      if (this.#bindings.has(binding.credential)) {
        throw new Error("Factory evidence credentials must be unique object capabilities.");
      }
      if (binding.channel === "pr-broker") {
        if (binding.producerId === undefined || !validProducerId(binding.producerId)) {
          throw new Error("A PR-broker evidence binding requires an exact producer ID.");
        }
      } else if (binding.producerId !== undefined) {
        throw new Error("Only a PR-broker evidence binding may declare a producer ID.");
      }
      this.#bindings.set(binding.credential, { ...binding });
    }
  }

  public async append(
    credential: FactoryEvidenceCredential,
    inputValue: unknown
  ): Promise<StoredEvidenceBundle> {
    const binding = this.#bindings.get(credential);
    if (binding === undefined) {
      throw new ConflictError("Factory evidence credential is not registered.");
    }
    const input = appendInputSchema.parse(inputValue);
    for (const item of input.items) assertChannelMayPublish(binding, item);

    const task = await this.dependencies.tasks.findById(input.taskId);
    if (task === null) throw new NotFoundError(`Factory task ${input.taskId} does not exist.`);
    if (
      task.contractDigest !== input.contractDigest ||
      task.contract.gateProfile.policyDigest !== this.dependencies.policyBundleDigest
    ) {
      throw new ConflictError("Evidence items do not match the task contract and policy.");
    }
    for (const item of input.items) {
      const content = await this.dependencies.artifacts.read(
        item.artifact.digest,
        Math.max(1, item.artifact.sizeBytes + 1)
      );
      if (content.byteLength !== item.artifact.sizeBytes) {
        throw new ConflictError(`Evidence artifact ${item.artifact.digest} has the wrong size.`);
      }
      if (item.kind === "provenance" && resourceIsolationActor(item)) {
        const json = await this.dependencies.artifacts.readText(
          item.artifact.digest,
          Math.max(1, item.artifact.sizeBytes + 1)
        );
        this.#assertResourceIsolationRecord(binding, item, json, {
          taskId: task.contract.taskId,
          contractDigest: task.contractDigest,
          policyBundleDigest: task.contract.gateProfile.policyDigest
        });
      } else if (item.kind === "patch" && localGateActor(item)) {
        const json = await this.dependencies.artifacts.readText(
          item.artifact.digest,
          Math.max(1, item.artifact.sizeBytes + 1)
        );
        const patch = this.#assertPatchRecord(item, json, {
          taskId: task.contract.taskId,
          contractDigest: task.contractDigest,
          baseRevision: task.contract.repository.baseRevision
        });
        const patchContent = await this.dependencies.artifacts.read(
          patch.patchArtifact.digest,
          Math.max(1, patch.patchArtifact.sizeBytes + 1)
        );
        if (patchContent.byteLength !== patch.patchArtifact.sizeBytes) {
          throw new ConflictError("Patch artifact has the wrong size.");
        }
      }
    }
    const latest = await this.dependencies.evidence.latestEvidence(input.taskId);
    if (latest === null) throw new ConflictError("Factory task has no evidence chain.");
    const document = this.dependencies.documents.evidenceBundle(
      evidenceBundleSchema.parse({
        schemaVersion: "agentlab.evidence-bundle.v1",
        bundleId: this.dependencies.createId(),
        taskId: input.taskId,
        sequence: latest.bundle.sequence + 1,
        contractDigest: input.contractDigest,
        previousBundleDigest: latest.digest,
        policyBundleDigest: this.dependencies.policyBundleDigest,
        createdAt: factoryTimestampSchema.parse(this.dependencies.now()),
        items: input.items,
        attestations: []
      })
    );
    const stored = await this.dependencies.artifacts.putText(document.json);
    if (stored.digest !== document.digest) {
      throw new Error("Artifact store digest disagrees with canonical evidence JSON.");
    }
    const appended = await this.dependencies.evidence.appendEvidence(document);
    if (appended === null) {
      throw new ConflictError(
        "Evidence chain changed concurrently; rebuild the bundle before retrying."
      );
    }
    return appended;
  }

  #assertResourceIsolationRecord(
    binding: FactoryEvidenceBinding,
    item: EvidenceItem,
    json: string,
    expected: {
      readonly taskId: string;
      readonly contractDigest: Sha256Digest;
      readonly policyBundleDigest: Sha256Digest;
    }
  ): void {
    if (item.artifact.mediaType !== "application/vnd.agentlab.resource-isolation-record.v1+json") {
      throw new ConflictError("Resource-isolation evidence has the wrong media type.");
    }
    const record = this.dependencies.documents.resourceIsolation(parseJson(json));
    const executionClaim =
      record.value.execution.kind === "agent"
        ? claimValue(item, "execution-id") === record.value.execution.executionId &&
          record.value.isolation.isolationId === record.value.execution.executionId
        : claimValue(item, "gate-id") === record.value.execution.gateId;
    if (
      record.digest !== item.artifact.digest ||
      record.value.taskId !== expected.taskId ||
      record.value.contractDigest !== expected.contractDigest ||
      record.value.policyBundleDigest !== expected.policyBundleDigest ||
      record.value.subjectDigest !== item.subjectDigest ||
      item.result !== (record.value.result === "enforced" ? "pass" : "fail") ||
      item.createdAt !== record.value.observedAt ||
      claimValue(item, "policy-bundle-digest") !== expected.policyBundleDigest ||
      claimValue(item, "isolation-id") !== record.value.isolation.isolationId ||
      claimValue(item, "isolation-mechanism") !== record.value.isolation.mechanism.id ||
      claimValue(item, "isolation-version") !== record.value.isolation.mechanism.version ||
      claimValue(item, "scope-name") !== record.value.isolation.scopeName ||
      !executionClaim ||
      (binding.channel === "execution-observer" && record.value.execution.kind !== "agent") ||
      (binding.channel === "gate-observer" && record.value.execution.kind !== "gate")
    ) {
      throw new ConflictError(
        "Resource-isolation evidence does not match its authenticated record."
      );
    }
  }

  #assertPatchRecord(
    item: EvidenceItem,
    json: string,
    expected: {
      readonly taskId: string;
      readonly contractDigest: Sha256Digest;
      readonly baseRevision: string;
    }
  ) {
    if (item.artifact.mediaType !== "application/vnd.agentlab.patch-proposal.v1+json") {
      throw new ConflictError("Patch evidence has the wrong media type.");
    }
    const record = this.dependencies.documents.patchProposal(parseJson(json));
    if (
      record.digest !== item.artifact.digest ||
      record.digest !== item.subjectDigest ||
      record.value.taskId !== expected.taskId ||
      record.value.contractDigest !== expected.contractDigest ||
      record.value.baseRevision !== expected.baseRevision ||
      item.result !== "pass" ||
      item.createdAt !== record.value.createdAt ||
      claimValue(item, "execution-id") !== record.value.executionId ||
      claimValue(item, "base-revision") !== record.value.baseRevision ||
      claimValue(item, "patch-digest") !== record.value.patchArtifact.digest
    ) {
      throw new ConflictError("Patch evidence does not match its authenticated record.");
    }
    return record.value;
  }
}

export function createFactoryEvidenceCredential(): FactoryEvidenceCredential {
  return Object.freeze({ [factoryEvidenceCredentialBrand]: true as const });
}

function assertChannelMayPublish(binding: FactoryEvidenceBinding, item: EvidenceItem): void {
  const allowed =
    binding.channel === "control-plane"
      ? controlPlaneItem(item)
      : binding.channel === "execution-observer"
        ? executionObserverItem(item)
        : binding.channel === "gate-observer"
          ? gateObserverItem(item)
          : brokerItem(item, binding.producerId ?? "");
  if (!allowed) {
    throw new ConflictError(
      `Evidence channel ${binding.channel} cannot assert ${item.kind} as ${item.producer.kind}/${item.producer.role}/${item.producer.id}.`
    );
  }
}

function controlPlaneItem(item: EvidenceItem): boolean {
  if (item.kind === "policy") return policyActor(item);
  return (
    (item.kind === "skill" ||
      item.kind === "patch" ||
      item.kind === "usage" ||
      item.kind === "test") &&
    localGateActor(item)
  );
}

function executionObserverItem(item: EvidenceItem): boolean {
  if (item.kind === "execution") {
    const executionId = claimValue(item, "execution-id");
    return (
      item.producer.kind === "agent" &&
      (item.producer.role === "implementer" ||
        item.producer.role === "repairer" ||
        item.producer.role === "reviewer") &&
      workerExecutionId(item.producer.id) === executionId
    );
  }
  if (item.kind === "review") {
    return item.producer.kind === "agent" && item.producer.role === "reviewer";
  }
  if (item.kind === "test") return localGateActor(item);
  return item.kind === "provenance" && resourceIsolationActor(item);
}

function workerExecutionId(producerId: string): string | null {
  const match =
    /^worker\/([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/u.exec(
      producerId
    );
  return match?.[1] ?? null;
}

function gateObserverItem(item: EvidenceItem): boolean {
  if (item.kind === "provenance" && resourceIsolationActor(item)) return true;
  return (
    (item.kind === "test" ||
      item.kind === "build" ||
      item.kind === "security" ||
      item.kind === "provenance") &&
    item.producer.kind === "ci" &&
    item.producer.role === "gate-runner" &&
    item.producer.id === "agentlab-local-sandbox"
  );
}

function brokerItem(item: EvidenceItem, producerId: string): boolean {
  if (item.kind === "policy") return policyActor(item);
  return (
    item.kind === "pull-request" &&
    item.producer.kind === "broker" &&
    item.producer.role === "pr-broker" &&
    item.producer.id === producerId
  );
}

function policyActor(item: EvidenceItem): boolean {
  return (
    item.producer.kind === "control-plane" &&
    item.producer.role === "policy-engine" &&
    item.producer.id === "agentlab-policy"
  );
}

function localGateActor(item: EvidenceItem): boolean {
  return (
    item.producer.kind === "control-plane" &&
    item.producer.role === "gate-runner" &&
    item.producer.id === "agentlab-local-gates"
  );
}

function resourceIsolationActor(item: EvidenceItem): boolean {
  return (
    item.producer.kind === "ci" &&
    item.producer.role === "gate-runner" &&
    item.producer.id === "agentlab-resource-isolator"
  );
}

function validProducerId(value: string): boolean {
  return value.length > 0 && value.length <= 128 && /^[a-z0-9][a-z0-9._/-]*$/u.test(value);
}

function claimValue(item: EvidenceItem, name: string): string | null {
  return item.claims.find((claim) => claim.name === name)?.value ?? null;
}

function parseJson(json: string): unknown {
  try {
    return JSON.parse(json) as unknown;
  } catch {
    throw new ConflictError("Evidence artifact is not valid JSON.");
  }
}
