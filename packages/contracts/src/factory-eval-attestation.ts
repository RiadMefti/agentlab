import { z } from "zod";

import {
  factoryActorSchema,
  factoryIdentifierSchema,
  factoryTimestampSchema,
  sha256DigestSchema
} from "./factory.js";

export const factoryEvalAttestationPredicateType =
  "https://agentlab.dev/attestations/eval-run/v1" as const;
export const factoryEvalAttestationPayloadType = "application/vnd.in-toto+json" as const;

const rawSha256Schema = z
  .string()
  .regex(/^[0-9a-f]{64}$/u, "Expected a lowercase raw SHA-256 digest.");

const canonicalBase64Schema = z
  .string()
  .min(4)
  .max(128 * 1_024)
  .regex(
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u,
    "Expected canonical padded base64."
  );

const ed25519SignatureSchema = z
  .string()
  .length(88)
  .regex(/^[A-Za-z0-9+/]{86}==$/u, "Expected a canonical Ed25519 signature.");

/** AgentLab's custom in-toto predicate binds one exact raw eval report to its harness inputs. */
export const factoryEvalAttestationStatementSchema = z
  .object({
    _type: z.literal("https://in-toto.io/Statement/v1"),
    subject: z
      .array(
        z
          .object({
            name: z.literal("agentlab.eval-run"),
            digest: z.object({ sha256: rawSha256Schema }).strict()
          })
          .strict()
      )
      .length(1),
    predicateType: z.literal(factoryEvalAttestationPredicateType),
    predicate: z
      .object({
        schemaVersion: z.literal("agentlab.eval-run-attestation-predicate.v1"),
        runnerId: factoryIdentifierSchema,
        runId: z.uuid(),
        runDigest: sha256DigestSchema,
        suiteDigest: sha256DigestSchema,
        caseBankDigest: sha256DigestSchema,
        baselineHarnessDigest: sha256DigestSchema,
        challengerHarnessDigest: sha256DigestSchema,
        baselineCandidateDigest: sha256DigestSchema,
        challengerCandidateDigest: sha256DigestSchema,
        startedAt: factoryTimestampSchema,
        completedAt: factoryTimestampSchema,
        issuedAt: factoryTimestampSchema,
        expiresAt: factoryTimestampSchema
      })
      .strict()
  })
  .strict()
  .superRefine((statement, context) => {
    const predicate = statement.predicate;
    if (predicate.completedAt < predicate.startedAt) {
      context.addIssue({
        code: "custom",
        path: ["predicate", "completedAt"],
        message: "Attested eval completion must not precede its start."
      });
    }
    if (predicate.issuedAt < predicate.completedAt) {
      context.addIssue({
        code: "custom",
        path: ["predicate", "issuedAt"],
        message: "An eval attestation cannot be issued before the run completes."
      });
    }
    if (predicate.expiresAt <= predicate.issuedAt) {
      context.addIssue({
        code: "custom",
        path: ["predicate", "expiresAt"],
        message: "An eval attestation must expire after issuance."
      });
    }
    if (`sha256:${statement.subject[0]?.digest.sha256 ?? ""}` !== predicate.runDigest) {
      context.addIssue({
        code: "custom",
        path: ["subject", 0, "digest", "sha256"],
        message: "The in-toto subject must equal the attested eval-run digest."
      });
    }
  });
export type FactoryEvalAttestationStatement = z.infer<typeof factoryEvalAttestationStatementSchema>;

export const factoryDsseEnvelopeSchema = z
  .object({
    payloadType: z.literal(factoryEvalAttestationPayloadType),
    payload: canonicalBase64Schema,
    signatures: z
      .array(
        z
          .object({
            keyid: sha256DigestSchema,
            sig: ed25519SignatureSchema
          })
          .strict()
      )
      .length(1)
  })
  .strict();
export type FactoryDsseEnvelope = z.infer<typeof factoryDsseEnvelopeSchema>;

/** Portable signed artifact emitted by the isolated runner-side attestor. */
export const factorySignedEvalAttestationSchema = z
  .object({
    schemaVersion: z.literal("agentlab.signed-eval-attestation.v1"),
    statementDigest: sha256DigestSchema,
    statement: factoryEvalAttestationStatementSchema,
    envelopeDigest: sha256DigestSchema,
    envelope: factoryDsseEnvelopeSchema
  })
  .strict();
export type FactorySignedEvalAttestation = z.infer<typeof factorySignedEvalAttestationSchema>;

/** Immutable verifier record; verification is repeated before every authority decision. */
export const factoryEvalAttestationRecordSchema = z
  .object({
    schemaVersion: z.literal("agentlab.eval-attestation-record.v1"),
    attestationId: z.uuid(),
    assessmentDigest: sha256DigestSchema,
    runId: z.uuid(),
    runDigest: sha256DigestSchema,
    signedAttestationDigest: sha256DigestSchema,
    statementDigest: sha256DigestSchema,
    envelopeDigest: sha256DigestSchema,
    keyId: sha256DigestSchema,
    verifiedAt: factoryTimestampSchema,
    verifier: factoryActorSchema,
    signedAttestation: factorySignedEvalAttestationSchema
  })
  .strict()
  .superRefine((record, context) => {
    if (
      record.verifier.kind !== "control-plane" ||
      record.verifier.role !== "policy-engine" ||
      record.verifier.id !== "agentlab-eval-attestation"
    ) {
      context.addIssue({
        code: "custom",
        path: ["verifier"],
        message: "Eval attestation records require the fixed verifier actor."
      });
    }
    if (record.runId !== record.signedAttestation.statement.predicate.runId) {
      context.addIssue({
        code: "custom",
        path: ["runId"],
        message: "Eval attestation record run ID must match its signed statement."
      });
    }
    if (record.runDigest !== record.signedAttestation.statement.predicate.runDigest) {
      context.addIssue({
        code: "custom",
        path: ["runDigest"],
        message: "Eval attestation record run digest must match its signed statement."
      });
    }
    if (
      record.statementDigest !== record.signedAttestation.statementDigest ||
      record.envelopeDigest !== record.signedAttestation.envelopeDigest
    ) {
      context.addIssue({
        code: "custom",
        path: ["signedAttestation"],
        message: "Eval attestation record digests must match its signed artifact."
      });
    }
    if (record.verifiedAt < record.signedAttestation.statement.predicate.issuedAt) {
      context.addIssue({
        code: "custom",
        path: ["verifiedAt"],
        message: "Eval attestation verification cannot precede signature issuance."
      });
    }
    if (record.verifiedAt >= record.signedAttestation.statement.predicate.expiresAt) {
      context.addIssue({
        code: "custom",
        path: ["verifiedAt"],
        message: "Eval attestation verification must precede signature expiry."
      });
    }
  });
export type FactoryEvalAttestationRecord = z.infer<typeof factoryEvalAttestationRecordSchema>;
