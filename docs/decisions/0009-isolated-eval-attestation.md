# ADR 0009: isolate eval signing from verification and authority

**Status:** Accepted; implemented but not consumed by canary authority

**Date:** 2026-08-31

## Context

ADR 0007 made evaluation deterministic and separated it from human canary authority, but its
owner-only eval-run file authenticated only the local file boundary. It did not establish which key
signed the exact run, bind the signed run to its immutable assessment, or let a verifier reject a
stale or substituted report. A runner identity inside JSON is audit metadata, not authentication.

The design follows the
[in-toto Attestation Framework v1 statement model](https://github.com/in-toto/attestation/blob/main/spec/v1/README.md)
and the
[DSSE envelope and pre-authentication encoding](https://github.com/in-toto/attestation/blob/main/spec/v1/envelope.md).
The broader [SLSA 1.2 specification](https://slsa.dev/spec/v1.2/) informs the separation between an
authenticated statement and provenance claims. This custom predicate is not claimed to be SLSA
provenance, and a valid signature does not prove that the stated trials were honestly executed.

## Decision

Add a third exact promotion composition and keep all three roles disjoint:

```text
external harness emits exact eval-run
             │
             ├──▶ credentialless evaluator ──▶ immutable run + deterministic assessment
             │
             └──▶ isolated key-bearing attestor ──▶ portable signed artifact
                                                        │
                                                        ▼
                         public-key verifier/evaluator ──▶ immutable attestation record
                                                        │
                                                        ▼
                         no cohort consumer or authority transition yet
```

`@agentlab/runtime/factory-eval-attestor` receives only a strict owner-only run, runner identity,
Ed25519 private-key path, expected SHA-256 public-key ID, and timing bounds. It has no SQLite,
provider, model, process executor, repository, GitHub, broker, switch, merge, release, or canary
capability. Its only command signs. The public package entry, CLI runner, and transitive source
closure have executable architecture tests.

`@agentlab/runtime/factory-evaluator` remains credentialless. Config v2 adds one owner-only trusted
Ed25519 public-key path and expected key ID plus independent maximum issuance-delay and lifetime
bounds. It can assess, inspect, or verify-and-record an artifact. Its closure cannot reach the
private-key signer. The attestor and verifier use separate crypto modules; only bounded DSSE
encoding and public-key-ID helpers are shared.

The signed object is a strict `agentlab.signed-eval-attestation.v1` containing a canonical in-toto
Statement v1 under predicate type `https://agentlab.dev/attestations/eval-run/v1` and one DSSE
signature. The subject is the exact canonical eval-run SHA-256 digest. The predicate binds runner,
run, suite, case bank, baseline and challenger harnesses, both candidate digests, run timestamps,
issuance, and expiry. V1 accepts exactly one Ed25519 signature and canonical padded base64.

The verifier trusts only its configured public key. The envelope `keyid` is a selection hint and
must equal the independently derived SHA-256 digest of the configured SPKI DER key. Verification
occurs over DSSE pre-authentication encoding before payload parsing. The decoded payload must be
canonical UTF-8 and byte-identical to the canonical embedded statement. The statement must then
match every exact immutable run coordinate. Wrapper, statement, envelope, and run digests are
recomputed rather than trusted.

An attestation may be issued only shortly after run completion and must have a bounded lifetime. The
signer enforces its configured limits; the verifier independently enforces its own limits and the
current validity window. The verifier binds the artifact to the exact assessment digest and records
the fixed `agentlab-eval-attestation` policy-engine actor. Every read used through the service
repeats canonical, semantic, cryptographic, assessment-link, and expiry verification.

## Durability and recovery

SQLite schema 13 adds one append-only `factory_eval_attestations` row per run and assessment. Unique
run, assessment, statement, envelope, signed-artifact, and record digests prevent ambiguous lineage.
A database trigger binds indexed columns to the canonical JSON, run/assessment foreign keys, signed
subject, times, key ID, payload type, and exactly one signature. Update and delete triggers reject
mutation. A changed second artifact for one run conflicts; an exact retry returns the existing
verified record only while it remains within the configured validity window.

Key and config reads require canonical owner-only regular files with one link, stable metadata, and
bounded size. Key sources return fresh mutable bytes; signer and verifier erase loaded material and
temporary payload/signature buffers after each operation. Key rotation is additive: retain old
verification keys for retained records or migrate only through a separately reviewed multi-key trust
design. Never overwrite a key and pretend its existing key ID still applies.

On a signing or verification incident, stop promotion commands, disable scheduler and broker
switches, preserve the database/run/artifact/key-ID evidence, quarantine affected candidates, and
rotate the signing key. Do not edit attestation rows. Re-enable only after scope analysis, fresh
evaluation, a new signed artifact, independent review, and a later explicit authority decision.

## Deliberate exclusions

AgentLab still does not execute the eval harness, attest grader artifacts independently, protect a
private key in hardware, publish transparency-log entries, consume a cohort, or turn an attestation
into task/scheduler/broker/merge/release authority. The signer authenticates bytes and key custody;
it does not establish that an external harness was honest. Canary issuance still reads the
deterministic assessment only. Cohort consumption must be a later crash-durable change that requires
a currently valid verified attestation and aggregate reservation accounting.

## Fitness functions

Required tests cover strict schemas, canonical DSSE encoding, Ed25519-only keys, wrong-key and
key-ID rejection, payload/statement/signature substitution, exact run and assessment linkage,
freshness and expiry edges, caller-buffer erasure, owner-only/symlink/hard-link rejection,
append-only migration and identity triggers, idempotency/conflict behavior, runtime drain, CLI input
validation, exact public APIs, and disjoint transitive capability closures. Full type, lint, test,
architecture, build, package, and sandboxed runtime-smoke gates remain mandatory before handoff.
