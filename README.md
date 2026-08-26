# Agent Orchestrator

[![CI](https://github.com/RiadMefti/agent-orchestrator/actions/workflows/ci.yml/badge.svg)](https://github.com/RiadMefti/agent-orchestrator/actions/workflows/ci.yml)
[![Release](https://github.com/RiadMefti/agent-orchestrator/actions/workflows/release.yml/badge.svg)](https://github.com/RiadMefti/agent-orchestrator/actions/workflows/release.yml)

**One captain per project folder, with all your coding agents in one fast local terminal.**

Agent Orchestrator runs Codex, Claude Code, and OpenCode as their real CLIs. They keep their
existing authentication, configuration, tools, and context. Each saved project is a named local
folder with exactly one captain. The captain may coordinate any number of workers, and every live
session remains directly accessible.

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

Download the executable for your platform from the
[latest GitHub release](https://github.com/RiadMefti/agent-orchestrator/releases/latest):

- `agent-orchestrator-vVERSION-linux-x64`
- `agent-orchestrator-vVERSION-mac-arm64`

Then make it executable and place it on your `PATH`:

```bash
chmod +x agent-orchestrator-vVERSION-PLATFORM
mv agent-orchestrator-vVERSION-PLATFORM ~/.local/bin/orchestrator
orchestrator
```

The macOS executable is not notarized. Verify its checksum and GitHub attestation first; if
Gatekeeper then blocks it, clear the download quarantine with
`xattr -d com.apple.quarantine agent-orchestrator-vVERSION-mac-arm64`.

Every release also includes `SHA256SUMS`, a target-specific CycloneDX SBOM generated from each
binary's Bun input graph and verified exact package/version markers in supported upstream
prebundles. Packaging then proves the compiled executable carries the same opaque dependency
versions. GitHub build/SBOM attestations bind those documents to the binaries. See
[Releasing](docs/releasing.md) for verification commands.

## Requirements

- Linux x64 with glibc, or macOS on Apple silicon
- `tmux`
- at least one installed and authenticated provider CLI: `codex`, `claude`, or `opencode`
- a terminal at least 90 columns by 18 rows

Install tmux with `brew install tmux` on macOS or your distribution's package manager on Linux. Bun
and Node.js are embedded/not required in release executables.

## Use

1. Run `orchestrator`. Startup never infers a project from the current directory and nothing is
   selected until you choose it.
2. Press `Alt+N`, paste any existing folder path, name the project, and choose its captain
   provider/model/thinking level. Absolute paths, relative paths, spaces, and `~/…` are supported.
3. Select projects on the left. Each project keeps exactly one captain pinned above its workers.
4. The captain can create real worker sessions, or press `Alt+W` to start one explicitly. Press
   `Enter` to focus and interact with the selected exact agent CLI.
5. Removing a project stops its managed sessions and forgets it in Orchestrator. It never deletes or
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

Source development requires Node.js 24+, Bun 1.4+, and tmux.

```bash
npm ci
npm run dev
```

Build and smoke-test the standalone executable for the current platform:

```bash
npm run package
./release/agent-orchestrator-vVERSION-linux-x64 --help
```

## Configuration

| Variable           | Default                                                 | Purpose                         |
| ------------------ | ------------------------------------------------------- | ------------------------------- |
| `AO_DATABASE_PATH` | `$XDG_DATA_HOME/agent-orchestrator/orchestrator.sqlite` | Local project metadata database |
| `AO_CODEX_BIN`     | discovered                                              | Codex executable override       |
| `AO_CLAUDE_BIN`    | discovered                                              | Claude Code executable override |
| `AO_OPENCODE_BIN`  | discovered                                              | OpenCode executable override    |

Project folders are chosen only inside the application. If the new XDG database does not exist, the
first terminal launch reuses an existing desktop-era database in place; it never copies or deletes
that file merely to migrate paths. `AO_DATABASE_PATH` always takes precedence. Provider credentials
remain in each CLI's own local authentication store.

## Architecture

- `apps/tui` owns the OpenTUI/React terminal layout and the one selected terminal attachment.
- `packages/runtime/src/application` owns validated use cases independent of UI and infrastructure.
- `packages/runtime/src/domain` owns conversation, session, command, and terminal ports.
- `packages/runtime/src/infrastructure` implements SQLite, provider discovery/launching, tmux, and
  Bun's native PTY.
- `packages/contracts` owns provider, conversation, and session schemas shared across local layers.

The embedded terminal uses native VT parsing, true color, selection, resize, paste, cursor state,
and a bounded 20,000-line scrollback. Focused tests enforce multi-megabyte ANSI throughput and the
one-attachment invariant. See [Architecture](docs/architecture.md) for the complete boundaries.

## Development

```bash
npm run verify
npm audit --omit=dev
```

`verify` checks formatting, strict TypeScript, linting, unit/component tests, real tmux and PTY
integration, the production build, and the standalone executable. See
[Contributing](CONTRIBUTING.md) for the engineering contract.

## Security

Agent Orchestrator opens no network listener. Managed session identities and all local command input
are validated before process boundaries; child processes receive argument arrays, and the one tmux
shell-command boundary uses tested POSIX quoting. Published executables are checksummed, attested,
and immutable. See [Security](SECURITY.md) for reporting guidance.
