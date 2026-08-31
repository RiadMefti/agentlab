import type {
  FactoryArtifactReference,
  FactoryPreparationEvent,
  FactoryPreparationPhase,
  FactoryPreparationRunRecord,
  FactoryPreparationRunRequest,
  Sha256Digest
} from "@agentlab/contracts";

import type { FactoryArtifactStore } from "../domain/factory-artifact-store.js";
import { factoryUsageFits } from "../domain/factory-authority-limits.js";
import type {
  CanonicalFactoryDocument,
  FactoryDocumentCodec
} from "../domain/factory-documents.js";
import type { FactoryPolicyEngine } from "../domain/factory-policy.js";
import type { FactoryPreparationSnapshot } from "../domain/factory-preparation-repository.js";
import { narrowFactoryResourceLimits } from "../domain/factory-process-isolation.js";

const maximumMaterializationArtifactBytes = 8 * 1_024 * 1_024;
const utf8Encoder = new TextEncoder();

export const factoryPreparationPhases = ["qualify", "specify", "plan"] as const;

export interface LoadedPreparationPhase {
  readonly phase: FactoryPreparationPhase;
  readonly started: Extract<FactoryPreparationEvent, { readonly kind: "phase-started" }>;
  readonly completion: Extract<FactoryPreparationEvent, { readonly kind: "phase-succeeded" }>;
  readonly output: CanonicalFactoryDocument<unknown>;
  readonly outputArtifact: FactoryArtifactReference;
  readonly runRequest: CanonicalFactoryDocument<FactoryPreparationRunRequest>;
  readonly runRequestArtifact: FactoryArtifactReference;
  readonly runRecord: CanonicalFactoryDocument<FactoryPreparationRunRecord>;
  readonly runRecordArtifact: FactoryArtifactReference;
}

export interface FactoryPreparationSource {
  readonly request: FactoryArtifactReference;
  readonly authority: FactoryArtifactReference;
  readonly qualify: LoadedPreparationPhase;
  readonly specify: LoadedPreparationPhase;
  readonly plan: LoadedPreparationPhase;
}

export interface FactoryPreparationSourceLoaderDependencies {
  readonly artifacts: FactoryArtifactStore;
  readonly documents: FactoryDocumentCodec;
  readonly policy: FactoryPolicyEngine;
}

/** Replays and verifies every content-addressed artifact needed to compile a planned journal. */
export class FactoryPreparationSourceLoader {
  public constructor(private readonly dependencies: FactoryPreparationSourceLoaderDependencies) {}

  public async load(
    snapshot: FactoryPreparationSnapshot,
    history: readonly FactoryPreparationEvent[]
  ): Promise<FactoryPreparationSource> {
    const request = await this.#readDigest(
      snapshot.requestDigest,
      "intake request",
      this.dependencies.documents.intakeRequest.bind(this.dependencies.documents),
      "application/vnd.agentlab.intake-request.v1+json"
    );
    const authority = await this.#readDigest(
      snapshot.authorityDigest,
      "preparation authority",
      this.dependencies.documents.preparationAuthority.bind(this.dependencies.documents),
      "application/vnd.agentlab.preparation-authority.v2+json"
    );
    if (
      request.document.json !== this.dependencies.documents.intakeRequest(snapshot.request).json
    ) {
      throw new Error("Stored intake request does not match the preparation journal.");
    }
    if (
      authority.document.json !==
      this.dependencies.documents.preparationAuthority(snapshot.authority).json
    ) {
      throw new Error("Stored preparation authority does not match the journal.");
    }
    const loaded = await Promise.all(
      factoryPreparationPhases.map((phase) => this.#loadPhase(snapshot, history, phase))
    );
    return {
      request: request.artifact,
      authority: authority.artifact,
      qualify: requiredLoadedPhase(loaded, "qualify"),
      specify: requiredLoadedPhase(loaded, "specify"),
      plan: requiredLoadedPhase(loaded, "plan")
    };
  }

  async #loadPhase(
    snapshot: FactoryPreparationSnapshot,
    history: readonly FactoryPreparationEvent[],
    phase: FactoryPreparationPhase
  ): Promise<LoadedPreparationPhase> {
    const completionIndex = history.findIndex(
      (event) => event.kind === "phase-succeeded" && event.phase === phase
    );
    const completion = history[completionIndex];
    const started = history[completionIndex - 1];
    if (
      completion?.kind !== "phase-succeeded" ||
      started?.kind !== "phase-started" ||
      started.phase !== phase ||
      completion.executionId !== started.executionId ||
      completion.attempt !== started.attempt ||
      completion.runRequestDigest !== started.runRequestDigest
    ) {
      throw new Error(`Preparation journal has no exact successful ${phase} run.`);
    }
    const output = await this.#readReference(
      completion.outputArtifact,
      `${phase} output`,
      phaseDecoder(this.dependencies.documents, phase)
    );
    const runRequest = await this.#readDigest(
      started.runRequestDigest,
      `${phase} run request`,
      this.dependencies.documents.preparationRunRequest.bind(this.dependencies.documents),
      "application/vnd.agentlab.preparation-run-request+json;version=1"
    );
    const runRecord = await this.#readReference(
      completion.runRecordArtifact,
      `${phase} run record`,
      this.dependencies.documents.preparationRunRecord.bind(this.dependencies.documents)
    );
    await this.#verifyRunArtifacts(runRequest.document.value, runRecord.document.value);
    assertRunLinks(
      snapshot,
      started,
      completion,
      runRequest.document.value,
      runRecord.document.value
    );
    if (
      !sameJson(
        runRecord.document.value.isolation.limits,
        narrowFactoryResourceLimits(
          this.dependencies.policy.requirements("R0", "execution").resourceLimits,
          runRequest.document.value.budget.maxProcesses
        )
      )
    ) {
      throw new Error(`Preparation ${phase} run did not enforce the R0 resource profile.`);
    }
    return {
      phase,
      started,
      completion,
      output: output.document,
      outputArtifact: output.artifact,
      runRequest: runRequest.document,
      runRequestArtifact: runRequest.artifact,
      runRecord: runRecord.document,
      runRecordArtifact: runRecord.artifact
    };
  }

  async #verifyRunArtifacts(
    request: FactoryPreparationRunRequest,
    record: FactoryPreparationRunRecord
  ): Promise<void> {
    await this.#verifyReference(request.promptArtifact, "preparation prompt");
    await Promise.all([
      this.#verifyReference(record.stdoutArtifact, "preparation stdout"),
      this.#verifyReference(record.stderrArtifact, "preparation stderr"),
      ...(record.finalOutputArtifact === null
        ? []
        : [this.#verifyReference(record.finalOutputArtifact, "preparation final output")])
    ]);
  }

  async #readDigest<Value>(
    digest: Sha256Digest,
    label: string,
    decode: (input: unknown) => CanonicalFactoryDocument<Value>,
    mediaType: string
  ): Promise<LoadedDocument<Value>> {
    const json = await this.dependencies.artifacts.readText(
      digest,
      maximumMaterializationArtifactBytes
    );
    const document = decode(parseJson(json, label));
    if (document.digest !== digest || document.json !== json) {
      throw new Error(`Stored ${label} is not its exact canonical artifact.`);
    }
    return {
      document,
      artifact: { digest, mediaType, sizeBytes: utf8Encoder.encode(json).byteLength }
    };
  }

  async #readReference<Value>(
    artifact: FactoryArtifactReference,
    label: string,
    decode: (input: unknown) => CanonicalFactoryDocument<Value>
  ): Promise<LoadedDocument<Value>> {
    const loaded = await this.#readDigest(artifact.digest, label, decode, artifact.mediaType);
    if (loaded.artifact.sizeBytes !== artifact.sizeBytes) {
      throw new Error(`Stored ${label} size does not match its journal reference.`);
    }
    return loaded;
  }

  async #verifyReference(artifact: FactoryArtifactReference, label: string): Promise<void> {
    if (artifact.sizeBytes > maximumMaterializationArtifactBytes) {
      throw new Error(`${label} exceeds the materialization artifact limit.`);
    }
    const content = await this.dependencies.artifacts.read(
      artifact.digest,
      maximumMaterializationArtifactBytes
    );
    if (content.byteLength !== artifact.sizeBytes) {
      throw new Error(`${label} size does not match its immutable reference.`);
    }
  }
}

interface LoadedDocument<Value> {
  readonly document: CanonicalFactoryDocument<Value>;
  readonly artifact: FactoryArtifactReference;
}

function phaseDecoder(
  documents: FactoryDocumentCodec,
  phase: FactoryPreparationPhase
): (input: unknown) => CanonicalFactoryDocument<unknown> {
  if (phase === "qualify") return documents.qualification.bind(documents);
  if (phase === "specify") return documents.specification.bind(documents);
  return documents.plan.bind(documents);
}

function requiredLoadedPhase(
  phases: readonly LoadedPreparationPhase[],
  phase: FactoryPreparationPhase
): LoadedPreparationPhase {
  const loaded = phases.find((candidate) => candidate.phase === phase);
  if (loaded === undefined) throw new Error(`Missing loaded ${phase} preparation phase.`);
  return loaded;
}

function assertRunLinks(
  snapshot: FactoryPreparationSnapshot,
  started: Extract<FactoryPreparationEvent, { readonly kind: "phase-started" }>,
  completion: Extract<FactoryPreparationEvent, { readonly kind: "phase-succeeded" }>,
  request: FactoryPreparationRunRequest,
  record: FactoryPreparationRunRecord
): void {
  const profile = snapshot.authority.preparationProfiles.find(
    ({ phase }) => phase === started.phase
  );
  const skill = snapshot.authority.skills.find(({ manifest }) => manifest.id === started.skillId);
  if (
    profile === undefined ||
    skill?.phase !== started.phase ||
    request.executionId !== started.executionId ||
    request.taskId !== snapshot.request.taskId ||
    request.requestDigest !== snapshot.requestDigest ||
    request.authorityDigest !== snapshot.authorityDigest ||
    request.phase !== started.phase ||
    request.attempt !== started.attempt ||
    request.skillId !== started.skillId ||
    request.skillPackageDigest !== started.skillPackageDigest ||
    request.outputSchemaDigest !== skill.manifest.outputSchemaDigest ||
    !sameValues(request.inputArtifactDigests, started.inputArtifactDigests) ||
    !sameJson(request.repository, snapshot.request.repository) ||
    request.provider !== profile.provider ||
    request.model !== profile.model ||
    request.reasoning !== profile.reasoning ||
    !sameJson(request.capabilities, profile.capabilities) ||
    !sameJson(request.budget, profile.budget) ||
    record.executionId !== request.executionId ||
    record.taskId !== request.taskId ||
    record.requestDigest !== request.requestDigest ||
    record.authorityDigest !== request.authorityDigest ||
    record.phase !== request.phase ||
    record.attempt !== request.attempt ||
    record.provider !== request.provider ||
    record.model !== request.model ||
    record.reasoning !== request.reasoning ||
    record.status !== "succeeded" ||
    record.providerSessionId === null ||
    record.finishedAt !== completion.occurredAt ||
    record.startedAt < started.occurredAt ||
    record.isolation.isolationId !== request.executionId ||
    record.outputDocumentArtifact?.digest !== completion.outputArtifact.digest ||
    record.outputDocumentArtifact.sizeBytes !== completion.outputArtifact.sizeBytes ||
    record.outputDocumentArtifact.mediaType !== completion.outputArtifact.mediaType ||
    completion.actor.kind !== "agent" ||
    completion.actor.id !== profile.id ||
    completion.actor.sessionId !== record.providerSessionId ||
    !record.usageComplete ||
    !factoryUsageFits(record.usage, profile.budget)
  ) {
    throw new Error(
      `Preparation ${started.phase} run record does not match its exact journal run.`
    );
  }
}

function sameValues(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error: unknown) {
    throw new Error(`Stored ${label} is not valid JSON.`, { cause: error });
  }
}
