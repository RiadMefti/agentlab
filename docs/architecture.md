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
browser ◀── WebSocket ── PTY ──▶ exact tmux session
```

The second path never carries captain-to-worker instructions. There is no app command language,
captain API, wrapper CLI, MCP bridge, or provider-session translation layer.

## Components

- `packages/contracts`: strict HTTP and terminal-message schemas shared by server and web.
- `apps/server/src/domain`: conversation ports, session identity, launch command values, and errors.
- `apps/server/src/application`: conversation use cases and the captain's invariant instructions.
- `apps/server/src/infrastructure`: SQLite, process discovery, one-time captain launch definitions,
  tmux, and PTY implementations.
- `apps/server/src/http`: loopback-only HTTP/WebSocket transport and boundary validation.
- `apps/web`: the conversation reel, agent tabs, creation dialog, and terminal view.

Domain code imports neither framework code nor concrete infrastructure. ESLint rules enforce that
boundary. Composition happens only in `apps/server/src/main.ts`.

## Create flow

1. HTTP validates provider, model, thinking level, and task.
2. The application resolves an installed provider CLI.
3. A captain launcher builds that provider's initial argument vector.
4. The tmux implementation creates and configures one retained session, then starts the captain.
5. SQLite stores the conversation only after its captain session starts.

Captain launchers are not used again. Worker creation and captain-worker communication happen
directly inside the captain through native commands.

## Discovery flow

The captain gives each worker a strict session name:

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
