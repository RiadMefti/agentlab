# ADR 0005: make local runtime transitions durable and ownership-exact

**Status:** Accepted

## Context

AgentLab coordinates two durable local stores with different transaction models:

- SQLite owns project metadata and the authoritative captain identity.
- tmux owns captain and worker processes, panes, and terminal history.

The current happy path is reliable, but a process exit or adapter failure between the two stores can
leave contradictory state. In particular, creation can start a captain before its row exists,
deletion can kill a captain before its row is removed, and a failed deletion can later admit a new
worker. A structurally valid tmux name is also not sufficient proof that a session is the persisted
captain or that the current operation created it.

The product is a single-process application per invocation. Multiple invocations against one
database are not a supported coordination mode, so that constraint must be enforced rather than left
implicit.

## Decision

Keep SQLite as metadata owner and tmux as session owner. Add the smallest durable lifecycle protocol
needed to coordinate them; do not introduce a generic saga engine, event store, or provider-session
abstraction.

### Persisted project states

Every row has one explicit state:

```text
creating ─────────▶ active ─────────▶ deleting ─────────▶ removed
    │                                    ▲
    └──────── cleanup ─────────▶ removed │
                                         │
legacy-unlinked ─────────────────────────┘
```

- `creating`: the row reserves the project ID, canonical folder, captain name, and an unpredictable
  ownership nonce before tmux side effects begin. It is not attachable through AgentLab and admits
  no application commands. The captain can nevertheless invoke tmux directly in this crash window,
  so every worker-creation path—captain policy and AgentLab's explicit worker command—must carry the
  same ownership nonce.
- `active`: the only state that admits normal queries, attachment, or worker creation.
- `deleting`: written before the captain or any worker is stopped. It is retryable and admits no
  worker or attachment work.
- `legacy-unlinked`: an explicit compatibility state for historical rows whose folder is null. It
  may only be removed; it is never treated as an active project.
- `removed`: absence of the row, not another stored value.

State changes use short SQLite compare-and-set transactions. No SQLite transaction remains open
while filesystem, provider, tmux, or PTY work is awaited.

The forward-only migration maps every existing row with a non-null workspace to `active` and every
existing null-workspace row to `legacy-unlinked`, preserving every existing field. It also persists
one explicit ownership mode:

- `nonce`: required for every newly created row; the ownership nonce is non-null and is stamped on
  its captain and every later worker;
- `legacy-name`: assigned only by migration to pre-nonce rows; the nonce stays null, exact managed
  identity remains the compatibility authority, and the mode is retained through `deleting`.

A migrated `legacy-name` active row continues to admit worker creation in legacy-name mode because
its already-running captain cannot safely receive a new environment or policy. Both the captain and
AgentLab's explicit worker command therefore preserve the prior exact-identity behavior for that
row. There is no in-place ownership upgrade: removing and recreating the project creates a `nonce`
row. New rows can never enter `legacy-name`. Pending states and ownership modes remain repository
records, not new public conversation DTO variants.

The command matrix is explicit:

| Operation                                             | Admitted state                             |
| ----------------------------------------------------- | ------------------------------------------ |
| Normal project listing                                | `active`, plus removable `legacy-unlinked` |
| Provider/session queries, attachment, worker creation | `active` only                              |
| Delete                                                | `active`, `deleting`, or `legacy-unlinked` |
| Startup reconciliation                                | `creating` or `deleting`                   |

Normal listing never presents `creating` or `deleting` as healthy projects. A failed pending
transition remains named in an actionable startup diagnostic and is retried on the next launch.

Within an admitted `active` project, ownership mode authorizes every session-consuming operation:

- `nonce` rows list or attach only the exact persisted captain and parsed workers whose session
  nonce matches. A missing/mismatched session is filtered from normal listing and rejected by direct
  attachment; it never becomes authoritative through its name alone.
- Explicit single-worker deletion revalidates exact parsed identity and the matching nonce
  immediately before stop. A missing/mismatched worker is rejected and never stopped.
- `legacy-name` rows preserve these operations using exact managed identity only; this compatibility
  authority is never available to `nonce` rows.

### Creation

1. Validate the command, canonicalize the folder, resolve provider capabilities, and construct the
   exact captain command.
2. Insert a `creating` row, reserving the canonical folder and captain identity.
3. Create that exact captain session with the persisted nonce attached atomically by tmux, then
   fully configure it. For this new `nonce` row, both captain policy and the application
   worker-creation use case require every worker-shaped session to attach that same nonce atomically
   in its `new-session` operation.
4. Compare-and-set the row from `creating` to `active` and return only the active record.
5. On an ordinary failure, inspect the exact captain plus every parsed worker identity for the
   conversation and compensate only sessions whose nonce proves this invocation owns them. Remove
   the reservation only after the entire owned set is confirmed absent. An ambiguous `new-session`,
   listing, ownership, or stop result is not proof: retain `creating`. A missing or mismatched nonce
   is an unowned conflict that is never killed and also retains `creating`. The row and nonce remain
   as the recovery journal whenever compensation cannot finish.

### Deletion

1. Serialize the conversation locally and compare-and-set `active` or `legacy-unlinked` to
   `deleting`. A row already in `deleting` resumes idempotently. Public deletion never admits a
   `creating` row; only nonce-aware creation compensation or startup reconciliation may resolve it.
2. Stop the exact persisted captain first. For every `nonce` row, exact name plus matching nonce is
   required for the captain and every parsed worker. Exact-name-only cleanup is permitted solely for
   an explicit `legacy-name` row, whether `active` or `legacy-unlinked`; that compatibility mode is
   retained when it becomes `deleting`.
3. List and stop worker-shaped identities owned by that conversation. A worker-shaped session with a
   missing or mismatched nonce is not destroyed and keeps the row `deleting` for explicit recovery.
   Any additional captain-shaped session is an unowned conflict: it is never visible, attachable, or
   killed automatically, and it does not block removal of the exact journaled captain and workers.
4. After the captain is confirmed stopped and the first worker cleanup finishes, enumerate the raw
   conversation worker set again. Within a finite cleanup budget, stop any late nonce-authorized
   worker and repeat until one complete post-captain inventory proves the set absent. Budget
   exhaustion, a nonce conflict, or an ambiguous listing retains `deleting`; the row is removed only
   after the final inventory is unambiguously empty. Any failure rejects later work and leaves
   removal retryable.

### Startup reconciliation

Command admission remains closed while startup inspects only pending rows in the current database.
For each `creating` row, reconciliation inspects the exact captain and every parsed worker identity
for that conversation, then follows an exhaustive ownership decision:

- if the entire managed-session set is confirmed absent, remove the reservation;
- stop every session in that set whose ownership nonce matches, then remove the reservation only
  after confirming the entire set is absent;
- if any exact captain or worker-shaped session has an absent or mismatched nonce, never stop that
  session, retain the reservation, and fail startup cleanly;
- if creation, listing, ownership inspection, or cleanup has an ambiguous result, retain the
  reservation and fail startup unless later inspection proves complete absence or nonce-authorized
  cleanup succeeds.

For the other states, reconciliation will:

- resume an exact `deleting` cleanup;
- leave `active` and `legacy-unlinked` rows unchanged.

Recovery never scans or kills arbitrary `agentlab__*` sessions merely because their names match a
prefix. A missing or mismatched creation nonce is retained as a non-active conflict and is never
killed automatically. If any pending row cannot reconcile, startup fails cleanly before public work,
names the pending row and required recovery action without disclosing the nonce, and retains it for
the next retry.

### Exact authority and compensation

- The one visible and attachable captain is exactly `conversation.captainSessionName`.
- Other valid captain-shaped names are not authoritative. Visible non-captain sessions must parse as
  workers owned by the same conversation.
- For a `nonce` row, exact identity is necessary but insufficient for listing, attachment, single
  worker deletion, conversation deletion, or recovery; each operation also proves the matching
  session nonce at its last destructive or attachment boundary.
- tmux creation is atomic with respect to duplicate names. `new-session` attaches the unpredictable
  nonce in the same command; the adapter records `createdHere` only after that command succeeds. For
  `nonce` rows, captain policy and the application worker-creation path attach the same nonce in the
  atomic `new-session` command for every worker. `legacy-name` rows preserve exact-identity creation
  and cleanup without inventing a token for their already-running captain. Same-invocation captain
  compensation requires `createdHere`; compensation and restart recovery of every `nonce` session
  also require exact identity plus the matching persisted nonce.
- `new-session -P -F` returns the created session ID plus tmux server PID/start generation in the
  same command that stamps ownership. Invalid or missing identity output is ambiguous and retains
  `creating`; it never triggers name-based compensation.
- After exact-name resolution, tmux configuration, nonce proof, destructive cleanup, retained
  history, and live PTY attachment carry the session ID, server generation, and ownership proof.
  Each final action evaluates the exact session name, those values, and the nonce inside one
  tmux-side guard. A concurrent rename or name replacement, or a restarted server reusing a low
  session ID, is never configured, killed, read, or attached through a stale target.

### Single writer

Derive one lease identity from the canonical application-database target, independent of relative,
absolute, or symlink spelling. Existing hard-linked database targets and SQLite URI targets are
rejected because they cannot provide one unambiguous sidecar identity. Validate tmux 3.2+ first;
that is the minimum version supporting the atomic `new-session -e` ownership stamp. Then acquire the
lease before application-database migrations or mutation, reconciliation, managed-session side
effects, or PTY creation.

The lease uses a separate local SQLite lock file and one dedicated connection whose exclusive write
transaction remains open for the runtime lifetime. Contention has a bounded timeout and fails before
application side effects. A crash releases the kernel lock without stale-PID recovery; no
transaction is held on the application database. Release happens only after every admitted operation
settles or is truly cancelled, terminals close, and the repository connection closes. `:memory:`
test runtimes remain isolated and do not share a lease.

A second invocation against the same database fails before it can mutate SQLite or tmux and reports
an actionable local error. Supporting concurrent writers would require explicit cross-process CAS
semantics and is outside this decision.

### Task ownership, deadlines, and shutdown

- Stop command admission before shutdown and retain ownership of initialization, reconciliation,
  queries, provider discovery, terminal opening, and mutations until each settles or its adapter
  confirms real cancellation and cleanup.
- Do not mistake a response timeout for cancellation. An outer timeout is permitted only when the
  underlying adapter owns cancellation and cleanup; otherwise the operation remains tracked until it
  settles.
- Filesystem calls without a cancellation API remain registered with the runtime after a bounded UI
  response expires; shutdown drains them instead of treating the response deadline as cancellation.
- Every spawned command tree, Codex app-server, Claude SDK query, and Bun PTY is registered
  immediately with one runtime resource owner. Claude uses the SDK's supported process-spawn hook to
  register the actual CLI process tree; SDK `return()` is only protocol cleanup and is never treated
  as exit proof. Successful adapter cleanup releases a resource only after positive process/handle
  closure; failed, timed-out, or ambiguous cleanup leaves it registered for shutdown and later
  `close()` retry.
- Provider/process adapters retain finite output, attempt, response, and cleanup budgets. The total
  provider-catalog deadline covers locator work, version probes, live model discovery, and the
  adapter's bounded cleanup facade. A response may fall back at that deadline only because any real
  process/query remains independently owned; it must not leave an unowned candidate loop or child.
- Cancellation is complete only after child process trees, SDK queries, PTY handles, and streams
  close and late callbacks can no longer mutate state. A facade timeout is never evidence of that
  fact.
- PTY detachment is complete only after the tmux client process exits and the raw terminal handle
  closes. Signalling, a thrown kill/close, a listener exception, or a bounded-exit failure remains
  retryable and retains the writer lease. Pre-listener output overflow discards the complete stream
  and closes the ephemeral client without replaying a partial escape sequence.
- Shutdown owns one eventual finalizer. A caller may stop waiting at its own deadline, but that does
  not cancel or poison cleanup. After every admitted operation has settled or confirmed
  cancellation, each independent cleanup phase is attempted even if an earlier phase fails: terminal
  clients, then repository. Writer-lease release is conditional: it occurs only after every terminal
  and the repository are confirmed closed. A failed or ambiguous prerequisite keeps the lease held
  and remains retryable. Concurrent calls and calls after successful cleanup observe the same
  result; a rejected finalizer is not permanently memoized, and a later `close()` retries unfinished
  phases before releasing the lease. The resource owner bounds concurrent cleanup and retains every
  failed member instead of dropping ownership when it reports an aggregate failure.
- Caches have explicit entry limits, preserve both facade and uncancellable underlying in-flight
  ownership, and evict deterministically.
- Session inventory is one ownership-bearing tmux snapshot, capped at 128 entries per conversation;
  destructive cleanup starts no more than eight tmux processes at once and requires a coherent empty
  final snapshot before removing a lifecycle journal.

### Safe captain inputs

Captain instructions are policy, not a security boundary. Instruction text never contains raw
workspace or executable values. It references only fixed environment-variable names with quoted
expansions such as `"$AGENTLAB_WORKSPACE"`. The tmux boundary passes every value as one argument or
environment value through the existing tested POSIX quoting function; no later layer reconstructs a
shell string from it. For `nonce` rows, the policy also uses a fixed quoted ownership-variable name
when creating workers, so their `new-session` command stamps the conversation nonce atomically
without embedding its value in instruction text. Migrated `legacy-name` captains retain their
existing policy and behavior. Application lifecycle code depends on a captain-policy port rather
than embedding tmux syntax or provider-name switches.

## Architectural boundaries

- Contracts contain validated serializable data, not tmux or OpenTUI buffer policy.
- Domain/application code contains no React, tmux, SQLite, provider SDK, filesystem/process,
  randomness, or clock implementation.
- Composition injects the ID generator, clock, captain-policy renderer, repository, session runtime,
  provider catalog, filesystem services, PTY, and writer lease.
- Supported providers remain a deliberately closed compile-time set. Provider neutrality means
  native provider adapters behind stable ports, not a dynamic plugin system or a common provider
  conversation protocol.
- The public `@agentlab/runtime` surface and current happy-path UX remain compatible.

Compatibility surfaces are the `@agentlab/runtime` export map, names, and signatures; append-only
SQLite migration history; managed-session grammar; persisted provider IDs; documented `AGENTLAB_*`
variables; launcher/native CLI behavior and exit semantics; and release-manifest/cache formats. No
implementation step removes or renames a public export or changes happy-path behavior without a
separate compatibility decision and migration.

This work also preserves the required aggregate CI check identity, native release targets and asset
names, annotated-tag-on-main validation, checksums, SBOM/provenance attestations, immutable GitHub
publication, OIDC trusted npm publishing, byte-for-byte npm candidate comparison, and recovery
verification. Any release-control change requires separate review.

## Verification requirements

Acceptance requires focused tests for every transition and failure boundary:

- crash/restart fixtures for `creating` and `deleting` rows;
- creation failure after `new-session` but before activation, including matching and mismatched
  ownership nonces;
- all `creating` recovery branches: absent session, matching nonce, absent nonce, mismatched nonce,
  and ambiguous tmux results;
- a captain spawning one or more workers before activation, including full nonce-authorized cleanup
  and fail-closed missing/mismatched/ambiguous worker cases;
- atomic ownership stamping for both captain-created and application-created workers on `nonce`
  rows, followed by successful ownership-authorized deletion of each;
- migrated `legacy-name` active rows preserving captain-created and application-created worker
  behavior plus exact-identity cleanup, without an unsafe in-place ownership upgrade;
- repository and tmux failure injection after each durable phase;
- queued worker rejection after deletion starts or fails;
- extra-captain filtering and attach rejection;
- proof that unowned additional captains are never destroyed;
- nonce-conflicting captain/worker filtering, attachment rejection, and single-worker deletion
  rejection, while `legacy-name` rows retain only their explicit exact-identity behavior;
- a worker appearing during conversation cleanup, with post-captain re-enumeration proving it is
  cleaned only when authorized and that conflict or ambiguous final inventory retains `deleting`;
- proof that deletion cannot convert a nonce conflict into authority to destroy an unowned captain,
  while migrated pre-nonce active and legacy-unlinked rows retain the explicit exact-name
  compatibility path;
- duplicate-session races proving foreign sessions are not compensated;
- atomic created-ID capture plus tmux-server restart/ID-reuse guards for configuration, kill,
  history, and PTY attachment;
- committed activation-response ambiguity, legal repository transition enforcement, saved-folder
  canonical drift, and repository-close failure during composition;
- canonical, relative, and symlink-alias lease contention; bounded contention; process-crash
  release; hard-link/URI rejection; and `:memory:` isolation;
- late provider work, real cancellation, repeated close, eventual cleanup after a caller stops
  waiting, cleanup continuation after an earlier phase fails, and successful retry after rejection;
- proof that terminal or repository close failure retains the writer lease until every prerequisite
  is confirmed closed on a later successful retry;
- exact history targeting and adversarial path/executable values in captain policy;
- bounded command output during ignored-TERM cleanup and bounded caller response while owned
  uncancellable provider filesystem work drains;
- total provider discovery deadlines plus retained/retryable command-tree, Codex app-server, Claude
  SDK query/actual child, and Bun PTY cleanup after injected failure, timeout, early SDK-facade
  resolution, or listener exception;
- migration of every historical schema supported by this release.

The full formatting, architecture, type, lint, unit/component, real tmux/PTY integration, build,
packaging, dependency-audit, and release checks remain mandatory.

## Consequences

- Interrupted work becomes explicit, retryable, and locally auditable instead of appearing active.
- Creation now reserves metadata before launching a captain; deletion records intent before stopping
  sessions. This intentionally changes faulty/interrupted behavior while preserving the happy path.
- One small schema migration and startup reconciler are required.
- Shutdown may wait longer for an admitted mutation rather than close resources underneath it.
- AgentLab still has no network listener, remote mode, transcript store, credential store, event
  sourcing system, generic provider protocol, or background daemon.

## Implementation order

1. Make ADR 0004's dependency fitness function and Bun-test discovery exhaustive; add public-API,
   protocol, and lifecycle characterization tests.
2. Append the lifecycle/nonce migration and implement repository compare-and-set operations.
3. Implement ownership-stamped tmux creation, exact captain/worker filtering, and non-destructive
   duplicate/extra-captain handling.
4. Acquire the canonical writer lease, then add fail-closed startup reconciliation.
5. Extract runtime/terminal coordination from the composition root and make all-operation shutdown
   eventually finalizing.
6. In separately tested changes, remove orphaned provider timeouts, bound caches, canonicalize every
   process workspace, validate process configuration, inject platform choices, and move policy
   constants to their owners.
7. Consolidate provider metadata and render safe captain policy through fixed environment variables.
8. Run the full release gate without changing or weakening its existing provenance, identity, or
   immutability controls.
