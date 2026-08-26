# Releasing

Stable releases are built from annotated `vMAJOR.MINOR.PATCH` tags already present on `main`. The
workflow publishes this exact set:

- `agent-orchestrator-vMAJOR.MINOR.PATCH-linux-x64`
- `agent-orchestrator-vMAJOR.MINOR.PATCH-mac-arm64`
- `agent-orchestrator-vMAJOR.MINOR.PATCH-linux-x64.cdx.json`
- `agent-orchestrator-vMAJOR.MINOR.PATCH-mac-arm64.cdx.json`
- `SHA256SUMS`

The executables are compiled by Bun and include the JavaScript runtime plus the native OpenTUI
library for their target. Each CycloneDX document combines that executable's Bun metafile with exact
package/version markers from supported upstream prebundle formats: Bun module provenance comments
and Claude Agent SDK's bound Stainless runtime identity. A known opaque bundle with a changed or
missing marker fails packaging instead of silently disappearing from the inventory. The completed
executable is then scanned in bounded overlapping windows and must contain the same Anthropic SDK
version linked beneath Claude Agent SDK in the SBOM. The result covers direct bundle inputs and
verified dependencies already compiled into those inputs while remaining specific to the platform
binary. The executables do not require a system Bun or Node.js installation. tmux and at least one
provider CLI remain host dependencies.

## One-time GitHub setup

Create a GitHub environment named `release` and restrict deployment tags to `v*`. The environment
protects the write-capable publication job. Building and validation jobs have read-only repository
permissions and require no signing credentials.

## Cut a release

Start from a clean, current `main` branch with Node.js 24, Bun 1.4, and tmux installed:

```bash
git switch main
git pull --ff-only
npm ci
npm run release:prepare -- 0.2.0
npm run release:check -- v0.2.0
npm run verify
npm audit --omit=dev --audit-level=high
```

Review the version-only diff, including the canonical app version source, then commit and let CI
pass before creating the tag:

```bash
git add package.json package-lock.json apps/*/package.json packages/*/package.json apps/tui/src/version.ts
git commit -m "chore: prepare v0.2.0"
git push origin main
git tag -a v0.2.0 -m "Agent Orchestrator v0.2.0"
git push origin v0.2.0
```

The tag starts `.github/workflows/release.yml`, which:

1. Matches the tag against every workspace, lockfile entry, and `apps/tui/src/version.ts`, then
   proves the tagged commit is already on `main`.
2. Runs formatting, strict type checking, linting, all tests including real tmux/Bun PTY
   integration, the production build, standalone packaging, and the production dependency audit.
3. Compiles and smoke-tests a Linux x64 executable on Ubuntu.
4. Compiles and smoke-tests an Apple-silicon executable on a native arm64 macOS runner.
5. Validates the exact asset set, minimum sizes, Linux ELF architecture, macOS Mach-O architecture,
   each target-specific CycloneDX bundle/runtime graph, and opaque binary-to-SBOM version
   correspondence.
6. Generates exact SHA-256 checksums plus GitHub build-provenance and SBOM attestations.
7. Uploads a complete draft, compares GitHub's asset digests with the local files, and only then
   publishes it as the latest release.

## Verify a download

Download the executable and `SHA256SUMS` into the same directory. On Linux:

```bash
sha256sum --check SHA256SUMS --ignore-missing
gh attestation verify agent-orchestrator-v0.2.0-linux-x64 \
  --repo RiadMefti/agent-orchestrator
```

On macOS, use `shasum -a 256 -c SHA256SUMS` and verify the macOS filename with the same `gh`
command. The artifact itself is a command-line executable, not an application bundle; after
verification, run `chmod +x` and place it on your `PATH`. The macOS executable is not notarized; if
Gatekeeper blocks the verified download, run
`xattr -d com.apple.quarantine agent-orchestrator-v0.2.0-mac-arm64`.

## Failed releases and rollback

- A failed build publishes nothing. Fix the cause and rerun the workflow; an incomplete draft for
  that exact tag may be safely replaced.
- Re-running a published tag never replaces its assets. The workflow downloads the immutable release
  and revalidates names, checksums, executable formats, and attestations.
- Never move or reuse a published tag and never replace its binaries.
- Fix a bad published version forward with a new patch release. Mark the old release clearly if
  users should avoid it.
