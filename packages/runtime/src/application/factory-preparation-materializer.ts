import {
  evidenceBundleSchema,
  evidenceItemSchema,
  factoryIdentifierSchema,
  factoryTimestampSchema,
  type EvidenceItem,
  type FactoryActor,
  type FactoryArtifactReference,
  type Sha256Digest,
  type TaskEvent
} from "@agentlab/contracts";
import { z } from "zod";

import type { ConversationRepository } from "../domain/conversation-repository.js";
import type { FactoryArtifactStore } from "../domain/factory-artifact-store.js";
import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../domain/factory-documents.js";
import {
  factoryPolicyBundleMediaType,
  type FactoryPolicyBundle,
  type FactoryPolicyEngine
} from "../domain/factory-policy.js";
import {
  FactoryPreparationCompiler,
  type FactoryPreparationCompilation
} from "../domain/factory-preparation.js";
import type {
  FactoryPreparationRepository,
  FactoryPreparationSnapshot
} from "../domain/factory-preparation-repository.js";
import type {
  FactoryTaskRepository,
  FactoryTaskSnapshot
} from "../domain/factory-task-repository.js";
import type { FactoryTaskMaterializationRepository } from "../domain/factory-task-materialization.js";
import { factoryTimestampAddSeconds } from "../domain/factory-timestamp.js";
import {
  factoryPreparationPhases,
  FactoryPreparationSourceLoader,
  type FactoryPreparationSource,
  type LoadedPreparationPhase
} from "./factory-preparation-source-loader.js";

const materializationCommandSchema = z
  .object({
    taskId: z.uuid(),
    correlationId: z.uuid()
  })
  .strict();

const utf8Encoder = new TextEncoder();

export interface FactoryPreparationMaterializerDependencies {
  readonly preparations: Pick<FactoryPreparationRepository, "findById" | "listEvents">;
  readonly tasks: Pick<FactoryTaskRepository, "findById">;
  readonly conversations: Pick<ConversationRepository, "findById">;
  readonly materializations: FactoryTaskMaterializationRepository;
  readonly artifacts: FactoryArtifactStore;
  readonly documents: FactoryDocumentCodec;
  readonly policy: FactoryPolicyEngine;
  readonly policyBundle: CanonicalFactoryDocument<FactoryPolicyBundle>;
  readonly now: () => string;
  readonly createId: () => string;
  readonly controlPlaneActorId: string;
}

export interface FactoryPreparationMaterializationResult {
  readonly preparation: FactoryPreparationSnapshot;
  readonly task: FactoryTaskSnapshot;
  readonly preparationBundleDigest: Sha256Digest;
  readonly evidenceBundleDigest: Sha256Digest;
}

/** Compiles a planned journal and commits its immutable task ledger as one atomic unit. */
export class FactoryPreparationMaterializer {
  readonly #actor: FactoryActor;
  readonly #sourceLoader: FactoryPreparationSourceLoader;

  public constructor(private readonly dependencies: FactoryPreparationMaterializerDependencies) {
    if (dependencies.policy.bundleDigest !== dependencies.policyBundle.digest) {
      throw new Error("Preparation materializer policy documents disagree.");
    }
    this.#actor = {
      kind: "control-plane",
      role: "policy-engine",
      id: factoryIdentifierSchema.parse(dependencies.controlPlaneActorId),
      sessionId: null
    };
    this.#sourceLoader = new FactoryPreparationSourceLoader({
      artifacts: dependencies.artifacts,
      documents: dependencies.documents,
      policy: dependencies.policy
    });
  }

  public async materialize(input: unknown): Promise<FactoryPreparationMaterializationResult> {
    const command = materializationCommandSchema.parse(input);
    const snapshot = await this.#requirePreparation(command.taskId);
    if (snapshot.state === "prepared") return this.#existing(snapshot);
    if (snapshot.state !== "planned" || snapshot.lastEvent.kind !== "phase-succeeded") {
      throw new Error(`Factory preparation ${command.taskId} is not planned for materialization.`);
    }
    const conversation = await this.dependencies.conversations.findById(
      snapshot.request.conversationId
    );
    if (conversation?.lifecycleState !== "active") {
      throw new Error("Factory materialization requires its active owning conversation.");
    }
    const createdAt = factoryTimestampSchema.parse(this.dependencies.now());
    if (createdAt >= snapshot.authority.expiresAt) {
      throw new Error("Preparation authority expired before task materialization.");
    }
    const history = await this.dependencies.preparations.listEvents(command.taskId);
    const source = await this.#sourceLoader.load(snapshot, history);
    const preparationBundle = this.dependencies.documents.preparationBundle({
      schemaVersion: "agentlab.preparation-bundle.v2",
      taskId: snapshot.request.taskId,
      requestDigest: snapshot.requestDigest,
      authorityDigest: snapshot.authorityDigest,
      qualificationDigest: source.qualify.output.digest,
      specificationDigest: source.specify.output.digest,
      planDigest: source.plan.output.digest,
      runs: factoryPreparationPhases.map((phase) => preparationRun(source[phase])),
      createdAt
    });
    const contractExpiresAt = minimumTimestamp(
      snapshot.authority.expiresAt,
      factoryTimestampAddSeconds(createdAt, snapshot.authority.maximumContractLifetimeSeconds)
    );
    const compilation = new FactoryPreparationCompiler(
      this.dependencies.documents,
      this.dependencies.policy,
      snapshot.authority
    ).compile({
      request: snapshot.request,
      qualification: source.qualify.output.value,
      specification: source.specify.output.value,
      plan: source.plan.output.value,
      bundle: preparationBundle.value,
      contractCreatedAt: createdAt,
      contractExpiresAt
    });
    const published = await this.#publishMaterializationArtifacts(
      snapshot,
      source,
      compilation,
      preparationBundle,
      createdAt
    );
    const evidence = this.#initialEvidence(
      snapshot,
      source,
      compilation,
      preparationBundle,
      published,
      createdAt
    );
    await this.#publishCanonical(evidence, "application/vnd.agentlab.evidence-bundle.v1+json");
    const taskEvents = this.#taskEvents(
      compilation,
      evidence.digest,
      createdAt,
      command.correlationId
    );
    const preparedEvent = this.dependencies.documents.preparationEvent({
      schemaVersion: "agentlab.preparation-event.v1",
      eventId: this.#id(),
      taskId: snapshot.request.taskId,
      sequence: snapshot.sequence + 1,
      requestDigest: snapshot.requestDigest,
      authorityDigest: snapshot.authorityDigest,
      previousEventDigest: snapshot.lastEventDigest,
      kind: "prepared",
      from: "planned",
      to: "prepared",
      preparationBundleDigest: preparationBundle.digest,
      contractDigest: compilation.contract.digest,
      evidenceBundleDigest: evidence.digest,
      actor: this.#actor,
      occurredAt: createdAt,
      reasonCode: "task-contract-materialized",
      summary: null,
      correlationId: command.correlationId
    });
    const task = await this.dependencies.materializations.materialize({
      preparationBundle,
      contract: compilation.contract,
      taskEvents,
      initialEvidence: evidence,
      preparedEvent
    });
    if (task === null) {
      const raced = await this.#requirePreparation(command.taskId);
      if (raced.state !== "prepared") {
        throw new Error("Preparation materialization lost its atomic append race.");
      }
      return this.#existing(raced);
    }
    const preparation = await this.#requirePreparation(command.taskId);
    if (
      preparation.state !== "prepared" ||
      preparation.lastEvent.kind !== "prepared" ||
      preparation.lastEvent.contractDigest !== task.contractDigest
    ) {
      throw new Error("Materialized task and preparation journal disagree after commit.");
    }
    return {
      preparation,
      task,
      preparationBundleDigest: preparationBundle.digest,
      evidenceBundleDigest: evidence.digest
    };
  }

  async #publishMaterializationArtifacts(
    snapshot: FactoryPreparationSnapshot,
    source: FactoryPreparationSource,
    compilation: FactoryPreparationCompilation,
    bundle: ReturnType<FactoryDocumentCodec["preparationBundle"]>,
    createdAt: string
  ): Promise<PublishedMaterializationArtifacts> {
    const [bundleArtifact, contractArtifact, policyArtifact] = await Promise.all([
      this.#publishCanonical(bundle, "application/vnd.agentlab.preparation-bundle.v2+json"),
      this.#publishCanonical(
        compilation.contract,
        "application/vnd.agentlab.task-contract.v1+json"
      ),
      this.#publishCanonical(
        this.dependencies.policyBundle,
        factoryPolicyBundleMediaType(this.dependencies.policyBundle.value)
      )
    ]);
    if (
      compilation.request.digest !== snapshot.requestDigest ||
      compilation.authority.digest !== snapshot.authorityDigest ||
      compilation.bundle.digest !== bundle.digest ||
      compilation.bundle.value.createdAt !== createdAt
    ) {
      throw new Error("Compiled materialization changed its journal-bound source artifacts.");
    }
    return { bundleArtifact, contractArtifact, policyArtifact };
  }

  #initialEvidence(
    snapshot: FactoryPreparationSnapshot,
    source: FactoryPreparationSource,
    compilation: FactoryPreparationCompilation,
    bundle: ReturnType<FactoryDocumentCodec["preparationBundle"]>,
    published: PublishedMaterializationArtifacts,
    createdAt: string
  ) {
    const subject = compilation.contract.digest;
    const items: EvidenceItem[] = [
      this.#evidence("request", source.request, subject, createdAt, [
        { name: "request-digest", value: snapshot.requestDigest }
      ]),
      this.#evidence("qualification", source.qualify.outputArtifact, subject, createdAt, [
        { name: "execution-id", value: source.qualify.started.executionId }
      ]),
      this.#evidence("specification", source.specify.outputArtifact, subject, createdAt, [
        { name: "execution-id", value: source.specify.started.executionId }
      ]),
      this.#evidence("plan", source.plan.outputArtifact, subject, createdAt, [
        { name: "execution-id", value: source.plan.started.executionId }
      ]),
      this.#evidence("contract", published.contractArtifact, subject, createdAt, [
        { name: "schema", value: compilation.contract.value.schemaVersion }
      ]),
      this.#evidence(
        "policy",
        published.policyArtifact,
        this.dependencies.policyBundle.digest,
        createdAt,
        [
          { name: "policy-id", value: this.dependencies.policyBundle.value.id },
          { name: "policy-version", value: this.dependencies.policyBundle.value.version }
        ]
      ),
      this.#evidence("provenance", source.authority, subject, createdAt, [
        { name: "document", value: "preparation-authority" }
      ]),
      this.#evidence("provenance", published.bundleArtifact, subject, createdAt, [
        { name: "document", value: "preparation-bundle" },
        { name: "bundle-digest", value: bundle.digest }
      ]),
      ...factoryPreparationPhases.flatMap((phase) => [
        this.#evidence("provenance", source[phase].runRequestArtifact, subject, createdAt, [
          { name: "document", value: "preparation-run-request" },
          { name: "phase", value: phase },
          { name: "execution-id", value: source[phase].started.executionId }
        ]),
        this.#evidence("provenance", source[phase].runRecordArtifact, subject, createdAt, [
          { name: "document", value: "preparation-run-record" },
          { name: "phase", value: phase },
          { name: "execution-id", value: source[phase].started.executionId }
        ])
      ])
    ];
    return this.dependencies.documents.evidenceBundle(
      evidenceBundleSchema.parse({
        schemaVersion: "agentlab.evidence-bundle.v1",
        bundleId: this.#id(),
        taskId: snapshot.request.taskId,
        sequence: 1,
        contractDigest: compilation.contract.digest,
        previousBundleDigest: null,
        policyBundleDigest: this.dependencies.policyBundle.digest,
        createdAt,
        items,
        attestations: []
      })
    );
  }

  #evidence(
    kind: EvidenceItem["kind"],
    artifact: FactoryArtifactReference,
    subjectDigest: Sha256Digest,
    createdAt: string,
    claims: EvidenceItem["claims"]
  ): EvidenceItem {
    return evidenceItemSchema.parse({
      id: this.#id(),
      kind,
      result: "pass",
      subjectDigest,
      artifact,
      producer: this.#actor,
      createdAt,
      claims
    });
  }

  #taskEvents(
    compilation: FactoryPreparationCompilation,
    evidenceBundleDigest: Sha256Digest,
    occurredAt: string,
    correlationId: string
  ): readonly CanonicalFactoryDocument<TaskEvent>[] {
    const states = ["intake", "qualified", "specified", "planned"] as const;
    const documents: CanonicalFactoryDocument<TaskEvent>[] = [];
    for (const [index, to] of states.entries()) {
      const previous = documents.at(-1) ?? null;
      documents.push(
        this.dependencies.documents.taskEvent({
          schemaVersion: "agentlab.task-event.v1",
          eventId: this.#id(),
          taskId: compilation.contract.value.taskId,
          sequence: index + 1,
          contractDigest: compilation.contract.digest,
          previousEventDigest: previous?.digest ?? null,
          from: previous?.value.to ?? null,
          to,
          actor: this.#actor,
          occurredAt,
          reasonCode: `preparation-${to}`,
          summary: null,
          evidenceBundleDigest: to === "planned" ? evidenceBundleDigest : null,
          correlationId
        })
      );
    }
    return documents;
  }

  async #publishCanonical<Value>(
    document: CanonicalFactoryDocument<Value>,
    mediaType: string
  ): Promise<FactoryArtifactReference> {
    const stored = await this.dependencies.artifacts.putText(document.json);
    if (
      stored.digest !== document.digest ||
      stored.sizeBytes !== utf8Encoder.encode(document.json).byteLength
    ) {
      throw new Error("Artifact store changed a canonical materialization document.");
    }
    return { ...stored, mediaType };
  }

  async #existing(
    snapshot: FactoryPreparationSnapshot
  ): Promise<FactoryPreparationMaterializationResult> {
    if (snapshot.lastEvent.kind !== "prepared") {
      throw new Error("Prepared journal has no materialization event.");
    }
    const task = await this.dependencies.tasks.findById(snapshot.request.taskId);
    if (task?.contractDigest !== snapshot.lastEvent.contractDigest) {
      throw new Error("Prepared journal has no exact materialized task contract.");
    }
    return {
      preparation: snapshot,
      task,
      preparationBundleDigest: snapshot.lastEvent.preparationBundleDigest,
      evidenceBundleDigest: snapshot.lastEvent.evidenceBundleDigest
    };
  }

  async #requirePreparation(taskId: string): Promise<FactoryPreparationSnapshot> {
    const snapshot = await this.dependencies.preparations.findById(taskId);
    if (snapshot === null) throw new Error(`Factory preparation ${taskId} does not exist.`);
    return snapshot;
  }

  #id(): string {
    return z.uuid().parse(this.dependencies.createId());
  }
}

interface PublishedMaterializationArtifacts {
  readonly bundleArtifact: FactoryArtifactReference;
  readonly contractArtifact: FactoryArtifactReference;
  readonly policyArtifact: FactoryArtifactReference;
}

function preparationRun(source: LoadedPreparationPhase) {
  return {
    executionId: source.started.executionId,
    phase: source.phase,
    skillId: source.started.skillId,
    skillPackageDigest: source.started.skillPackageDigest,
    workerProfileId: source.started.workerProfileId,
    provider: source.runRequest.value.provider,
    model: source.runRequest.value.model,
    reasoning: source.runRequest.value.reasoning,
    actor: source.completion.actor,
    startedAt: source.runRecord.value.startedAt,
    finishedAt: source.runRecord.value.finishedAt,
    runRecordDigest: source.runRecord.digest,
    outputDigest: source.output.digest
  };
}

function minimumTimestamp(left: string, right: string): string {
  return left <= right ? left : right;
}
