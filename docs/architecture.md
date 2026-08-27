# Architecture

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

## Components

- `packages/contracts`: Zod schemas and stable local data contracts for conversations, providers,
  and sessions.
- `packages/runtime/src/domain`: conversation ports, managed session identities, launch command
  values, terminal ports, and errors.
- `packages/runtime/src/application`: conversation use cases, validated local commands, terminal
  attachment ownership, and the captain's invariant instructions.
- `packages/runtime/src/infrastructure`: SQLite persistence, executable discovery, provider
  capabilities/launchers, tmux, terminal history, and Bun's native PTY.
- `packages/runtime/src/local-runtime.ts`: framework-free composition for one local process.
- `apps/tui`: the OpenTUI/React compositor, dialogs, keyboard/mouse behavior, and selected terminal.

Domain code imports neither UI code nor concrete infrastructure. Application code depends on ports,
not implementations. ESLint rules enforce both boundaries.

## Terminal ownership

Tmux is the durable session store. It retains each agent's pane and terminal history even while the
UI is closed. The center pane owns exactly one ephemeral PTY client:

1. Selection resolves to a strictly managed session owned by the selected project conversation.
2. The runtime validates the conversation ID, session name, saved folder, and terminal dimensions.
3. The runtime reads up to 20,000 retained tmux lines, then opens a PTY running
   `tmux attach-session -t =<exact-name>` using an argument array.
4. Live PTY events are buffered behind a 1 MiB pre-release cap until a fresh native VT parser has
   replayed the older history, then released in arrival order. An overrun closes only the ephemeral
   client and invites a clean reattach from tmux instead of replaying a partial escape stream.
5. OpenTUI forwards input bytes unchanged, including split UTF-8 and arbitrary control bytes, plus
   resize events, paste, mouse selection, ANSI state, and cursor state.
6. Changing selection or closing the UI kills only the client PTY. The tmux session stays alive.

The selected panel owns normal attachment replacement; the runtime also tracks every returned
attachment so process shutdown closes any client the UI has not released yet. Pre-listener PTY
output, ordered pre-release output, the ingestion pump, and terminal scrollback all have explicit
byte bounds. OpenTUI receives a 16 MiB scrollback byte budget; unlike tmux's separate 20,000-line
history limit, the number of retained emulator lines varies with their encoded content. During
replacement, React keys the native terminal by conversation and session, so the new attachment
cannot inherit the old VT, selection, cursor, or mouse state. History and live output are drained in
order and one full invalidation follows history seeding. UI polling stores session snapshots under
their conversation ID, so returning to a project immediately restores its agent list and late
responses cannot display another conversation's agents. Metadata-only polling changes do not reopen
the PTY.

Runtime commands share an admission gate. Shutdown stops new work, waits for every admitted mutation
to settle, and only then closes PTY clients and SQLite. Quitting during provider resolution
therefore cannot finish runtime teardown ahead of a newly created durable session.

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
6. Tmux creates and configures one retained session in the project folder, then starts the real
   provider CLI.
7. SQLite stores the conversation/project only after its captain session starts.

If persistence fails after launch, the new captain session is removed. If a captain exits quickly,
`remain-on-exit` preserves its pane and output for inspection.

## Worker lifecycle

Explicit worker creation validates a friendly name, provider, and initial task. It generates a
strict identity owned by the conversation:

```text
agentlab__<conversation-uuid>__worker__<provider>__<slug>
```

Deletion parses that identity, proves it is a worker in the selected conversation, confirms the
session still exists, and stops only that exact tmux session. Captains are rejected at the
application boundary and never offered as an independent deletion target.

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
are bounded. Cache entries are isolated by provider, workspace, executable, and CLI version.
Concurrent requests share a probe. A failed refresh uses last-known-good metadata only for the exact
key; without a catalog, an installed provider remains available in provider-default-only mode.

Provider-default model and reasoning are represented by null and omit CLI flags. Launchers receive
only validated values. Every process is started with an argument array; only the tested tmux
command-string boundary applies POSIX quoting.

Captain policy uses each CLI's native high-priority instruction mechanism. OpenCode receives an
inline primary-agent configuration through its environment. When an initial objective is supplied,
it remains a separate `--prompt` user message; user text is never concatenated into the captain's
system prompt.

## Persistence

SQLite stores app-owned project metadata: name, canonical folder, captain configuration, and managed
session identity. Provider transcripts and credentials remain in provider-owned storage; tmux owns
live output and terminal state. The normal database is `$XDG_DATA_HOME/agentlab/agentlab.sqlite`
(falling back to `~/.local/share/agentlab/agentlab.sqlite`).

Explicit `AGENTLAB_DATABASE_PATH` wins and may point to any local database path the user chooses.

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
- Shutdown rejects new application work and drains admitted commands before closing persistence.
- Provider authentication remains owned by installed CLIs.
