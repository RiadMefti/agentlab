# Releasing

Stable releases are built from annotated `vMAJOR.MINOR.PATCH` tags already present on `main`. The
workflow publishes these fixed assets:

- `Orchestrator-linux-x64.AppImage`
- `Orchestrator-mac-arm64.dmg`
- `Orchestrator-MAJOR.MINOR.PATCH.cdx.json`
- `SHA256SUMS`

The filenames stay stable so the README's `/releases/latest/download/…` links always resolve to the
newest release.

Packaged apps validate GitHub's latest stable release metadata at launch and once daily. A newer
version reveals a button that opens this repository's fixed `/releases/latest` page; no binary is
downloaded or installed by the app.

## One-time GitHub setup

Create a GitHub environment named `release` and restrict deployment branches and tags to `v*`. The
environment protects the final publication job; it does not require Apple credentials or other
release secrets.

## macOS distribution

The Apple-silicon DMG is intentionally built without an Apple Developer identity and is not
notarized. The workflow explicitly disables signing discovery and fails if the packaged app
unexpectedly contains a code signature.

On first launch, macOS blocks the app because it cannot verify the developer:

1. Try to open `Orchestrator.app` once.
2. Open **System Settings → Privacy & Security**.
3. Choose **Open Anyway**, then confirm **Open**.

This creates an exception for Orchestrator. Never disable Gatekeeper globally. A managed Mac may
prevent the override; in that case the administrator must allow the app.

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
4. Build a native unsigned Apple-silicon DMG on an arm64 macOS runner without release credentials.
5. Verify each app is unsigned, has the expected native architecture, and survives DMG integrity and
   read-only mount checks.
6. Validate the exact artifact set and container formats, then generate checksums, a CycloneDX SBOM,
   SLSA provenance, and an SBOM attestation.
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
command. Verify the download before using the **Open Anyway** procedure above.

## Failed releases and rollback

- A failed build publishes nothing. Fix the cause and rerun the workflow; an incomplete draft for
  that exact tag is replaced safely.
- Re-running a published tag never replaces its binaries. The workflow downloads the immutable
  assets and re-verifies their exact names, checksums, container formats, and attestations.
- A published release is immutable. Never move or reuse its tag and never replace its binaries.
- If a published version is bad, fix forward with a new patch version. Mark the old release clearly
  in its notes if users should avoid it.
