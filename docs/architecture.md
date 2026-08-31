# Architecture

This document is the normative product architecture. Durable changes require an ADR, updated fitness
functions, and focused compatibility/failure tests in the same change. Directory names and prose
never substitute for executable boundaries.

## Product boundary

The UI presents each saved conversation as a project: a user-defined name plus one canonical local
folder. Every project owns exactly one captain. The captain may create zero or more independent
workers, and the user may enter any exact session directly.

```text
project / conversation
└── captain (exactly one, pinned)
    ├── worker
    ├── worker
    └── ...
```

The interactive product is local-only and single-process. Optional factory operations use three
separate, short-lived local compositions: a credentialless model-bearing worker, a human-only local
authority operator, and a credential-bearing draft-PR broker. Only the broker may make explicit
GitHub API calls; none is loaded into the interactive runtime. AgentLab has no HTTP server,
WebSocket gateway, browser renderer, desktop shell, remote mode, app command language, MCP bridge,
or provider-session translation layer.

## Two paths

```text
Agent orchestration
captain ── raw tmux/provider CLI commands ──▶ workers

User observation and interaction
OpenTUI terminal ◀── one Bun PTY ──▶ selected exact tmux session

Explicit user lifecycle
OpenTUI actions ── validated application commands ──▶ provider launcher + tmux
```

The observation path never carries captain-to-worker instructions. The explicit lifecycle path lets
the user add a project folder, start a worker with an initial task, or remove managed state; it does
not mediate later agent communication.

## Software-factory safety kernel

[ADR 0006](decisions/0006-local-software-factory-control-plane.md) accepts an additive local-first
software-factory control plane. A factory task belongs to one existing conversation, its agent
attempts remain workers beneath that conversation's single captain, and provider-specific execution
stays behind ports. Deterministic code—not captain instructions—owns task state, capabilities,
budgets, gates, evidence, and remote authority.

The source tree now contains the dormant stages 1–4 safety path: strict contracts; an immutable
SQLite task/evidence ledger; deterministic risk policy and kill switches; content-addressed
artifacts; exact-base disposable worktrees; bounded provider-native implement, repair, and
independent-review adapters; sandboxed deterministic gates; authenticated evidence channels; and a
separate GitHub adapter that can reconstruct one exact patch and request only a draft PR after
rechecking repository governance. Factory policy 1.3 conservatively classifies the complete allowed
write scope before execution, binds preparation evidence to the compiled contract, and pins per-tier
process-tree limits. Every agent or gate executor requires an injected OS isolator; the Linux
adapter creates a unique transient systemd user scope with cgroup CPU, memory, swap, and task
ceilings and has no unbounded fallback. The wrapper strips its user-manager environment before
starting the target. Deterministic gates run Bubblewrap inside that scope. The model-bearing
subprocess environment is allowlisted and excludes repository, cloud, and package credentials. The
broker credential is acquired only at the separate broker boundary.

That broker boundary has a fixed-purpose GitHub App adapter. It issues a bounded RS256 App JWT and
requests an installation token for one configured numeric repository ID with only `contents:write`
and `pull_requests:write`. The response must name that exact selected repository, must not widen the
permission map, and must expire within the bounded installation-token window. Tokens coalesce in
memory, refresh before expiry, and are invalidated on authentication or push failure. Neither the
App key nor installation token crosses into a model-bearing process. The exact
`@agentlab/runtime/factory-broker` package subpath is the only public composition entry for this
authority plane; the interactive `@agentlab/runtime` entry does not re-export it. Its strict
owner-only configuration points to a canonical owner-only App-key file and pins the trusted GitHub
App ID for each required `verify` and `factory-sandbox` context. Config v1 remains compatible and
cost-blocked. Config v2 additionally points to a separate canonical owner-only cost-policy file so
future broker and worker processes can load the same rate card without sharing credentials. The
loader strictly parses `agentlab.cost-policy.v1` before runtime construction. A matching check name
from another App does not count. Config, cost policy, and key reject symlinks, hard links, non-owner
permissions, unstable metadata, non-canonical paths, and oversized input. Each key read returns
fresh mutable bytes that the signer erases after one signature.

Human enablement is a fourth exact runtime package entry, `@agentlab/runtime/factory-authority`. Its
strict owner-only `agentlab.local-factory-authority.v1` config contains only a durable database path
and a pinned operator identifier. The composition can inspect both switches and atomically
compare-and-set only `pr-broker`, recording a canonical append-only human control event. It exposes
no scheduler mutation, task execution, process runner, provider, GitHub, tmux, terminal, broker, or
interactive runtime capability. SQLite's single-writer lease and `BEGIN IMMEDIATE` make the
expected-state check and append one transaction. OS file ownership is the local authorization
boundary; the configured operator identifier is audit metadata, not independent proof of a person,
so production use requires a dedicated non-shared operating-system account.

The product CLI exposes separate authority inspection, broker and worker preflight, a manual worker
task command, and broker authority compare-and-set commands. Each loads only its exact runtime,
emits one deterministically ordered non-secret JSON record after clean shutdown, and exits with 0
for success/ready, 2 for a policy-blocked preflight, or 1 for an operational failure. Authority
mutation requires the exact expected and desired opposite states, a bounded reason, and the matching
literal enable/disable confirmation. The explicit `broker-open-draft` command additionally requires
a task UUID, the operator's expected policy digest, and the literal `--confirm-draft`. It never
calls the write port unless broker preflight is clean and the digest matches. The service then
rechecks the exact task, policy, evidence, complete usage, base revision, remote governance, and
kill switch around its durable idempotent dispatch. The broker command port deliberately has no
authority-switch command, and the authority port has no remote-write command, so broker and human
enablement duties remain separate. Scheduler has no CLI enable path. All switches remain
default-off. An empty rate card adds `cost-policy-unconfigured` to preflight and independently
denies draft mutation, so readiness is not merely advisory. The safe manual ceremony is: inspect;
require broker preflight to report only `pr-broker-disabled`; enable with compare-and-set; issue the
exact draft command; then compare-and-set disable even when the draft attempt fails. The broker's
immediate preflight and inner rechecks remain authoritative throughout.

The explicit `worker-run` command likewise binds an owner-only worker config, task UUID, expected
policy digest, generated correlation UUID, and literal `--confirm-run`. Scheduler-disabled is not a
manual-work denial; every other preflight reason remains blocking. Under the worker's existing
single-writer queue, a resumable application runner reconciles interrupted preparation and execution
journals, advances the bounded qualify/specify/plan chain, atomically materializes the contract,
rechecks execution admission, and invokes the existing implement/gate/review/repair service. Durable
identity disagreement fails closed. The command stops at `pr-proposed`, emits only a compact
non-secret report, and cannot reach GitHub, broker credentials, control mutation, merge, or release
capability.

Evidence append is not a general control-plane command. Bootstrap registers exact in-memory object
capabilities for the control plane, execution observer, gate observer, and one named PR broker. The
ingress rejects an unknown capability, cross-channel producer impersonation, a mismatched artifact,
or resource-isolation claims that do not match their canonical record, contract, policy, execution,
and cgroup identity. Untrusted workers never receive any of those capabilities.

The pre-contract boundary is explicit too. Strict canonical schemas represent raw intake,
qualification, specification, plan, task-scoped preparation authority, phase run requests/records,
an append-only preparation event chain, and a three-run preparation bundle. Every derived artifact
links the exact predecessor digest. A trusted repository grant—not request or model text—issues
authority for the exact task, request, repository/base commit, predecessor contract, active policy,
skill packages/DAG, read-only preparation profiles, execution worker profiles, include-path
allowlist, protected paths, maximum risk, capability/budget ceilings, attempt count, evidence floor,
approval roles, and validity window.

The production entry for that boundary is the separate `@agentlab/runtime/factory-intake`
composition. Its strict owner-only `agentlab.local-factory-intake.v1` config pins a durable
database, content-addressed artifact root, canonical repository root and identity, active
conversation, operator, fixed Git/flock executables, separately reviewed cost policy and preparation
grant, exact skill-package files, and authority lifetime. The owner-authored request is a separate
strict `agentlab.intake-submission.v1` document containing only `feature|bug`, a stable source
reference, title, and body. The boundary—not the request—derives UUIDs, timestamps, human actor,
current Git commit, policy digest, deduplication key, and task-scoped authority. Stable
repository/kind/source identity makes retry idempotent; changed report text or current authority
conflicts rather than silently creating or rewriting a task. Exact retries return the original
pinned base even if HEAD has since advanced.

Before registration, intake requires an active conversation whose workspace exactly matches the
configured repository, an R1-only grant supported by the credentialless worker, an exact cost rule
for every preparation and execution provider/model, and a one-to-one match between every grant
manifest and canonical skill-package digest. Packages, request, and authority are published to the
immutable artifact store; the request, authority, and first event are then inserted atomically under
the SQLite writer lease. CLI registration requires a prior policy digest and literal
`--confirm-register`. Intake has no provider/model adapter, GitHub credential, broker, scheduler
switch, gate executor, tmux, terminal, or interactive-runtime path; executable closure allowlists
enforce that separation.

The dormant preparation application advances exactly one `qualify`, `specify`, or `plan` checkpoint
at a time through a provider-neutral execution port. Codex and Claude adapters advertise these
phases only as local, offline, no-secret, read-only work. A phase-start event and canonical run
request are durable before a worktree or provider starts. Bounded output, usage, provider session,
process isolation, canonical phase document, and run record are stored before a result event.
Invalid output, incomplete usage, excess budget, missing identity, capability mismatch, cleanup
uncertainty, replay, and artifact substitution fail closed. Retry count is authority-bound;
`needs-human`, rejection, exhaustion, cancellation, and expiry are explicit terminal outcomes. The
durable execution ID is also the exact systemd-scope and disposable-worktree identity. Every
worktree Git command holds the kernel lock on its canonical task directory, including an orphaned
child after a control-plane crash. A local Linux reconciler may append abandonment only after
repeated systemd proof that the exact scope is inactive, non-blocking acquisition of that lock,
canonical source-repository and base-commit proof, exact factory-owned workspace cleanup, and
post-cleanup proof that both process and Git/filesystem state are absent. Malformed, changing,
symlinked, overlapping, locked, or otherwise ambiguous state remains in-flight and fails closed.
Workspace creation failure and unconfirmed process-tree cleanup likewise leave the durable phase
running.

Cost admission is a domain policy boundary, not provider-adapter discretion. Factory policy bundle
v2 embeds a strict `agentlab.cost-policy.v1` rate card whose rules bind one exact provider/model
coordinate to either deterministic token rates or explicitly trusted provider-reported cost. There
is no wildcard or fallback rate. The application calls the accounting preflight before persisting a
run-start event, and the local executor repeats it before isolation or process spawn; a null/unknown
model or mismatched policy digest fails closed. Adapters return raw measurements with zero authority
over the final cost. The accountant validates usage and overwrites cost using integer micro-USD
arithmetic rounded upward. Claude accounting uses its aggregate per-model usage, including cached
input, and refuses an explicitly unknown pricing basis. Incomplete measurements or missing reported
cost remain `usageComplete=false`, which policy already rejects. Execution evidence records the
pinned policy digest, completeness, and final micro-USD amount without changing the immutable v1 run
request/record schemas.

The implementation/review path now applies the same crash invariant. One immutable execution-run
header binds the task contract, repository/base commit, correlation ID, and contract-derived attempt
ceiling. Its append-only, digest-chained journal persists an exact workspace ID before worktree
creation and an exact operation ID before every agent or deterministic gate process. Agent run
requests are canonical artifacts; gate callers—not adapters—own the isolation ID. A process result
becomes complete only after cleanup is confirmed, its canonical observation is published, and the
matching operation-finished event is appended. Worktree cleanup is positively confirmed before
attempt closure. A crash or append failure therefore leaves either no external resource or one exact
recoverable workspace/process coordinate; it can never manufacture completion. The shared Linux
reconciler checks every active journal-owned systemd scope, obtains the same non-blocking worktree
lock, verifies repository/base identity, removes only the derived workspace, and repeats absence
checks. Proven interruption becomes an append-only abandonment plus a safe terminal task transition;
uncertain host state remains active for a later recovery pass.

Draft-PR authority now has its own crash-durable boundary as well. SQLite version 8 stores one
immutable dispatch containing the exact canonical proposal and configured broker identity, followed
by an append-only chain:

```text
ready → dispatch-active → remote-open → evidence-recorded → completed
```

The proposal is durable before a branch push or GitHub API write. Recovery replays those exact bytes
and timestamps, so the deterministic commit SHA is unchanged. The GitHub adapter may reuse only the
exact derived branch head and exact matching open draft; an existing different branch, PR, base,
title, body, or head fails closed. A branch left after a crash between push and PR creation is
reused without another push, and a PR whose successful create response was lost is found through
bounded readback. The remote record, authenticated evidence bundle, and exact `pr-open` task event
are then recorded as separate checkpoints. A crash after any one of them resumes at the next
checkpoint without creating a second PR or manufacturing completion. A checkpoint that observes
broker revocation performs no new write. If revocation races an already in-flight remote call, its
exact result is journaled but the task cannot advance; the dispatch remains recoverable.

The supported Linux-host preflight is a distinct required `factory-sandbox` CI job. It executes the
live systemd/cgroup resource tests, memory-limit kill test, preparation and execution crash
recovery, and a Bubblewrap probe that proves the source checkout is hidden, dependencies are
read-only, the worktree remains writable, and the child occupies a distinct network namespace.
Branch protection requires this exact GitHub Actions check alongside `verify`; ordinary unit tests
do not satisfy the host proof. The credentialless ephemeral CI runner explicitly permits
unprivileged user namespaces; production hosts must meet the same Bubblewrap precondition through
their governed host configuration.

A pure compiler recanonicalizes the whole source chain. Its authority is supplied only at the
trusted construction boundary and is absent from agent output. It rejects unresolved requests or
substitutions, permits only narrowing, raises risk from the complete prospective scope, derives
gates/reviews/approvals from policy, and emits the existing immutable task contract. One SQLite
transaction creates that contract, the complete `intake → qualified → specified → planned` task
history, initial preparation evidence, deterministic `contract-validation`, `scope-validation`, and
`policy-validation` gate claims, and the preparation `prepared` marker. Those gate claims are
derived by the trusted compiler/materializer and are never accepted from model output. A late
failure rolls all of them back; a lost response can be retried idempotently. Model output never
authors identity, timestamps, digests, authority, policy, ledger events, evidence assertions, or
approvals.

Execution admission is a separate deterministic application service. It accepts only a task UUID,
loads the planned immutable contract and its active conversation, and reads the repository's current
commit through a hardened Git adapter; a caller cannot supply the revision used for policy. It
evaluates the execution stage with zero pre-execution usage and an empty change set, queues only an
allowed R1 task, and otherwise leaves the task planned with the denial recorded as evidence.
Already-queued work is idempotent. The service cannot enable scheduler or broker authority.

The worker's local configuration is a separate owner-only v1 document. It pins the database,
artifact/worktree roots, hardened Git tools, systemd isolation identity, Bubblewrap/runtime mounts,
the exact seven external R1 gate commands and evidence kinds, and one or more supported provider
executables by canonical path, SHA-256 digest, and exact `--version` output. Its separately
protected cost policy is loaded through the same fail-closed rate-card boundary as broker config v2.
Provider resolution rechecks file identity/digest and version for each use under a fixed environment
that contains no GitHub, package-registry, or cloud credential variables. The schema has no GitHub
App, remote-repository, or authority-control field, and the sandbox refuses `/` as a runtime mount.

The worker path is now composed only through the separate `@agentlab/runtime/factory-worker`
subpath; it is not reachable from `local-runtime.ts`, scheduled, deployed, published, or enabled.
Its read-only host preflight revalidates canonical executable and runtime paths, owner-only
artifact/worktree roots, exact systemd/provider identities, credentialless fixed-argv probes, cost
readiness, user-manager reachability, and the observed scheduler switch. A maximum of 32 admitted
commands execute serially against one SQLite writer lease. Recovery remains callable when normal
work is cost- or host-blocked, and close drains admitted work and proves process cleanup before
repositories and the lease are released. The port exposes no intake-authority issuer, control
switch, GitHub adapter, or broker credential. An explicit policy-pinned `worker-run` command can
resume one already registered task through those existing services and stops at broker readiness; it
does not enable the scheduler or perform a remote write. A separate broker composition, owner-only
key source, readiness command, and explicit draft-only command also exist. The isolated human
authority composition and non-interactive CLI can change only the broker switch; the normal TUI
cannot invoke factory authority, worker, or broker commands. Current branch protection requires
exact `verify` and `factory-sandbox` checks, dismisses stale reviews, enforces administrators, and
forbids force-push and deletion. It still has zero required approvals, does not require approval of
the latest push, and has neither a CODEOWNERS policy nor required code-owner review. Preflight
therefore reports blocked for those controls and `cost-policy-unconfigured`. The cost-accounting
mechanism exists, but the repository ships no live config or provider/model rates. Config v2 can now
provision a reviewed owner-only rate card; actual rate, authority config, and broker-key
provisioning remain activation prerequisites. An incomplete usage record already denies PR creation,
and the explicit write command refuses a blocked preflight or unexpected policy digest. Governed
intake is implemented but no live intake configuration or task has been provisioned. No live agent
task or PR has been created by this code. PR-head repair, scheduler/quotas, eval promotion, merge,
release, canary, and incident automation remain later stages.

## Dependency map

Arrows are compile-time dependencies. Runtime control flow may travel in the opposite direction
through an injected port.

```text
interactive TUI ──▶ @agentlab/runtime ───────────────▶ local-runtime composition
intake operator ───▶ @agentlab/runtime/factory-intake ▶ local-factory-intake composition
broker preflight ─▶ @agentlab/runtime/factory-broker ▶ local-factory-broker composition
worker operator ───▶ @agentlab/runtime/factory-worker ▶ local-factory-worker composition
human operator ────▶ @agentlab/runtime/factory-authority ▶ local-factory-authority composition
                                                         │              │
                                                         ▼              ▼
                                                   application     infrastructure
                                                         └────▶ domain ◀────┘
                                                                 │
                                                                 ▼
                                                             contracts

launcher (distribution only; independent source graph)
```

| Area                      | Owns                                                                  | May depend on workspace areas                  |
| ------------------------- | --------------------------------------------------------------------- | ---------------------------------------------- |
| `packages/contracts`      | Zod schemas and stable shared data shapes                             | contracts                                      |
| `runtime/domain`          | Invariants, value objects, errors, and ports                          | domain, contracts                              |
| `runtime/application`     | Typed use cases, validated commands, coordination, ownership          | application, domain, contracts                 |
| `runtime/infrastructure`  | SQLite, filesystem, provider, process, tmux, and PTY adapters         | infrastructure, domain, contracts              |
| runtime composition roots | Interactive, intake, worker, human-authority, and broker construction | runtime layers, contracts                      |
| `apps/tui`                | Rendering, input, dialogs, and bounded CLI presentation               | TUI, contracts, registered runtime public APIs |
| `packages/launcher`       | Binary acquisition, verification, and process handoff                 | launcher                                       |

The product-source rules are executable and fail closed:

- Cross-package imports use declared package entry points, never relative paths or deep package
  imports.
- Domain and application code cannot import outward into infrastructure or presentation.
- Infrastructure implements domain ports and cannot depend on application use cases.
- TUI and CLI code see runtime modules only through registered package entry points. The intake,
  broker, worker, and human-authority subpaths are exact; every runtime deep import fails.
- The broker composition closure cannot reach provider, tmux, terminal, or interactive-composition
  modules. The worker closure can reach only its explicit pinned factory-provider allowlist and
  cannot reach GitHub, broker, tmux, terminal, dynamic discovery, or interactive composition. The
  interactive closure cannot reach any factory composition or GitHub authority modules. The human
  authority closure has an explicit application/infrastructure allowlist and cannot reach remote,
  model, process-execution, worker, broker, tmux, terminal, or interactive capabilities.
- Intake has its own exact allowlist and can reach only local persistence, immutable artifacts, and
  fixed-argv Git revision observation—not providers, gates, GitHub, broker, or control mutation.
- The product source graph must remain acyclic.
- The root workspace manifest inventories every workspace. A checked architecture registry must
  classify every workspace manifest and production source root exactly once; unknown roots,
  symlinked workspace entries, and symbolic links inside production roots fail.
- Manifest dependencies, public exports, source imports, and the dependency graph must agree.
- Each layer has an explicit external-capability allowlist. Server frameworks are forbidden in all
  current product layers.
- Unsupported, reflective, computed, or non-static loader forms fail instead of disappearing from
  the graph. Ambiguous computed `Object`/`Reflect` access and the `node:vm`/`vm` code-generation
  modules fail closed. Triple-slash references and string-literal module augmentations are edges
  too. Inner-layer runtime globals such as process, Bun, timers, network APIs, randomness, and wall
  clocks are rejected even when aliasing, computed access, or ambient declarations hide their
  spelling.
- Bun-test discovery is recursive without a count threshold and rejects symbolic links in included
  test-bearing trees; generated, vendor, fixture, and duplicate tool-alias trees are explicit
  exclusions.

`npm run architecture:check` parses TypeScript imports and exports, checks those rules, and runs
inside `npm run verify`. ESLint independently reinforces inner-layer restrictions. `scripts/**` and
`tests/**` are explicit outer tooling/test scopes, not product layers; their narrow exclusions can
never exclude workspace production source.

## Placement guide

| Change                                                       | Location                                          |
| ------------------------------------------------------------ | ------------------------------------------------- |
| Shared external input or persisted data shape                | `packages/contracts`                              |
| Pure invariant, identity, value, error, or adapter interface | `packages/runtime/src/domain`                     |
| Product use case or coordination policy                      | `packages/runtime/src/application`                |
| Operating-system, database, tmux, PTY, or provider behavior  | `packages/runtime/src/infrastructure`             |
| Interactive object construction and resource lifetime        | `packages/runtime/src/local-runtime.ts`           |
| Broker-only object construction and resource lifetime        | `packages/runtime/src/local-factory-broker.ts`    |
| Worker-only object construction and resource lifetime        | `packages/runtime/src/local-factory-worker.ts`    |
| Human control construction and resource lifetime             | `packages/runtime/src/local-factory-authority.ts` |
| Intake-only object construction and resource lifetime        | `packages/runtime/src/local-factory-intake.ts`    |
| Terminal rendering, input, or interaction state              | `apps/tui`                                        |
| Installer, cache, or binary handoff                          | `packages/launcher`                               |

Supported providers are a deliberately closed compile-time set. Provider neutrality means native
launch/capability adapters behind stable ports, not runtime plugins or a flattened provider-session
protocol. Adding a supported provider requires compatible contract/persistence registration plus
infrastructure adapters, but must not add provider conditionals to lifecycle rules. Presentation
uses capability data rather than provider-ID switches. New presentation surfaces call the validated
command port and must not reach into concrete adapters.

## Terminal ownership

Tmux is the durable session store. It retains each agent's pane and terminal history even while the
UI is closed. The center pane owns exactly one ephemeral PTY client:

1. Selection resolves to a strictly managed session owned by the selected project conversation.
2. The runtime validates the conversation ID, exact session name, saved folder, terminal dimensions,
   and ownership mode. It resolves that name once to a target containing tmux's session ID, server
   PID/start generation, exact resolved name, and expected ownership. For a nonce row it proves the
   nonce against that target.
3. The runtime reads up to 20,000 retained tmux lines through a tmux-side generation/ownership
   guard, then re-resolves and proves the same target immediately before PTY creation. The PTY runs
   a guarded `attach-session` action in the same tmux server command. Name reuse or a restarted
   server reusing `$0` cannot redirect history, destruction, or attachment to a foreign session.
4. Live PTY events are buffered behind a 1 MiB pre-release cap until a fresh native VT parser has
   replayed the older history, then released in arrival order. An overrun closes only the ephemeral
   client and invites a clean reattach from tmux instead of replaying a partial escape stream.
5. OpenTUI forwards input bytes unchanged, including split UTF-8 and arbitrary control bytes, plus
   resize events, paste, mouse selection, ANSI state, and cursor state.
6. Changing selection or closing the UI kills only the client PTY. The tmux session stays alive.

The selected panel owns normal attachment replacement; the runtime registers each spawned PTY before
fallible listener setup, and adapters register any child created before their own validation can
fail. Process shutdown therefore closes even a partially constructed client. A close is confirmed
only after the tmux client process exits; a failed signal or ambiguous exit remains owned and
retryable, so it cannot permit early writer-lease release. Pre-listener PTY output, ordered
pre-release output, the ingestion pump, and terminal scrollback all have explicit byte bounds. Any
pre-listener overflow discards the whole buffered stream and closes the ephemeral client rather than
replaying an ANSI suffix. OpenTUI receives a 16 MiB scrollback byte budget; unlike tmux's separate
20,000-line history limit, the number of retained emulator lines varies with their encoded content.
During replacement, React keys the native terminal by conversation and session, so the new
attachment cannot inherit the old VT, selection, cursor, or mouse state. History and live output are
drained in order and one full invalidation follows history seeding. UI polling stores session
snapshots under their conversation ID, so returning to a project immediately restores its agent list
and late responses cannot display another conversation's agents. Metadata-only polling changes do
not reopen the PTY.

Target-aware terminal factory and history ports are the supported extension seam for nonce-owned
sessions. The original name-only hooks remain source-compatible solely for migrated `legacy-name`
rows; they reject nonce-owned targets before invoking user code because a name cannot preserve the
resolved runtime ID, server generation, and nonce proof.

Runtime commands share an admission gate. Every spawned command tree, provider control process/SDK
query, and PTY is registered immediately with one retryable runtime resource owner. Shutdown stops
new work and retains ownership of initialization, reconciliation, queries, provider discovery,
terminal opening, and mutations until each settles or its adapter confirms cancellation and cleanup.
One eventual finalizer then attempts all runtime-resource and SQLite cleanup even when an earlier
independent cleanup fails. It releases the writer lease only after every admitted operation is
settled or cancelled, every registered resource is confirmed closed, and the repository closes. A
caller deadline may stop waiting but does not poison or revoke ownership. Concurrent and successful
closes share their result; failed or ambiguous members and phases retain the lease and remain
retryable by a later `close()`.

## Durable lifecycle and writer ownership

SQLite and tmux are coordinated by the persisted state machine in
[ADR 0005](decisions/0005-durable-local-runtime-lifecycle.md):

```text
creating ──▶ active ──▶ deleting ──▶ removed
legacy-unlinked ──────▶ deleting
```

Only `active` admits provider/session queries, attachment, or worker creation. Normal listing
returns active projects and removable legacy rows. Pending rows are reconciled before command
admission; a failed recovery keeps the row non-active and fails startup with an actionable
diagnostic.

A `creating` row persists an unpredictable nonce before tmux work. `new-session` associates that
nonce atomically with the exact captain and returns the created session ID/server generation in the
same command. Every configuration, respawn, compensation, history, kill, and attach action carries
that target through a tmux-side generation/ownership guard. For these new nonce-owned projects, both
captain policy and AgentLab's explicit worker command stamp the same nonce atomically on every
worker they create. In-process captain cleanup also requires `createdHere`. Creation recovery uses
one ownership-bearing tmux inventory snapshot for the exact captain and every parsed worker in the
conversation. It removes the reservation only when a second coherent snapshot confirms the entire
owned set absent, cleans only nonce-matching sessions, and retains `creating` on a missing,
mismatched, or ambiguous proof. Extra captain-shaped sessions are unowned: never shown, attached, or
automatically killed. Public deletion never admits `creating`. Deletion marks `deleting` before
stopping parsed workers and the exact persisted captain: nonce-bearing rows require a matching
nonce, while only migrated pre-nonce active or legacy-unlinked rows retain an explicit exact-name
compatibility cleanup path.

Ownership mode is persisted, not inferred: newly created rows are `nonce`; rows migrated from a
pre-nonce release are `legacy-name`, retain a null nonce through deletion, and are never upgraded in
place. A migrated active project and its already-running captain continue creating and cleaning
workers by exact managed identity. Recreating the project is the deliberate path to nonce ownership.
Inventories are capped at 128 managed sessions per conversation, and destructive cleanup runs at
most eight tmux processes concurrently. For nonce-owned projects, every session-consuming
operation—listing, attachment, explicit worker deletion, conversation deletion, and
recovery—requires exact managed identity plus the matching session nonce at the final boundary.
Missing/mismatched sessions are filtered or rejected and never stopped. Legacy-name projects retain
only their explicit exact-identity compatibility behavior.

Startup first verifies that the host has tmux 3.2 or newer, the oldest release supporting the atomic
`new-session -e` ownership stamp. One canonical database target then owns one sidecar SQLite writer
lease. It is acquired before main database migration or any session/PTY side effect and released
last. Relative and symlink aliases resolve to the same lease; ambiguous URI or hard-linked targets
are rejected. The dedicated lease transaction never touches or blocks the application database.

The repository accepts only nonce-owned `creating` reservations from product code and only the legal
`creating → active`, `active → deleting`, and `legacy-unlinked → deleting` compare-and-set edges.
SQLite uses `UPDATE … RETURNING` so a committed transition is its returned record rather than a
second fallible read. Migration remains the only source of legacy-name authority.

## Project creation

1. Startup lists saved projects but deliberately selects none; neither the current directory nor a
   CLI argument can become an implicit project.
2. The local command boundary validates the user-entered folder path, project name, provider, and
   nullable model/thinking selections.
3. The filesystem adapter expands `~/…`, resolves relative paths, requires an existing directory,
   and returns its canonical path. SQLite uniqueness allows only one project per canonical folder.
4. Provider capabilities are discovered in that exact folder and explicit selections are checked;
   null keeps the provider default.
5. A provider launcher builds an argument vector for an interactive captain. An initial task is not
   required.
6. SQLite reserves a `creating` row containing the exact captain identity and ownership nonce.
7. Tmux atomically creates the nonce-stamped session, configures it, then starts the real provider
   CLI.
8. SQLite compare-and-sets the row to `active`; only that record is returned to presentation.

If activation fails after launch, only the exact captain and parsed workers with the matching nonce
are removed, and the reservation disappears only after that entire set is confirmed absent. Any
incomplete or conflicting cleanup remains journaled for fail-closed startup recovery. If an active
captain exits quickly, `remain-on-exit` preserves its pane and output for inspection.

## Worker lifecycle

Explicit worker creation validates a friendly name, provider, and initial task. It generates a
strict identity owned by the conversation:

```text
agentlab__<conversation-uuid>__worker__<provider>__<slug>
```

For a `nonce` row, the application loads the active conversation's persisted ownership nonce and
stamps it in the same atomic `new-session` operation. Captain policy does the same through a fixed
quoted environment variable, so every new worker has identical deletion/recovery proof regardless of
creation path. A migrated `legacy-name` active row preserves exact-identity worker creation for both
paths because its already-running captain cannot safely receive a new environment or policy.

Deletion parses that identity, proves it is a worker in the selected conversation, confirms the
session still exists and, for a `nonce` row, carries the conversation nonce, and stops only that
exact tmux session. `legacy-name` rows use the explicit exact-identity compatibility rule in
ADR 0005. Captains are rejected at the application boundary and never offered as an independent
deletion target.

Whole-project deletion first persists `deleting`, confirms the captain stopped, cleans authorized
workers, and then re-enumerates the raw conversation worker set. The row is removed only after one
complete post-captain inventory is unambiguously empty; a late worker, ownership conflict, or
ambiguous result retains `deleting` for recovery.

Workers are temporary leases owned by their conversation's captain. Only the captain has enough
context to determine whether a quiet agent is finished, blocked, or awaiting a follow-up, so the
runtime does not infer completion from idle time or process activity.

## Provider capability discovery

Model metadata is obtained from each installed CLI without starting an agent turn:

- Codex uses app-server's machine-readable `model/list` protocol.
- Claude uses the official Agent SDK control channel's `supportedModels()` metadata with empty
  streaming input.
- OpenCode uses bounded parsing of `models --verbose`. Provider variants that cannot be selected by
  its persistent root TUI are deliberately not exposed.

Discovery runs in the selected project folder. Output size, JSON depth, record counts, and timeouts
are bounded. One total catalog deadline covers executable location, version probing, live model
discovery, and each adapter's bounded cleanup facade. Uncancellable filesystem discovery may outlive
the caller's bounded response, but the runtime continues owning that raw operation and shutdown
drains it before persistence closes. Spawned command trees and Codex app-servers have separate
immediate resource ownership. Claude injects the SDK's supported spawn hook and owns the actual CLI
process tree; SDK `return()` remains protocol cleanup rather than exit evidence. Cleanup failure or
a facade timeout therefore cannot release the writer lease and remains retryable. Cache entries are
isolated by provider, workspace, executable, and CLI version. Concurrent requests share a probe. A
failed refresh uses last-known-good metadata only for the exact key; without a catalog, an installed
provider remains available in provider-default-only mode.

Provider-default model and reasoning are represented by null and omit CLI flags. Launchers receive
only validated values. Every process is started with an argument array; only the tested tmux
command-string boundary applies POSIX quoting.

Captain policy uses each CLI's native high-priority instruction mechanism. OpenCode receives an
inline primary-agent configuration through its environment. Instruction text contains no raw
workspace or executable path: it references fixed, quoted variables such as `"$AGENTLAB_WORKSPACE"`,
whose values cross the tested tmux quoting boundary as single environment values. When an initial
objective is supplied, it remains a separate `--prompt` user message; user text is never
concatenated into the captain's system prompt. Prompt policy is not treated as a security sandbox.

## Persistence

SQLite stores app-owned project metadata: name, canonical folder, captain configuration, managed
session identity, lifecycle state, ownership mode, and creation ownership nonce. Provider
transcripts and credentials remain in provider-owned storage; tmux owns live output and terminal
state. The normal database is `$XDG_DATA_HOME/agentlab/agentlab.sqlite` (falling back to
`~/.local/share/agentlab/agentlab.sqlite`).

Explicit `AGENTLAB_DATABASE_PATH` wins and may reference an ordinary local-filesystem database.
Relative and symlink spellings are canonicalized; SQLite URI targets and existing hard-linked
targets are rejected before side effects.

## Performance model

- OpenTUI performs native framebuffer rendering and VT parsing.
- Bun provides the native PTY and compiles the distribution into one executable.
- The renderer targets 30 FPS, may render up to 60 FPS, and uses a render thread.
- OpenTUI and provider adapters load only for an interactive run; help/version stay lightweight.
- Only the selected agent produces live PTY traffic.
- Session polling waits for each request before scheduling the next, ignores superseded responses,
  avoids state updates when the snapshot did not change, and caches snapshots per conversation.
- The embedded terminal consumes the full center layout, deduplicates resize events, and recolors
  only OpenTUI's resolved black/white defaults to the shared workspace surface; colored ANSI cells
  remain native.
- A focused test feeds at least 5 MiB of ANSI output and enforces a conservative 2 MiB/s floor.
- Layouts below 90×18 show an explicit resize state instead of corrupting the three panes.

## Trust boundaries

- No network listener exists.
- Zod validates local command input and terminal dimensions; the filesystem boundary canonicalizes
  and verifies every selected project folder.
- Managed session names are generated or strictly parsed before tmux access.
- Persisted captain identities are revalidated against row conversation/provider ownership before
  any process action.
- Child processes use argument arrays; the one tmux shell boundary quotes every executable,
  argument, and environment value.
- Pre-listener PTY output and terminal scrollback have fixed bounds.
- Live terminal output cannot overtake retained history, and terminal input remains raw bytes until
  Bun writes it to the PTY.
- Shutdown rejects new application work and owns every admitted operation through settlement or
  confirmed cancellation before closing persistence.
- Provider authentication remains owned by installed CLIs.

## Compatibility and delivery invariants

Compatibility surfaces include the `@agentlab/runtime` export map, names, and signatures;
append-only SQLite migrations; managed-session grammar; persisted provider IDs; documented
`AGENTLAB_*` variables; launcher/native CLI behavior and exit semantics; and release-manifest/cache
formats. Shipped migrations are never edited. Historical rows and managed sessions remain readable
until an explicit migration/deprecation decision says otherwise.

Architecture work must preserve the aggregate CI check identity, release targets and asset names,
annotated-tag-on-main validation, checksums, SBOM/provenance attestations, immutable GitHub release,
OIDC trusted npm publication, byte-for-byte candidate comparison, and release recovery verification.
Release-control changes require separate review.

## Architecture acceptance

The architecture is releasable only when automated tests prove:

- exhaustive workspace/manifest/tsconfig/source classification (including declarations), alias-free
  and symlink-free ownership, external-capability policy, public entries, exact public key presence,
  exact public parameter/return signatures, computed/destructured/reflective loader rejection, and
  real cycle diagnostics;
- exhaustive discovery of every repository-owned Bun test, including co-located workspace tests,
  with only explicit generated/vendor/fixture trees excluded;
- every supported historical schema migrates without data loss;
- the `new-session`/activation crash window is recovered only with exact matching ownership proof;
- unowned extra captains are neither presented nor destroyed;
- canonical/relative/symlink database aliases contend on one lease, process exit releases it, and
  ambiguous URI/hard-link targets fail before side effects;
- adversarial raw paths never appear in captain instruction text and remain one quoted environment
  value at the tmux boundary;
- a caller deadline cannot cancel or poison eventual all-operation drain and cleanup;
- failed or timed-out command, provider-query, and PTY cleanup stays owned, blocks lease release,
  and succeeds only after a confirmed retry; and
- formatting, strict types, lint, unit/component tests, real tmux/Bun PTY integration, production
  build, packaging, dependency audit, and release metadata all pass.
