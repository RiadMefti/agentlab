# Architecture

## Product boundary

One saved conversation owns exactly one captain. The captain may create zero or more independent
workers. The user normally talks to the captain and may enter any exact session from its tab.

```text
conversation
└── captain (exactly one)
    ├── worker
    ├── worker
    └── ...
```

## Two separate paths

```text
Orchestration
captain ── raw tmux/provider CLI commands ──▶ workers

Observation and direct interaction
Electron renderer or browser ◀── WebSocket ── PTY ──▶ exact tmux session

Explicit user lifecycle
Electron renderer or browser ── validated HTTP ──▶ provider launcher + tmux worker
```

The observation path never carries captain-to-worker instructions. The lifecycle path only lets the
user start a worker with an initial task or delete that worker; it does not mediate ongoing agent
communication. There is no app command language, captain API, wrapper CLI, MCP bridge, or
provider-session translation layer.

## Components

- `packages/contracts`: strict HTTP and terminal-message schemas shared by server and web.
- `apps/server/src/domain`: conversation ports, session identity, launch command values, and errors.
- `apps/server/src/application`: conversation use cases and the captain's invariant instructions.
- `apps/server/src/infrastructure`: SQLite, process discovery, provider launch definitions, tmux,
  and PTY implementations.
- `apps/server/src/http`: loopback-only HTTP/WebSocket transport and boundary validation.
- `apps/web`: the conversation reel, agent tabs, creation dialog, and terminal view.
- `apps/desktop`: a thin Electron lifecycle shell that embeds the same server and web build.

Domain code imports neither framework code nor concrete infrastructure. ESLint rules enforce that
boundary. Server composition lives in `apps/server/src/runtime.ts`; the CLI and Electron entry
points only own their respective process lifecycles.

## Conversation create flow

1. HTTP validates provider, nullable model/thinking selections, and task.
2. The application resolves an installed provider CLI and its cached model capabilities.
3. Explicit selections are validated against the selected model; null keeps the provider default.
4. A captain launcher builds that provider's initial argument vector.
5. The tmux implementation creates and configures one retained session, then starts the captain.
6. SQLite stores the conversation only after its captain session starts.

Captain-worker communication still happens directly inside the captain through native commands.

## Explicit worker lifecycle

1. HTTP validates the worker's friendly name, provider, and initial task.
2. The application resolves that installed provider and generates a strictly managed worker session
   name owned by the conversation.
3. The provider launcher starts the real CLI with provider-default model settings; process values
   remain individual arguments until the tested tmux quoting boundary.
4. Deletion parses the managed identity, verifies that it belongs to the conversation and is a
   worker, confirms that it still exists, and then stops that exact tmux session.

Captain is rejected by the application boundary and is never offered as a deletion target in the UI.
The captain may continue creating and controlling workers directly with native commands.

## Provider capability discovery

Model metadata is obtained from each installed CLI without starting an agent turn:

- Codex uses app-server's machine-readable `model/list` protocol.
- Claude uses the official Agent SDK control channel's `supportedModels()` metadata with an empty
  streaming input.
- OpenCode uses bounded parsing of `models --verbose`. Version 1.18.21 reports model variants, but
  its persistent root TUI cannot select one at startup, so those variants are deliberately not
  exposed as selectable capabilities.

Discovery runs in the selected workspace and all process output, JSON depth, record counts, and
timeouts are bounded. Cache entries are isolated by provider, workspace, executable, and CLI
version. Concurrent requests share a single probe. A failed refresh uses last-known-good metadata
only for that exact key; without a prior catalog, the installed provider remains available in a
clearly marked provider-default-only fallback state.

The launchers receive only validated argument values. Provider-default model and reasoning are
represented by null and therefore omit the corresponding CLI flags. OpenCode uses its persistent
root TUI with `--prompt` inside tmux. In 1.18.21, `run --interactive` is parsed but ignored and the
`run` process remains one-shot, so it is never used as a persistent launch path.

## Discovery flow

The captain and the explicit lifecycle flow give each worker a strict session name:

```text
ao__<conversation-uuid>__worker__<provider>__<slug>
```

The server polls tmux, accepts only names matching that contract, and exposes them as tabs. It does
not need provider APIs or duplicated session state.

## Trust boundaries

- The server binds to `127.0.0.1` and rejects non-loopback Host and Origin headers.
- Zod validates HTTP input and every browser terminal message.
- Managed session names are generated or strictly parsed before tmux access.
- Child processes use argument arrays; the one tmux shell-command boundary uses tested POSIX quoting
  for every executable, argument, and environment value.
- Terminal input buffered during attachment has fixed byte and message limits.
- Provider authentication remains owned by installed CLIs.

## Persistence and failure behavior

SQLite stores only conversation metadata. Tmux owns live output and terminal state. If metadata
persistence fails after launch, the new captain session is removed. If a captain exits quickly,
`remain-on-exit` preserves its pane and output for inspection.
