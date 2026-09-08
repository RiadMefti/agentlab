# ADR 0034: Single-owner factory ledger boundary

Status: proposed; implementation and architectural approval pending

## Evidence and problem

The factory's daily services run under distinct POSIX UIDs but consume one SQLite ledger, writer
lease, and content-addressed artifact store. Their real adapters cannot implement that handoff:

- `sqlite-database.ts` calls `chmodSync(path, 0o600)` on every writable open.
- `sqlite-writer-lease.ts` opens the common lock database and calls `chmodSync(lockPath, 0o600)`.
- `file-factory-artifact-store.ts` calls `chmod(..., 0o700)` while preparing roots and shards, even
  for reads, and publishes files as `0600`.

On 2026-09-07, `npm run test:factory-role-isolation` exercised these built adapters in a Linux user
namespace with distinct mapped UIDs 1 and 2 sharing GID 1. UID 1 successfully created and closed the
ledger, lease, and an artifact. UID 2 could not reopen the database or lease (`ERR_SQLITE_ERROR`)
and could not read the artifact (`EPERM` during chmod). After broadening only disposable
database/lease modes to group-writable `0660`, the second role still failed the ownership-only
chmod. The test cleans up its fixture and does not create host accounts, edit real storage, change
authority, or contact GitHub.

This is a deployment failure, not merely missing provisioning. Giving every role direct writable
storage would additionally let that role replace authoritative state; append-only application
methods and content hashes alone do not prevent the file owner from rewriting the underlying files.
The interactive single-user runtime's private storage behavior is valid and must be preserved.

The reproduction proves denial of direct storage access. It does not prove a working service,
authenticated IPC, remote governance, model isolation, or the complete software-factory loop.

## Proposed decision

One dedicated local ledger service owns the factory database, lease, and artifact directories. No
model worker, review publisher, PR broker, merger, or attestor gets direct write access to those
files. The interactive product remains local-first and provider-neutral; domain rules remain
independent of process and transport adapters. The service is a new lifetime/authority boundary, not
an implicit amendment to the current short-lived-composition architecture.

Use a local Unix-domain transport with kernel-authenticated peer credentials, bounded messages,
strict schemas, deadlines, and an explicit UID-to-operation policy. Caller-supplied role names,
actor strings, digests, or assertions are not authentication. Do not expose SQL, arbitrary file
paths, arbitrary method invocation, shell commands, or an Internet-facing endpoint.

Expose reviewed use-case operations: claim an eligible attempt, retrieve its immutable inputs,
submit bounded proposal/evidence claims, request deterministic gate evaluation, claim an already
authorized broker action, and reconcile its result. Every mutating request binds the exact task,
contract, attempt, policy, expected state version, and an idempotency key. The ledger service alone
performs state transitions, reservations, authority issuance, and audit commits.

Worker-origin results remain untrusted claims. A worker UID cannot assert successful gates, mint
reviewer or broker identities, enable switches, or authorize its own publication. Trusted gate,
attestation, broker, and operator evidence needs distinct authenticated authority and exact digest
binding. Peer UID authentication is necessary but insufficient where multiple trust levels share an
OS account; the implementation must separate those principals rather than trust a role string.

GitHub keys remain in the dedicated broker/merger processes, never in the ledger or worker. Provider
execution remains in isolated model workers. Required evidence is copied through bounded,
digest-verified transfers; clients cannot select storage paths. The ledger reserves authority and
records intent before remote effects, and uncertain results reconcile without blind mutation retry.
No transport outage may fall back to direct SQLite access, relaxed permissions, or shared
credentials.

## Implementation sequence

1. Specify the typed role operations and threat/authority boundaries; implement local peer
   authentication, bounded framing, authorization, and single-owner persistence lifetime.
2. Move task state, switches, quota/canary reservations, and evidence acceptance behind that
   service. Preserve existing immutable contracts and journals; define a backed-up migration.
3. Migrate the worker-to-qualified-proposal-to-draft-broker loop first. Keep remote authority off
   until a real cross-UID integration proves both successful handoff and forbidden operations.
4. Migrate scheduled repair, review/attestation, incident, and merge consumers. Only then join the
   existing external-PR stages to the daily chain and supply a separately authorized object mirror.
5. Remove direct database/artifact imports from role clients and enforce that boundary in the source
   graph. Provision reviewed live identities, cost caps, canary evidence, and GitHub Apps, then run
   the exact-head brokered-PR pilot. Merge/release remain separately gated.

## Acceptance before activation

- Distinct real UIDs complete request → immutable task → isolated implementation → strict gates →
  independent review → exact-head draft PR; the leaf roles cannot open the underlying stores.
- Worker attempts to enable switches, forge trusted evidence, exceed quotas, submit a stale head,
  call another role's operation, or replay an expired grant are rejected without state advancement.
- Oversized/malformed messages, path traversal, unknown fields, wrong peer identity, and connection
  exhaustion are bounded and fail closed. No test substitutes a claimed UID for a kernel identity.
- Service and client crashes before/after each commit and remote intent recover without duplicate
  mutation, quota release under uncertainty, or loss of canonical evidence.
- Ordinary private storage tests remain green. A separate positive cross-role handoff test proves
  the new boundary; the negative direct-access proof cannot substitute for it.
- Required local/hosted checks, a real bounded canary, incident disablement, ledger backup/restore,
  and the brokered-PR observation record pass on the exact deployable binary and policies.

This proposal does not transfer repository ownership, install a daemon, change permissions on live
state, provision credentials, spend a model budget, or enable factory authority. Approval of this
architecture is distinct from confirming that its future implementation satisfies these checks.
