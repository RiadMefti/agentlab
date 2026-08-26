# AgentLab

One captain per project folder, with Codex, Claude Code, and OpenCode in one local terminal.

AgentLab lets you switch between projects and run multiple coding-agent sessions while keeping their
real CLIs accessible. Each project points to a folder on your machine. It has one captain and any
number of workers.

## Install

```bash
npm install --global agentlab
agentlab
```

Run `agentlab` from any directory. The app opens to the project picker and waits for you to choose a
folder. On first launch, the npm package downloads the matching AgentLab executable from GitHub and
caches it. The installer shows the percentage, downloaded size, and download speed while it works.
Later launches use the cached executable.

## Requirements

- Linux x64 with glibc, or macOS on Apple silicon
- Node.js 20 or newer
- `tmux`
- At least one installed and authenticated provider CLI: `codex`, `claude`, or `opencode`
- A terminal at least 90 columns by 18 rows

Install tmux with `brew install tmux` on macOS or your Linux distribution's package manager.

## Start a project

1. Run `agentlab`.
2. Press `Alt+N` and enter the path to an existing folder. The folder can be anywhere on your
   machine.
3. Name the project and choose its captain provider, model, and reasoning level.
4. Add workers with `Alt+W` when the captain needs more sessions.
5. Switch projects from the left sidebar. Each project keeps its captain and workers together.

Removing a project stops its managed sessions and forgets it in AgentLab. The project folder and its
files stay untouched.

## Keys

| Key                       | Action                                        |
| ------------------------- | --------------------------------------------- |
| `Alt+1`, `Alt+2`, `Alt+3` | Focus projects, terminal, or agents           |
| `Up`, `Down`, `Enter`     | Navigate a focused sidebar and enter terminal |
| `Alt+N`                   | Add a project folder                          |
| `Alt+W`                   | Add a worker to the selected project          |
| `Delete`                  | Remove the selected project or worker         |
| `Alt+C`                   | Copy the terminal selection                   |
| `Alt+Q`                   | Quit AgentLab                                 |

## Updates

AgentLab updates only when you ask it to:

```bash
agentlab update --check
agentlab update
```

Normal startup does not check for updates.

## Local data

AgentLab opens no network listener. It stores the project list in a local SQLite database, keeps
provider credentials in each CLI's existing authentication store, and runs agent sessions through
tmux.

Read the [documentation](https://github.com/RiadMefti/agentlab#readme), browse
[releases](https://github.com/RiadMefti/agentlab/releases), or
[report a problem](https://github.com/RiadMefti/agentlab/issues).
