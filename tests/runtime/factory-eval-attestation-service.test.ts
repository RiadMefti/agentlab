import { createHash, generateKeyPairSync, type KeyObject } from "node:crypto";

import type {
  FactoryEvalAttestationRecord,
  FactorySignedEvalAttestation,
  Sha256Digest
} from "@agentlab/contracts";
import { sha256DigestSchema } from "@agentlab/contracts";
import { describe, expect, it, vi } from "vitest";

import { FactoryEvalAttestationService } from "../../packages/runtime/src/application/factory-eval-attestation-service.js";
import { FactoryEvalAttestorService } from "../../packages/runtime/src/application/factory-eval-attestor-service.js";
import type { FactoryEvalAttestationKeySource } from "../../packages/runtime/src/domain/factory-eval-attestation-crypto.js";
import type {
  FactoryEvalAttestationRepository,
  FactoryEvalAttestationSnapshot
} from "../../packages/runtime/src/domain/factory-eval-attestation-repository.js";
import type { CanonicalFactoryDocument } from "../../packages/runtime/src/domain/factory-documents.js";
import type {
  FactoryEvaluationRepository,
  FactoryEvalSnapshot
} from "../../packages/runtime/src/domain/factory-evaluation-repository.js";
import { NodeFactoryDsseSigner } from "../../packages/runtime/src/infrastructure/crypto/node-factory-dsse-signer.js";
import { NodeFactoryDsseVerifier } from "../../packages/runtime/src/infrastructure/crypto/node-factory-dsse-verifier.js";
import { NodeFactoryDocumentCodec } from "../../packages/runtime/src/infrastructure/persistence/canonical-factory-documents.js";
import {
  TEST_EVAL_ASSESSMENT_ID,
  TEST_EVAL_RUN_ID,
  testEvalDigest,
  testFactoryEvalDocuments,
  testFactoryEvalRun
} from "../helpers/factory-evaluation.js";

const documents = new NodeFactoryDocumentCodec();
const attestationId = "10000000-0000-4000-8000-000000000006";

describe("FactoryEvalAttestorService and FactoryEvalAttestationService", () => {
  it("signs, verifies, records, and re-verifies one exact eval run idempotently", async () => {
    const fixture = await services();

    expect(fixture.signed.statement.predicate).toMatchObject({
      runnerId: "trusted-eval-runner",
      runId: TEST_EVAL_RUN_ID,
      runDigest: fixture.evaluation.runDigest,
      baselineHarnessDigest: fixture.evaluation.run.baselineCandidate.harnessDigest,
      challengerHarnessDigest: fixture.evaluation.run.challengerCandidate.harnessDigest,
      issuedAt: "2026-08-30T11:31:00.000Z",
      expiresAt: "2026-08-30T12:31:00.000Z"
    });

    const first = await fixture.verification.record({
      assessmentDigest: fixture.evaluation.assessmentDigest,
      signedAttestation: fixture.signed
    });
    const second = await fixture.verification.record({
      assessmentDigest: fixture.evaluation.assessmentDigest,
      signedAttestation: fixture.signed
    });

    expect(first).toMatchObject({
      schemaVersion: "agentlab.eval-attestation-result.v1",
      status: "recorded",
      attestation: {
        attestationId,
        runDigest: fixture.evaluation.runDigest,
        verifier: { id: "agentlab-eval-attestation", role: "policy-engine" }
      }
    });
    expect(second).toEqual({ ...first, status: "existing" });
    expect(fixture.attestations.recordCalls).toBe(1);
    expect(fixture.createId).toHaveBeenCalledTimes(1);
    await expect(
      fixture.verification.requireVerified(fixture.evaluation.runDigest, "2026-08-30T12:30:59.999Z")
    ).resolves.toEqual({
      attestation: first.attestation,
      attestationDigest: first.attestationDigest
    });
  });

  it("rejects a statement substitution even when its wrapper digests are recomputed", async () => {
    const fixture = await services();
    const substitutedStatement = documents.evalAttestationStatement({
      ...fixture.signed.statement,
      predicate: {
        ...fixture.signed.statement.predicate,
        challengerHarnessDigest: testEvalDigest(999)
      }
    });
    const substituted = documents.signedEvalAttestation({
      ...fixture.signed,
      statementDigest: substitutedStatement.digest,
      statement: substitutedStatement.value
    }).value;

    await expect(
      fixture.verification.record({
        assessmentDigest: fixture.evaluation.assessmentDigest,
        signedAttestation: substituted
      })
    ).rejects.toThrow(/canonical DSSE validation/u);
    expect(fixture.attestations.recordCalls).toBe(0);
    expect(fixture.createId).not.toHaveBeenCalled();
  });

  it("rejects a valid signature over a different run and immutable re-attestation", async () => {
    const fixture = await services();
    const otherRun = testFactoryEvalRun({
      runId: "10000000-0000-4000-8000-000000000007",
      correlationId: "10000000-0000-4000-8000-000000000008"
    });
    const signedOther = await fixture.attestor.attest(otherRun);

    await expect(
      fixture.verification.record({
        assessmentDigest: fixture.evaluation.assessmentDigest,
        signedAttestation: signedOther
      })
    ).rejects.toThrow(/does not match its exact eval run/u);

    await fixture.verification.record({
      assessmentDigest: fixture.evaluation.assessmentDigest,
      signedAttestation: fixture.signed
    });
    const laterAttestor = new FactoryEvalAttestorService({
      runnerId: "trusted-eval-runner",
      attestationLifetimeSeconds: 3_600,
      maximumIssuanceDelaySeconds: 300,
      signer: fixture.signer,
      documents,
      now: () => "2026-08-30T11:33:00.000Z"
    });
    const later = await laterAttestor.attest(fixture.evaluation.run);
    await expect(
      fixture.verification.record({
        assessmentDigest: fixture.evaluation.assessmentDigest,
        signedAttestation: later
      })
    ).rejects.toThrow(/different immutable signed attestation/u);
  });

  it("fails closed before issuance, at expiry, after expiry, and without an assessment", async () => {
    const before = await services({ verifierNow: "2026-08-30T11:30:59.999Z" });
    await expect(
      before.verification.record({
        assessmentDigest: before.evaluation.assessmentDigest,
        signedAttestation: before.signed
      })
    ).rejects.toThrow(/not currently valid/u);

    const expired = await services({ verifierNow: "2026-08-30T12:31:00.000Z" });
    await expect(
      expired.verification.record({
        assessmentDigest: expired.evaluation.assessmentDigest,
        signedAttestation: expired.signed
      })
    ).rejects.toThrow(/not currently valid/u);

    const recorded = await services();
    await recorded.verification.record({
      assessmentDigest: recorded.evaluation.assessmentDigest,
      signedAttestation: recorded.signed
    });
    await expect(
      recorded.verification.requireVerified(
        recorded.evaluation.runDigest,
        "2026-08-30T12:31:00.000Z"
      )
    ).rejects.toThrow(/outside its validity window/u);
    await expect(
      recorded.verification.record({
        assessmentDigest: testEvalDigest(998),
        signedAttestation: recorded.signed
      })
    ).rejects.toThrow(/does not exist/u);
  });

  it("keeps runner identity and attestation lifetime fail-closed", async () => {
    const key = signingKey();
    const signer = new NodeFactoryDsseSigner(new StaticKeySource(key.privatePem), key.keyId);
    const attestor = new FactoryEvalAttestorService({
      runnerId: "trusted-eval-runner",
      attestationLifetimeSeconds: 3_600,
      maximumIssuanceDelaySeconds: 300,
      signer,
      documents,
      now: () => "2026-08-30T11:31:00.000Z"
    });

    await expect(attestor.attest(testFactoryEvalRun({ actorId: "other-runner" }))).rejects.toThrow(
      /attestor identity/u
    );
    expect(
      () =>
        new FactoryEvalAttestorService({
          runnerId: "trusted-eval-runner",
          attestationLifetimeSeconds: 59,
          maximumIssuanceDelaySeconds: 300,
          signer,
          documents,
          now: () => "2026-08-30T11:31:00.000Z"
        })
    ).toThrow(/between 60 seconds and 7 days/u);

    const staleAttestor = new FactoryEvalAttestorService({
      runnerId: "trusted-eval-runner",
      attestationLifetimeSeconds: 3_600,
      maximumIssuanceDelaySeconds: 30,
      signer,
      documents,
      now: () => "2026-08-30T11:30:31.000Z"
    });
    await expect(staleAttestor.attest(testFactoryEvalRun())).rejects.toThrow(/trusted run window/u);

    const independentlyBounded = await services({ maximumAttestationLifetimeSeconds: 1_800 });
    await expect(
      independentlyBounded.verification.record({
        assessmentDigest: independentlyBounded.evaluation.assessmentDigest,
        signedAttestation: independentlyBounded.signed
      })
    ).rejects.toThrow(/trusted validity window/u);
  });
});

class MemoryEvaluations implements FactoryEvaluationRepository {
  public constructor(private readonly snapshot: FactoryEvalSnapshot) {}

  public record(): Promise<FactoryEvalSnapshot> {
    throw new Error("Unexpected evaluation mutation.");
  }

  public findByRunId(runId: string): Promise<FactoryEvalSnapshot | null> {
    return Promise.resolve(this.snapshot.run.runId === runId ? this.snapshot : null);
  }

  public findByAssessmentDigest(
    assessmentDigest: Sha256Digest
  ): Promise<FactoryEvalSnapshot | null> {
    return Promise.resolve(
      this.snapshot.assessmentDigest === assessmentDigest ? this.snapshot : null
    );
  }

  public close(): void {
    return;
  }
}

class MemoryAttestations implements FactoryEvalAttestationRepository {
  readonly #byRun = new Map<Sha256Digest, FactoryEvalAttestationSnapshot>();
  readonly #byDigest = new Map<Sha256Digest, FactoryEvalAttestationSnapshot>();
  public recordCalls = 0;

  public record(
    attestation: CanonicalFactoryDocument<FactoryEvalAttestationRecord>
  ): Promise<FactoryEvalAttestationSnapshot> {
    this.recordCalls += 1;
    const snapshot = {
      attestation: attestation.value,
      attestationDigest: attestation.digest
    };
    this.#byRun.set(attestation.value.runDigest, snapshot);
    this.#byDigest.set(attestation.digest, snapshot);
    return Promise.resolve(snapshot);
  }

  public findByRunDigest(runDigest: Sha256Digest): Promise<FactoryEvalAttestationSnapshot | null> {
    return Promise.resolve(this.#byRun.get(runDigest) ?? null);
  }

  public findByAttestationDigest(
    attestationDigest: Sha256Digest
  ): Promise<FactoryEvalAttestationSnapshot | null> {
    return Promise.resolve(this.#byDigest.get(attestationDigest) ?? null);
  }

  public close(): void {
    this.#byRun.clear();
    this.#byDigest.clear();
  }
}

class StaticKeySource implements FactoryEvalAttestationKeySource {
  public constructor(private readonly material: Uint8Array) {}

  public load(): Promise<Uint8Array> {
    return Promise.resolve(Uint8Array.from(this.material));
  }
}

async function services(
  options: {
    readonly verifierNow?: string;
    readonly maximumAttestationLifetimeSeconds?: number;
  } = {}
): Promise<{
  readonly evaluation: FactoryEvalSnapshot;
  readonly signer: NodeFactoryDsseSigner;
  readonly attestor: FactoryEvalAttestorService;
  readonly signed: FactorySignedEvalAttestation;
  readonly attestations: MemoryAttestations;
  readonly verification: FactoryEvalAttestationService;
  readonly createId: ReturnType<typeof vi.fn<() => string>>;
}> {
  const key = signingKey();
  const signer = new NodeFactoryDsseSigner(new StaticKeySource(key.privatePem), key.keyId);
  const verifier = new NodeFactoryDsseVerifier(new StaticKeySource(key.publicPem), key.keyId);
  const evaluation = testFactoryEvalDocuments({
    assessmentId: TEST_EVAL_ASSESSMENT_ID
  }).snapshot;
  const attestor = new FactoryEvalAttestorService({
    runnerId: "trusted-eval-runner",
    attestationLifetimeSeconds: 3_600,
    maximumIssuanceDelaySeconds: 300,
    signer,
    documents,
    now: () => "2026-08-30T11:31:00.000Z"
  });
  const signed = await attestor.attest(evaluation.run);
  const attestations = new MemoryAttestations();
  const createId = vi.fn(() => attestationId);
  return {
    evaluation,
    signer,
    attestor,
    signed,
    attestations,
    verification: new FactoryEvalAttestationService({
      evaluations: new MemoryEvaluations(evaluation),
      attestations,
      verifier,
      maximumIssuanceDelaySeconds: 300,
      maximumAttestationLifetimeSeconds: options.maximumAttestationLifetimeSeconds ?? 3_600,
      documents,
      now: () => options.verifierNow ?? "2026-08-30T11:32:00.000Z",
      createId
    }),
    createId
  };
}

function signingKey(): {
  readonly privatePem: Uint8Array;
  readonly publicPem: Uint8Array;
  readonly keyId: Sha256Digest;
} {
  const pair = generateKeyPairSync("ed25519");
  return {
    privatePem: Buffer.from(pair.privateKey.export({ format: "pem", type: "pkcs8" })),
    publicPem: Buffer.from(pair.publicKey.export({ format: "pem", type: "spki" })),
    keyId: keyId(pair.publicKey)
  };
}

function keyId(publicKey: KeyObject): Sha256Digest {
  const der = publicKey.export({ format: "der", type: "spki" });
  return sha256DigestSchema.parse(`sha256:${createHash("sha256").update(der).digest("hex")}`);
}
