# Security

AgentLab exposes interactive local shell sessions inside the current terminal. It opens no HTTP,
WebSocket, or other network listener. Do not modify or wrap it to expose terminal sessions over a
reverse proxy, public tunnel, or remote transport.

The npm launcher makes an outbound HTTPS request to GitHub only when its versioned executable is not
already cached. It verifies the package-pinned size and SHA-256 digest before activation and again
before every execution. `agentlab update` and `agentlab update --check` contact the npm registry
only when explicitly invoked; there is no background update check or telemetry.

Provider credentials remain owned by installed CLIs. The application does not read, copy, or store
them. Conversation metadata stays in local SQLite; live terminal state stays in tmux.

Managed session names, local commands, provider selections, and terminal dimensions are validated
before infrastructure boundaries. Processes receive argument arrays. The only tmux command-string
boundary applies tested POSIX quoting to executable, argument, and environment values.

Install through the public `agentlab` npm package or this repository's GitHub Releases. Every
published release is immutable and includes SHA-256 checksums plus GitHub build and target-specific
SBOM attestations. The npm package is published from the protected release workflow with OIDC and
provenance. Verification commands are documented in
[Releasing](docs/releasing.md#verify-a-download).

Please report security issues privately to the repository owner instead of opening a public issue.
