# Releasing

Stable releases are built from annotated `vMAJOR.MINOR.PATCH` tags already present on `main`. The
workflow publishes these fixed assets:

- `Orchestrator-linux-x64.AppImage`
- `Orchestrator-mac-arm64.dmg`
- `Orchestrator-mac-x64.dmg`
- `Orchestrator-MAJOR.MINOR.PATCH.cdx.json`
- `SHA256SUMS`

The filenames stay stable so the README's `/releases/latest/download/…` links always resolve to the
newest release.

## One-time Apple setup

Direct macOS distribution requires an Apple Developer Program membership, a **Developer ID
Application** certificate, and an App Store Connect API key. Export the certificate and private key
from Keychain Access as a password-protected `.p12` file.

Create a GitHub environment named `release`, restrict it to tags matching `v*`, and configure these
environment secrets:

| Secret                       | Value                                      |
| ---------------------------- | ------------------------------------------ |
| `MACOS_CERTIFICATE_BASE64`   | Base64-encoded `.p12` file                 |
| `MACOS_CERTIFICATE_PASSWORD` | Password used when exporting the `.p12`    |
| `APPLE_API_KEY_BASE64`       | Base64-encoded App Store Connect `.p8` key |
| `APPLE_API_KEY_ID`           | App Store Connect API key ID               |
| `APPLE_API_ISSUER`           | App Store Connect issuer UUID              |
| `APPLE_TEAM_ID`              | Ten-character Apple Developer team ID      |

The binary files can be uploaded without writing their contents to shell history:

```bash
openssl base64 -A -in DeveloperIDApplication.p12 \
  | gh secret set MACOS_CERTIFICATE_BASE64 --env release
openssl base64 -A -in AuthKey_KEYID.p8 \
  | gh secret set APPLE_API_KEY_BASE64 --env release
```

Run `gh secret set NAME --env release` for each remaining value and enter it at the hidden prompt.
Never commit certificates, private keys, passwords, or notarization credentials.

## Cut a release

Start from a clean, current `main` branch:

```bash
git switch main
git pull --ff-only
npm ci
npm run release:prepare -- 0.2.0
npm run release:check -- v0.2.0
npm run verify
```

Review the version-only diff, then commit and let `main` CI pass before creating the tag:

```bash
git add package.json package-lock.json apps/*/package.json packages/*/package.json
git commit -m "chore: prepare v0.2.0"
git push origin main
git tag -a v0.2.0 -m "Orchestrator v0.2.0"
git push origin v0.2.0
```

The tag starts `.github/workflows/release.yml`. It performs the following gates before publication:

1. Match the tag against every package and lockfile version, and prove its commit is on `main`.
2. Run formatting, type checking, linting, tests, the production build, and the production audit.
3. Build and launch-smoke-test the Linux AppImage on Ubuntu 22.04.
4. Build native Apple-silicon and Intel DMGs on matching macOS runners.
5. Fail if Apple credentials, Developer ID signing, hardened runtime, notarization, Gatekeeper
   acceptance, the expected team ID, or the stapled ticket cannot be verified.
6. Validate the exact artifact set and container signatures, then generate checksums, a CycloneDX
   SBOM, SLSA provenance, and an SBOM attestation.
7. Upload everything to a draft, compare GitHub's asset digests with the local files, and only then
   publish it as the latest release.

## Verify a download

Download an artifact and `SHA256SUMS` into the same directory, then run:

```bash
sha256sum --check SHA256SUMS --ignore-missing
gh attestation verify Orchestrator-linux-x64.AppImage \
  --repo RiadMefti/agent-orchestrator
```

On macOS, use `shasum -a 256 -c SHA256SUMS` and replace the artifact name in the attestation
command.

## Failed releases and rollback

- A failed build publishes nothing. Fix the cause and rerun the workflow; an incomplete draft for
  that exact tag is replaced safely.
- A published release is immutable. Never move or reuse its tag and never replace its binaries.
- If a published version is bad, fix forward with a new patch version. Mark the old release clearly
  in its notes if users should avoid it.
