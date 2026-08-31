import {
  factoryEvalAttestationPayloadType,
  factoryIdentifierSchema,
  factoryTimestampSchema,
  type FactorySignedEvalAttestation
} from "@agentlab/contracts";

import type { FactoryDsseSigner } from "../domain/factory-eval-attestation-crypto.js";
import {
  assertFactoryEvalAttestationTiming,
  assertFactoryEvalAttestationTimingPolicy
} from "../domain/factory-eval-attestation-policy.js";
import type { FactoryDocumentCodec } from "../domain/factory-documents.js";
import { assertFactoryEvalRun } from "../domain/factory-evaluation-integrity.js";
import { factoryTimestampAddSeconds } from "../domain/factory-timestamp.js";

export interface FactoryEvalAttestorServiceDependencies {
  readonly runnerId: string;
  readonly attestationLifetimeSeconds: number;
  readonly maximumIssuanceDelaySeconds: number;
  readonly signer: FactoryDsseSigner;
  readonly documents: Pick<
    FactoryDocumentCodec,
    | "configurationCandidate"
    | "evalSuite"
    | "evalRun"
    | "evalAttestationStatement"
    | "dsseEnvelope"
    | "signedEvalAttestation"
  >;
  readonly now: () => string;
}

/** Runner-side signer; it receives no database, model, process, GitHub, or authority capability. */
export class FactoryEvalAttestorService {
  readonly #runnerId: string;
  readonly #attestationLifetimeSeconds: number;
  readonly #maximumIssuanceDelaySeconds: number;

  public constructor(private readonly dependencies: FactoryEvalAttestorServiceDependencies) {
    this.#runnerId = factoryIdentifierSchema.parse(dependencies.runnerId);
    assertFactoryEvalAttestationTimingPolicy({
      maximumIssuanceDelaySeconds: dependencies.maximumIssuanceDelaySeconds,
      maximumAttestationLifetimeSeconds: dependencies.attestationLifetimeSeconds
    });
    this.#attestationLifetimeSeconds = dependencies.attestationLifetimeSeconds;
    this.#maximumIssuanceDelaySeconds = dependencies.maximumIssuanceDelaySeconds;
  }

  public async attest(input: unknown): Promise<FactorySignedEvalAttestation> {
    const run = this.dependencies.documents.evalRun(input);
    assertFactoryEvalRun(run, this.dependencies.documents);
    if (run.value.actor.id !== this.#runnerId) {
      throw new Error("Factory eval run actor does not match this attestor identity.");
    }
    const issuedAt = factoryTimestampSchema.parse(this.dependencies.now());
    const expiresAt = factoryTimestampAddSeconds(issuedAt, this.#attestationLifetimeSeconds);
    assertFactoryEvalAttestationTiming(run.value.completedAt, issuedAt, expiresAt, {
      maximumIssuanceDelaySeconds: this.#maximumIssuanceDelaySeconds,
      maximumAttestationLifetimeSeconds: this.#attestationLifetimeSeconds
    });
    const statement = this.dependencies.documents.evalAttestationStatement({
      _type: "https://in-toto.io/Statement/v1",
      subject: [
        {
          name: "agentlab.eval-run",
          digest: { sha256: run.digest.slice("sha256:".length) }
        }
      ],
      predicateType: "https://agentlab.dev/attestations/eval-run/v1",
      predicate: {
        schemaVersion: "agentlab.eval-run-attestation-predicate.v1",
        runnerId: this.#runnerId,
        runId: run.value.runId,
        runDigest: run.digest,
        suiteDigest: run.value.suiteDigest,
        caseBankDigest: run.value.suite.caseBankDigest,
        baselineHarnessDigest: run.value.baselineCandidate.harnessDigest,
        challengerHarnessDigest: run.value.challengerCandidate.harnessDigest,
        baselineCandidateDigest: run.value.baselineCandidateDigest,
        challengerCandidateDigest: run.value.challengerCandidateDigest,
        startedAt: run.value.startedAt,
        completedAt: run.value.completedAt,
        issuedAt,
        expiresAt
      }
    });
    const signed = await this.dependencies.signer.sign(
      factoryEvalAttestationPayloadType,
      statement.json
    );
    const envelope = this.dependencies.documents.dsseEnvelope(signed.envelope);
    if (!envelope.value.signatures.some(({ keyid }) => keyid === signed.keyId)) {
      throw new Error("Factory eval signer did not identify its verified signing key.");
    }
    return this.dependencies.documents.signedEvalAttestation({
      schemaVersion: "agentlab.signed-eval-attestation.v1",
      statementDigest: statement.digest,
      statement: statement.value,
      envelopeDigest: envelope.digest,
      envelope: envelope.value
    }).value;
  }
}
