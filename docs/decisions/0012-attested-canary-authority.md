# ADR 0012: require verified eval attestations for canary authority

**Status:** Accepted; implemented but not activated

**Date:** 2026-08-31

## Context

ADR 0007 made human canary issuance separate, bounded, non-merging, and non-releasing. ADR 0009
later added signed eval attestations, and ADR 0011 bound those signatures to distinct worker and
attestor identities. The canary-authority composition still selected a passing assessment directly,
so a cohort could be issued before an attestation existed. Its immutable record also could not prove
which signature or deployment identity the human approved.

## Decision

New canary issuance requires an exact `attestationDigest`, never a bare assessment digest. Canary
config v2 pins the trusted Ed25519 public key, runner, timing policy, role-identity policy, and
every reviewed digest. The human-only composition re-verifies the stored DSSE signature, canonical
run and assessment lineage, signer/worker role-policy digest, and current validity window before
issuing authority.

`agentlab.canary-approval.v2` and `agentlab.canary-cohort.v2` both bind the attestation and
role-identity-policy digests. Cohort expiry cannot exceed attestation expiry. Schema 14 adds
nullable relational columns for those pins, guarded v2 foreign-key and JSON projections, partial
unique indexes, and immutable triggers. Historical v1 approvals and cohorts remain readable with
null attestation coordinates, but config v1 cannot issue new authority and a v1 cohort is never
eligible for a future autonomous consumer.

The canary-authority executable can read only the evaluation, attestation, and canary ledgers plus
an owner-only public key and policy copy. It has no private key, model/provider, worktree, process,
GitHub, broker-control, merge, release, or deployment capability.

## Consequences

A passing assessment alone is no longer promotion authority, and a signer key cannot authorize a
different worker/signer deployment. Issuance is still only a dormant, non-executing human decision.
This change does not implement an eval harness, cohort consumer, account provisioning, shared-ledger
broker, automatic PR creation, merge, release, deployment, telemetry, rollback, or incident paging.

A future consumer must re-verify the v2 cohort, attestation validity, exact role-policy digest,
candidate configuration, repository, task/risk limits, and aggregate usage at every reservation. It
must treat v1 cohorts as audit history only.

## Fitness functions

Tests cover strict v1/v2 parsing, missing or substituted attestations, policy-digest substitution,
expiry, idempotent re-verification, legacy read compatibility, schema-14 relational projection,
owner-only config loading, trust-coordinate checks before database access, exact CLI inputs, source
capability closure, full type/lint/test/build/package verification, and isolated runtime smokes.
