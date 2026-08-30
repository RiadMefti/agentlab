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

The product is local-only and single-process. It has no HTTP server, WebSocket gateway, browser
renderer, desktop shell, remote mode, app command language, MCP bridge, or provider-session
translation layer.

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

Evidence append is not a general control-plane command. Bootstrap registers exact in-memory object
capabilities for the control plane, execution observer, gate observer, and one named PR broker. The
ingress rejects an unknown capability, cross-channel producer impersonation, a mismatched artifact,
or resource-isolation claims that do not match their canonical record, contract, policy, execution,
and cgroup identity. Untrusted workers never receive any of those capabilities.

The pre-contract boundary is explicit too. Strict canonical schemas represent raw intake,
qualification, specification, plan, task-scoped preparation authority, and a three-run preparation
bundle. Every derived artifact links the exact predecessor digest. Authority pins the request, task,
repository/base commit, predecessor contract, active policy, exact skill packages and DAG, worker
profiles, include-path allowlist, protected paths, maximum risk, capability/budget ceilings,
evidence floor, approval roles, and validity window. A pure domain compiler recanonicalizes the
whole chain. Its authority is supplied only at the trusted construction boundary and is absent from
the preparation-output input. The compiler rejects unresolved requests or substitutions, permits
only narrowing, raises risk from the complete prospective scope, derives gates/reviews/approvals
from policy, and emits the existing immutable task contract. Model output cannot author or replace
authority, policy, or approval fields.

This path is not composed into `local-runtime.ts`, exposed by the TUI, scheduled, deployed, or
enabled. Normal database migration creates only its inert local ledger tables. The repository
currently lacks the approval and last-push protections required by the broker, so the adapter fails
closed even if a future composition supplies credentials. Complete provider cost accounting,
target-host sandbox preflight in CI, an isolated short-lived broker identity, and protected-path
ownership also remain activation prerequisites. Provider-neutral preparation-skill execution,
durable preparation artifact/evidence ingestion, PR-head repair, scheduler/quotas, eval promotion,
merge, release, canary, and incident automation remain later stages. Until an explicit activation
change meets ADR 0006's prerequisites, user-visible behavior and the product network boundary remain
unchanged.

## Dependency map

Arrows are compile-time dependencies. Runtime control flow may travel in the opposite direction
through an injected port.

```text
apps/tui ───────────────▶ @agentlab/runtime public API
   │                                  │
   └──────────────▶ contracts         ▼
                              local-runtime composition
                                   │          │
                                   ▼          ▼
                             application   infrastructure
                                   │          │
                                   └────▶ domain ◀────┘
                                           │
                                           ▼
                                       contracts

launcher (distribution only; independent source graph)
```

| Area                       | Owns                                                          | May depend on workspace areas                   |
| -------------------------- | ------------------------------------------------------------- | ----------------------------------------------- |
| `packages/contracts`       | Zod schemas and stable shared data shapes                     | contracts                                       |
| `runtime/domain`           | Invariants, value objects, errors, and ports                  | domain, contracts                               |
| `runtime/application`      | Typed use cases, validated commands, coordination, ownership  | application, domain, contracts                  |
| `runtime/infrastructure`   | SQLite, filesystem, provider, process, tmux, and PTY adapters | infrastructure, domain, contracts               |
| `runtime/local-runtime.ts` | The local composition root and public runtime API             | runtime layers, contracts                       |
| `apps/tui`                 | Rendering, input, dialogs, and presentation state             | TUI, contracts, public `@agentlab/runtime` only |
| `packages/launcher`        | Binary acquisition, verification, and process handoff         | launcher                                        |

The product-source rules are executable and fail closed:

- Cross-package imports use declared package entry points, never relative paths or deep package
  imports.
- Domain and application code cannot import outward into infrastructure or presentation.
- Infrastructure implements domain ports and cannot depend on application use cases.
- The TUI sees the runtime only through `@agentlab/runtime`.
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

| Change                                                       | Location                                |
| ------------------------------------------------------------ | --------------------------------------- |
| Shared external input or persisted data shape                | `packages/contracts`                    |
| Pure invariant, identity, value, error, or adapter interface | `packages/runtime/src/domain`           |
| Product use case or coordination policy                      | `packages/runtime/src/application`      |
| Operating-system, database, tmux, PTY, or provider behavior  | `packages/runtime/src/infrastructure`   |
| Concrete object construction and resource lifetime           | `packages/runtime/src/local-runtime.ts` |
| Terminal rendering, input, or interaction state              | `apps/tui`                              |
| Installer, cache, or binary handoff                          | `packages/launcher`                     |

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
