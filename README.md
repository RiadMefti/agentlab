# AgentLab

[![CI](https://github.com/RiadMefti/agentlab/actions/workflows/ci.yml/badge.svg)](https://github.com/RiadMefti/agentlab/actions/workflows/ci.yml)
[![Release](https://github.com/RiadMefti/agentlab/actions/workflows/release.yml/badge.svg)](https://github.com/RiadMefti/agentlab/actions/workflows/release.yml)

**One captain per project folder, with all your coding agents in one fast local terminal.**

AgentLab runs Codex, Claude Code, and OpenCode as their real CLIs. They keep their existing
authentication, configuration, tools, and context. Each saved project is a named local folder with
exactly one captain. The captain may coordinate any number of workers, and every live session
remains directly accessible.

```text
┌─ PROJECTS ───────┬─ SELECTED AGENT TERMINAL ───────────────┬─ AGENTS ─────────┐
│ named folders    │ full ANSI/PTY interaction               │ CAPTAIN (pinned) │
│                  │                                         │ WORKERS           │
└──────────────────┴─────────────────────────────────────────┴───────────────────┘
```

There is no web server, browser UI, Electron shell, or remote mode. The application is a
single-process terminal compositor that calls the local application layer directly. tmux owns the
durable sessions; the UI attaches exactly one PTY to the selected agent.

## Install

Install the single public package, then start the app from anywhere:

```bash
npm install --global agentlab
agentlab
```

The npm package downloads the matching AgentLab executable from GitHub on first use, shows live
download progress, and caches it by version. Later launches use the cached executable and make no
update request. Updates are always explicit:

```bash
agentlab update --check
agentlab update
```

You can alternatively download an executable from the
[latest GitHub release](https://github.com/RiadMefti/agentlab/releases/latest):

- `agentlab-vVERSION-linux-x64`
- `agentlab-vVERSION-mac-arm64`

Then make it executable and place it on your `PATH`:

```bash
chmod +x agentlab-vVERSION-PLATFORM
mv agentlab-vVERSION-PLATFORM ~/.local/bin/agentlab
agentlab
```

The macOS executable is not notarized. If Gatekeeper blocks a direct download, clear the download
quarantine with `xattr -d com.apple.quarantine agentlab-vVERSION-mac-arm64`.

## Requirements

- Linux x64 with glibc, or macOS on Apple silicon
- Node.js 20 or newer when installing through npm; direct executables do not need Node.js or Bun
- `tmux` 3.2 or newer
- at least one installed and authenticated provider CLI: `codex`, `claude`, or `opencode`
- a terminal at least 90 columns by 18 rows

Install tmux with `brew install tmux` on macOS or your distribution's package manager on Linux.

## Use

1. Run `agentlab`. Startup never infers a project from the current directory and nothing is selected
   until you choose it.
2. Press `Alt+N`, paste any existing folder path, name the project, and choose its captain
   provider/model/thinking level. Absolute paths, relative paths, spaces, and `~/…` are supported.
3. Select projects on the left. Each project keeps exactly one captain pinned above its workers.
4. The captain can create real worker sessions, or press `Alt+W` to start one explicitly. Press
   `Enter` to focus and interact with the selected exact agent CLI.
5. Removing a project stops its managed sessions and forgets it in AgentLab. It never deletes or
   modifies the project folder.

### Keys

| Key                       | Action                                        |
| ------------------------- | --------------------------------------------- |
| `Alt+1`, `Alt+2`, `Alt+3` | Focus projects, terminal, or agents           |
| `Up`, `Down`, `Enter`     | Navigate a focused sidebar and enter terminal |
| `Alt+N`                   | Add a project folder                          |
| `Alt+W`                   | New worker in the selected project            |
| `Delete`                  | Remove the selected project or worker         |
| `Alt+C`                   | Copy the terminal selection through OSC 52    |
| `Alt+Q`                   | Quit the UI                                   |

Control-key input, including `Ctrl+C`, goes to the selected agent when the terminal is focused. The
Alt shortcuts are reserved for application controls.

## Run from source

Source development requires Node.js 24+, Bun 1.4+, and tmux 3.2+.

```bash
npm ci
npm run dev
```

Build and smoke-test the standalone executable for the current platform:

```bash
npm run package
./release/agentlab-vVERSION-linux-x64 --help
```

## Configuration

| Variable                 | Default                                   | Purpose                         |
| ------------------------ | ----------------------------------------- | ------------------------------- |
| `AGENTLAB_CACHE_PATH`    | `$XDG_CACHE_HOME/agentlab`                | npm launcher binary cache       |
| `AGENTLAB_DATABASE_PATH` | `$XDG_DATA_HOME/agentlab/agentlab.sqlite` | Local project metadata database |
| `AGENTLAB_CODEX_BIN`     | discovered                                | Codex executable override       |
| `AGENTLAB_CLAUDE_BIN`    | discovered                                | Claude Code executable override |
| `AGENTLAB_OPENCODE_BIN`  | discovered                                | OpenCode executable override    |

Project folders are chosen only inside the application. `AGENTLAB_DATABASE_PATH` always takes
precedence. Provider credentials remain in each CLI's own local authentication store.

## Architecture

- `apps/tui` owns the OpenTUI/React terminal layout and the one selected terminal attachment.
- `packages/runtime/src/application` owns validated use cases independent of UI and infrastructure.
- `packages/runtime/src/domain` owns conversation, session, command, and terminal ports.
- `packages/runtime/src/infrastructure` implements SQLite, provider discovery/launching, tmux, and
  Bun's native PTY.
- `packages/runtime/src/local-runtime.ts` composes the interactive runtime;
  `local-factory-broker.ts` is a separate broker-only composition exported only through
  `@agentlab/runtime/factory-broker`.
- `packages/contracts` owns provider, conversation, session, and dormant software-factory schemas
  shared across local layers.

Cross-package imports use public entry points, inner runtime layers never depend outward, and the
product source graph must remain acyclic. `npm run architecture:check` enforces those rules. The
embedded terminal uses native VT parsing, true color, selection, resize, paste, cursor state, and a
16 MiB scrollback byte budget. Tmux separately retains up to 20,000 history lines; the number of
lines held by the embedded terminal varies with encoded content. Focused tests enforce
multi-megabyte ANSI throughput and the one-attachment invariant. See
[Architecture](docs/architecture.md) for the complete boundaries.

The repository also contains a tested, staged software-factory safety kernel and draft-PR broker. It
is not connected to the interactive runtime, scheduled, or enabled. The only product-facing operator
action is a separate, non-authorizing `agentlab factory broker-preflight --config <absolute-path>`
command that makes no GitHub mutation; authority remains default-off, and the CLI cannot enable it
or open a PR. Provider-neutral per-run cost accounting is policy-pinned and fail-closed, but its
shipped live rate card is intentionally empty. Owner-only broker config v2 can reference a separate
strict cost-policy file without exposing broker credentials to future workers. Normal database
migration creates only inert local ledger tables. See
[ADR 0006](docs/decisions/0006-local-software-factory-control-plane.md) for implemented controls,
activation blockers, and later phases.

## Development

```bash
npm run verify
npm audit --omit=dev
```

`verify` checks formatting, architecture boundaries and cycles, strict TypeScript, linting,
unit/component tests, real tmux and PTY integration, the production build, and the standalone
executable. See [Contributing](CONTRIBUTING.md) for the engineering contract.

## Security

AgentLab opens no network listener. The npm launcher connects to GitHub only when its exact binary
is missing and to npm when you explicitly request an update. The separate factory broker preflight
connects to GitHub only when explicitly invoked with an owner-only local config; it performs no
remote write. Managed session identities and all local command input are validated before process
boundaries; child processes receive argument arrays, and the one tmux shell-command boundary uses
tested POSIX quoting. Published executables are immutable. See [Security](SECURITY.md) for reporting
guidance.
