# ADR 0034: Single-owner factory ledger boundary

Status: accepted on 2026-09-07; implementation in progress, activation not approved by test results

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

That reproduction proves denial of direct storage access. The separate positive IPC proofs described
below do not yet prove remote governance, model isolation, or the complete factory loop.

## Decision

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

## Implemented boundaries and limits

`@agentlab/runtime/factory-ledger` exclusively owns its SQLite database and writer lease. Config v1
serves only `authority.read` and exact-contract `task.read`. Its public client has no direct
persistence or generic RPC fallback. An expiring content-addressed read policy assigns distinct
non-root UIDs and task/contract pairs. Caller-supplied identities, extra fields, mutations, stale
policy digests, and unassigned tasks fail closed. These read grants confer no execution, review, or
publication authority.

Config v2 additionally accepts an explicit, expiring, content-addressed authority policy. A grant
must match a distinct `operator` UID and identity in the peer policy; workers and brokers cannot
receive it. Per-control grants can be disable-only. The separate storage-free
`@agentlab/runtime/factory-ledger-operator` entry exposes `authority.inspect`, `authority.change`,
and `authority.receipt`; the read client does not acquire mutation methods.

An authority command binds both reviewed policy digests, its kernel-authenticated principal,
control, expected boolean **and last event digest**, requested opposite state, exact confirmation,
reason, idempotency key, and a deadline at most 120 seconds away. These are global switch commands,
so the control event digest replaces task/attempt coordinates. The service derives the human actor;
no actor or role can be supplied in a command. Existing execution, canary, evidence, quota, and
broker gates remain mandatory after a switch changes.

Schema 32 adds append-only authority receipts without enabling any control. One `BEGIN IMMEDIATE`
transaction records either a stable CAS conflict or both the ordinary control event and canonical
receipt. Retries with identical intent return the original receipt, even after another command has
disabled the switch; reusing a key for different bytes is denied. The event digest prevents a stale
off-state command from bypassing a later on/off cycle. Expired commands cannot execute, but a
currently authorized operator can retrieve their receipt by key and exact intent digest without
repeating a mutation. A receipt describes the original result, not necessarily today's state.

Migration/recovery procedure: stop the ledger owner, make and integrity-check a consistent SQLite
backup, then start the new owner on its dedicated factory database. The migration preserves all
existing control/task records. Rolling back to a schema-31 binary requires restoring that backup,
not lowering `user_version` or dropping evidence. Existing single-user authority compositions have
not been removed; they are not a fallback for cross-UID service clients.

Config v3 adds a pre-provisioned canonical owner-only artifact root and an expiring artifact policy.
The storage-free `factory-ledger-artifacts` client exposes only submit/read/receipt. Separate UID
grants distinguish implementer, reviewer, gate-observer, and reader. A submission binds the exact
task contract and event head, initial-execution or PR-repair run and active operation, attempt,
server-derived producer identity, both policy digests, content digest/size/media type, idempotency
key, and a deadline no more than 120 seconds away. The active operation must match the producer's
grant. These bytes remain untrusted claims: no task, evidence bundle, gate, review, or switch is
advanced by uploading them.

Schema 33 adds immutable quota reservations. One immediate transaction rechecks the task and
operation heads and reserves cumulative task/global byte and object quotas before any file write.
The task byte allowance also respects its immutable output budget. Interrupted reservations remain
charged; no client can release them. Repeated identical intent keeps its reservation, and receipt
queries can reconcile an expired command without repeating the upload. `stored` reflects verified
content availability, not evidence approval. File data and publication directories are synchronized
before acknowledging delivery. Corruption fails closed; a reserved but absent file is an ordinary
incomplete delivery. The stopped ledger and artifact directory must be backed up together; rollback
to a pre-schema-33 binary requires a compatible backup.

Whole objects are bounded at 8 MiB and transferred in canonical base64 inside the bounded frame;
config validation requires enough frame capacity. Current grants support reads of upload
reservations and direct artifact references in existing canonical evidence for the assigned task.
Neither knowing a digest nor supplying a path grants access. Nested patch-content references and
remote job/result integration still need explicit association through the future workflow boundary.

The Linux-only transport uses a digest-pinned Python interpreter with fixed `-I -S -u -c` arguments,
an empty environment, and a static standard-library helper. It obtains peer identities using
[`SO_PEERCRED`](https://man7.org/linux/man-pages/man7/unix.7.html), authenticates both ends before
request disclosure, and bounds framing, output, backlog, and absolute per-connection deadlines.
Python's [socket API](https://docs.python.org/3/library/socket.html) supplies the supported
peer-credential interface; [isolated startup options](https://docs.python.org/3/using/cmdline.html)
prevent environment, user-site, and site initialization from injecting helper code. This is an
explicit optional factory host prerequisite, not a Python dependency of the interactive product. The
interpreter's standard library and its containing filesystem remain trusted host inputs; a binary
digest alone does not attest the whole interpreter installation.

Only the service owner can write the socket parent. Socket mode `0666` permits connection, not
operation authority: the kernel UID allowlist applies before reading a body, and the application
checks the current policy and exact task grant. Provisioning must keep all ancestor directories and
interpreter files outside client control; checking the immediate parents is not a substitute for
that host trust boundary. Existing socket paths are refused, never blindly unlinked. Abnormal-death
stale-socket recovery remains an explicit operator task until a verified recovery protocol exists.

The positive integration runs the actual built service under mapped UID 1 and public clients under
UIDs 2 and 3. Both read their assigned task without opening the database or lease; UID 4 is
rejected, and forged privileged operations and valid operator commands from leaf roles fail. UID 5
alone changes a disposable switch, reconciles its receipt, disables it, and proves a late replay
cannot re-enable it. Unit tests inject receipt-write failure to prove event rollback, verify
reopen/reconciliation and immutable receipt checks, and deny stale pins, expired grants, wrong
identities, and disable-only escalation. Ordinary transport tests cover wrong server identity,
malformed/oversized frames, slow clients, late replies, clean restart, and bounded shutdown. Both
positive and negative cross-UID proofs run through `test:factory-role-isolation`, now required by
the hosted `factory-sandbox` job. Architecture fitness rules exclude providers, GitHub, and
arbitrary command execution from the ledger owner and exclude persistence from clients. The same
positive test proves UID 2 upload/replay/reconciliation and UID 3 byte reads while both lack direct
artifact access; broker and unknown UID uploads are denied. Artifact tests also cover schema-32
migration, task/global quotas, producer mismatch, digest/size/base64 failures, disk-write failure,
lost replies, reopen/reconciliation, missing objects, and immutable storage/tamper checks.

This implementation does **not** expose task mutations, run workers through the service, install a
daemon, recover remote intents, or repair the existing daily chain. Those remain activation
blockers. Successful IPC tests must not be reported as a brokered-PR canary.

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

This decision does not transfer repository ownership, install a daemon, change permissions on live
state, provision credentials, spend a model budget, or enable factory authority. Approval of this
architecture is distinct from confirming that its future implementation satisfies these checks.
