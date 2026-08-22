# Security

This application exposes interactive local shell sessions. It binds to `127.0.0.1` and validates
Host and Origin headers. Do not expose its HTTP or WebSocket server through a network listener,
reverse proxy, or public tunnel.

Provider credentials remain owned by their installed CLIs. The application does not read, copy, or
store them.

Install desktop binaries only from this repository's GitHub Releases. Each published release is
immutable and includes SHA-256 checksums plus GitHub build and SBOM attestations; verification
commands are documented in [Releasing](docs/releasing.md#verify-a-download).

The macOS DMG intentionally has no valid Apple Developer signature or notarization. Verify its
checksum and GitHub attestation before approving the app through macOS Privacy & Security.

Please report security issues privately to the repository owner rather than opening a public issue.
