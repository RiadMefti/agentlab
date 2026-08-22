# Agent Orchestrator

A lean, local interface for one captain and the real coding-agent sessions it supervises.

The MVP does six things:

- saves conversations;
- starts one Codex, Claude Code, or OpenCode captain per conversation;
- lets you choose the captain's model and thinking level;
- tells the captain to orchestrate instead of implement;
- discovers every worker the captain creates as an agent tab;
- attaches you directly to the captain or worker's exact terminal session.

## No captain control layer

The app does not provide a command API, wrapper CLI, MCP server, or provider protocol to the
captain. The captain runs raw `tmux`, `codex`, `claude`, and `opencode` commands itself. The
server's provider-specific launch definitions are used once: to start the captain with the chosen
model, thinking level, and orchestration instructions.

The server talks to tmux only for the user interface: it lists tagged sessions, replays retained
output, and attaches the browser to the selected session through a PTY.

## Requirements

- Linux or macOS
- Node.js 24 or newer
- tmux
- at least one installed and authenticated CLI: `codex`, `claude`, or `opencode`

## Run as a desktop app

```bash
npm install
AO_WORKSPACE=/absolute/path/to/your/project npm run desktop
```

Electron starts the loopback server on an ephemeral port and opens the existing interface in a
sandboxed native window. During local development it reuses `apps/server/.data/orchestrator.sqlite`.
Packaged builds keep the database in Electron's per-user application-data directory and ask for the
agent workspace when `AO_WORKSPACE` is not set.

Build a portable Linux AppImage with:

```bash
npm run desktop:package
```

## Run in a browser

```bash
npm install
AO_WORKSPACE=/absolute/path/to/your/project npm run dev
```

Open `http://127.0.0.1:5173` during development.

For the production build:

```bash
npm run build
AO_WORKSPACE=/absolute/path/to/your/project npm start
```

Open `http://127.0.0.1:4321`.

## Configuration

| Variable           | Default                     | Purpose                                            |
| ------------------ | --------------------------- | -------------------------------------------------- |
| `AO_WORKSPACE`     | current directory           | Workspace inherited by captain and worker sessions |
| `AO_PORT`          | `4321`                      | Loopback HTTP/WebSocket port                       |
| `AO_DATABASE_PATH` | `.data/orchestrator.sqlite` | Local conversation metadata database               |
| `AO_CODEX_BIN`     | discovered                  | Absolute Codex executable override                 |
| `AO_CLAUDE_BIN`    | discovered                  | Absolute Claude Code executable override           |
| `AO_OPENCODE_BIN`  | discovered                  | Absolute OpenCode executable override              |

Electron defaults `AO_PORT` to an available ephemeral port while still honoring an explicit value.

Provider credentials stay in each CLI's existing local authentication store. The app never reads or
copies them.

## Session lifecycle

Tmux owns live terminal state. Sessions survive browser and server restarts while the tmux server is
alive. A machine reboot ends those tmux sessions; provider-specific resume automation is outside
this MVP.

## Quality checks

```bash
npm run verify
npm audit
```

`verify` runs formatting, strict type checking, linting, all unit/component tests, real tmux
integration tests, and the production build.

See [the architecture](docs/architecture.md), [decision records](docs/decisions), and
[contribution guide](CONTRIBUTING.md).
