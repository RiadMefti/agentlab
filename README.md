# Agent Orchestrator

[![CI](https://github.com/RiadMefti/agent-orchestrator/actions/workflows/ci.yml/badge.svg)](https://github.com/RiadMefti/agent-orchestrator/actions/workflows/ci.yml)

**One captain for all your coding agents.**

Direct the work from one conversation. Follow every agent the captain creates. Jump into any live
session whenever you want.

Agent Orchestrator runs each agent as its real CLI, with its existing authentication, configuration,
tools, and context. The captain coordinates the work while every worker remains directly accessible
from the same workspace.

## Workflow

1. Start a conversation and choose Codex, Claude Code, or OpenCode as the captain.
2. Select the model and thinking level, then give the captain an objective.
3. The captain delegates work by creating real agent sessions.
4. Each agent appears automatically as a tab beside the captain.
5. Switch tabs to read a session or speak directly to that agent.
6. Return to any saved conversation and continue where the team left off.

## Requirements

- Linux or macOS
- Node.js 24 or newer
- tmux
- at least one installed and authenticated CLI: `codex`, `claude`, or `opencode`

## Run the desktop app

```bash
npm ci
AO_WORKSPACE=/absolute/path/to/your/project npm run desktop
```

Packaged builds open a native workspace picker when `AO_WORKSPACE` is not set.

Build a portable Linux AppImage:

```bash
npm run desktop:package
./release/Orchestrator-0.1.0.AppImage
```

## Run in a browser

```bash
npm ci
AO_WORKSPACE=/absolute/path/to/your/project npm run dev
```

Open `http://127.0.0.1:5173`.

Run the production server build:

```bash
npm run build
AO_WORKSPACE=/absolute/path/to/your/project npm start
```

Open `http://127.0.0.1:4321`.

## Configuration

| Variable           | Default                     | Purpose                                            |
| ------------------ | --------------------------- | -------------------------------------------------- |
| `AO_WORKSPACE`     | current directory           | Workspace inherited by captain and worker sessions |
| `AO_PORT`          | `4321`                      | Loopback HTTP and WebSocket port                   |
| `AO_DATABASE_PATH` | `.data/orchestrator.sqlite` | Local conversation metadata database               |
| `AO_CODEX_BIN`     | discovered                  | Absolute Codex executable override                 |
| `AO_CLAUDE_BIN`    | discovered                  | Absolute Claude Code executable override           |
| `AO_OPENCODE_BIN`  | discovered                  | Absolute OpenCode executable override              |

The desktop app selects an available loopback port automatically. Provider credentials remain in
each CLI's local authentication store.

## Architecture

- Electron hosts the desktop window and the local application runtime.
- React and xterm.js provide the conversation and terminal workspace.
- Fastify serves the local HTTP and WebSocket boundaries on `127.0.0.1`.
- tmux owns live captain and worker sessions so they survive UI restarts.
- SQLite stores conversation metadata locally.
- Provider capability adapters discover selectable models and model-specific thinking levels from
  the installed CLIs, with local caching and stale fallback.
- Provider launch definitions start the selected captain with nullable provider defaults or its
  validated model and thinking selection, plus orchestration instructions.

See [Architecture](docs/architecture.md) and the [decision records](docs/decisions) for the system
boundaries and design rationale.

## Development

```bash
npm run verify
npm audit
```

`verify` checks formatting, strict TypeScript, linting, unit and component tests, real tmux and PTY
integration, and the production build. See [Contributing](CONTRIBUTING.md) for the engineering
contract and local setup.

## Security

The application binds to loopback, validates HTTP and WebSocket boundaries, and passes process
arguments through a tested quoting boundary. Provider credentials are managed by their respective
CLIs. See [Security](SECURITY.md) for reporting guidance.
