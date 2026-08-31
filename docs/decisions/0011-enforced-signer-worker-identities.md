# ADR 0011: bind eval signing and scheduled work to distinct OS identities

**Status:** Accepted; implemented but not activated

**Date:** 2026-08-31

## Context

ADR 0009 separated signing from model execution in the source graph, but source separation alone did
not protect the private key. A worker and attestor launched under the same POSIX user can read each
other's owner-only files. The current systemd user scope provides cgroup resource isolation under
the invoking UID; it is not a user-identity or filesystem-security boundary. The operations runbooks
required separate accounts, but no executable contract proved that deployment fact.

## Decision

Introduce strict canonical `agentlab.role-identity-policy.v1`. It binds a versioned policy ID to:

- one non-root POSIX worker UID; and
- one different non-root eval-attestor UID, logical runner ID, and Ed25519 public-key digest.

Worker, attestor, and evaluator configurations each name an owner-only policy copy and pin its
canonical SHA-256 digest. Copies may live under different account-owned directories, but their
canonical content and digest must be identical. Unknown fields, root, shared UIDs, malformed key
IDs, symlinks, hard links, unstable reads, and group/world-readable files fail closed.

The key-bearing attestor recomputes the policy digest, matches its runner and key coordinates, and
proves its current POSIX UID before constructing the signing service. The private-key reader then
independently requires the key file to belong to that current UID. Failure occurs before key bytes
are opened.

Scheduled work requires `agentlab.local-factory-worker.v3`. Runtime construction recomputes the
policy digest and proves the worker UID before acquiring the SQLite writer lease. Host preflight
rechecks the UID and reports both the role-policy digest and a stable mismatch reason. Legacy v2
schedule files remain parseable for diagnosis but cannot construct or invoke model work. V3 may omit
a schedule policy for explicitly confirmed manual work; autonomous ticks additionally require the
loaded schedule policy. Each new crash-resumable schedule-run v2 persists the identity-policy digest
and refuses resume after drift; legacy run v1 remains readable but cannot resume model work. Legacy
recovery remains available without granting new execution.

Every signed eval predicate now includes `roleIdentityPolicyDigest`. The independent evaluator
recomputes its policy copy, matches the trusted runner/key coordinates, pins that exact digest in
both the verification service and immutable repository reads, and rejects a valid signature made
under any other policy. ADR 0012 carries the same digest into every new human cohort; a future
canary consumer must match it to its scheduled worker before granting brokered draft-PR authority.

## Consequences and remaining boundary

This closes the confirmed same-UID worker-to-signing-key path and makes the deployment assumption
auditable. It does not provision accounts, move files, install services, enable a scheduler, consume
a cohort, open a PR, merge, release, or touch an existing database.

It also does not complete separation for every control-plane role. Worker, evaluator, human
authority, and broker compositions still coordinate through direct sequential access to one local
SQLite ledger. A durable multi-account deployment therefore needs a narrow local control-plane
service or another explicitly reviewed brokered storage boundary; sharing one UID or broadly
granting raw database write access is not an acceptable substitute. Hardware-backed signing and an
external harness trust root remain optional stronger deployments.

## Fitness functions

Tests require strict policy parsing and canonical hashing; distinct non-root UIDs; owner-only stable
policy files; digest, runner, and key matching; refusal under the wrong worker or signer UID before
persistence/key access; signed-predicate binding; verifier and repository re-verification;
legacy-scheduler denial; deterministic preflight output; and unchanged capability-closure rules.
Type, lint, architecture, test, build, package, and isolated runtime-smoke gates remain mandatory.
