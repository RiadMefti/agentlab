# AgentLab

One captain for all your coding agents in a fast local terminal UI.

```bash
npm install --global agentlab
agentlab
```

The npm launcher downloads the matching AgentLab executable on first use, verifies its
package-pinned size and SHA-256 digest, and caches it by version. It rechecks the cached digest
before execution. Linux x64 with glibc and Apple-silicon macOS are supported. AgentLab requires
`tmux` and at least one authenticated provider CLI: Codex, Claude Code, or OpenCode.

Use `agentlab update` for an explicit update or `agentlab update --check` to check without changing
the installation. Normal cached startup performs no update request.

See [the AgentLab repository](https://github.com/RiadMefti/agentlab) for usage, release checksums,
SBOMs, and build provenance.
