# Releasing

AgentLab has one public npm package and two native release targets. A maintainer prepares one exact
stable version on `main`, then runs the **Start release** workflow from GitHub Actions. The workflow
waits for CI, creates an annotated `vMAJOR.MINOR.PATCH` tag, and publishes:

- `agentlab` on npm, containing the Node.js launcher and its exact release manifest;
- `agentlab-vMAJOR.MINOR.PATCH-linux-x64`;
- `agentlab-vMAJOR.MINOR.PATCH-mac-arm64`;
- one target-specific CycloneDX SBOM beside each executable; and
- `SHA256SUMS` for the GitHub release assets.

The npm launcher contains no native payload. Its generated manifest pins the filename, byte size,
and SHA-256 digest of both GitHub binaries. On first use it selects the supported host target,
downloads the matching asset, verifies it, and caches it by version. It rechecks the cached digest
before every execution. Normal cached startup performs no network request, and update checks only
run after `agentlab update` or `agentlab update --check`.

The executables are compiled by Bun and include the JavaScript runtime plus the native OpenTUI
library for their target. Each CycloneDX document combines the executable's Bun metafile with exact
package/version markers from supported upstream prebundle formats. Packaging also scans the final
executable and proves that its opaque dependency versions match the SBOM. The executables need
neither Bun nor Node.js; tmux and at least one provider CLI remain host dependencies.

## One-time publication setup

Protect `main` against force pushes and deletion, require changes to arrive through a pull request,
and require the `verify` CI check against the current branch head. In GitHub, create an environment
named `release`, restrict it to `v*` tags, and add any desired reviewer protection. Enable immutable
releases for the public repository under Settings → General → Releases. An administrator can verify
the latter through the API:

```bash
gh api --method PUT repos/RiadMefti/agentlab/immutable-releases
gh api repos/RiadMefti/agentlab/immutable-releases
```

Configure the existing npm package to trust only this repository's `release.yml` workflow and its
`release` environment. npm 11.15 or newer is required for the trust command; the release workflow
pins npm 11.19.0:

```bash
npm trust github agentlab \
  --file release.yml \
  --repo RiadMefti/agentlab \
  --env release \
  --allow-publish \
  --yes
```

The workflow needs no npm token and never changes npm account-security settings. If a GitHub
repository is replaced by another repository with the same visible owner and name, recreate only
this trusted-publisher record so npm binds it to the new repository identity.

## Cut a release

Prepare the version on a branch from current `main`. The command accepts `patch`, `minor`, `major`,
or an exact greater version. For example, `major` changes `0.2.3` to `1.0.0`:

```bash
git switch main
git pull --ff-only
git switch -c release/next
npm ci
npm run release:prepare -- major
npm run release:check -- v1.0.0
npm run verify
npm audit --omit=dev --audit-level=high
```

Review the version-only diff, including the launcher and canonical app version, commit it with the
maintainer's normal Git identity, push the branch, and merge it through a pull request after CI:

```bash
git add package.json package-lock.json apps/*/package.json packages/*/package.json apps/tui/src/version.ts
git commit -m "release: prepare v1.0.0"
git push -u origin release/next
```

After the pull request is merged and `main` CI succeeds, open **Actions → Start release → Run
workflow**, keep the branch set to `main`, and enter `1.0.0`. The coordinator refuses dirty or stale
source state, mismatched metadata, lightweight or conflicting tags, and failed CI. It safely reuses
an exact existing tag when retrying. A maintainer can still create and push an annotated tag
manually as an emergency fallback.

The coordinator dispatches `.github/workflows/release.yml` on the tag and waits for it. That
workflow:

1. Matches the tag against every workspace, lockfile entry, and `apps/tui/src/version.ts`, proves
   the annotated tag is already on `main`, and runs the complete verification and dependency audit.
2. Compiles and smoke-tests Linux x64 and Apple-silicon executables on native hosted runners.
3. Validates exact filenames, minimum sizes, executable architectures, target-specific SBOM graphs,
   and opaque binary-to-SBOM version correspondence.
4. Generates SHA-256 checksums plus GitHub build and SBOM attestations.
5. Verifies every draft asset digest, publishes the GitHub release, and confirms that release
   immutability is active.
6. Downloads the immutable public assets again, revalidates their checksums and attestations, and
   generates one npm tarball whose manifest pins those exact binaries.
7. Installs that tarball on clean Linux x64 and macOS arm64 runners, exercises first download, and
   proves the cached executable still starts with outbound HTTPS forced through an unreachable
   proxy.
8. Publishes the already-tested tarball through npm trusted publishing, downloads it back from the
   public registry, compares it byte-for-byte, and verifies its CLI version.

## Verify an installation

For npm:

```bash
npm view agentlab@0.2.0 name version repository dist.integrity
npm install --global agentlab@0.2.0
agentlab --version
agentlab --help
```

For a direct Linux download, place the executable and `SHA256SUMS` in the same directory:

```bash
sha256sum --check SHA256SUMS --ignore-missing
gh attestation verify agentlab-v0.2.0-linux-x64 \
  --repo RiadMefti/agentlab
```

On macOS, use `shasum -a 256 -c SHA256SUMS` and verify the macOS filename with the same `gh`
command. After verification, run `chmod +x` and place the executable on `PATH`. The macOS binary is
not notarized; if Gatekeeper blocks the verified download, run
`xattr -d com.apple.quarantine agentlab-v0.2.0-mac-arm64`.

## Failed releases and rollback

- A failed binary build publishes nothing. Fix the cause and rerun the workflow; an incomplete draft
  for that exact tag may be replaced.
- A published GitHub release is immutable. If a later npm step fails transiently, rerun the same
  workflow. If the workflow itself needs a fix, land that fix on `main`, wait for CI, then create an
  annotated `vX.Y.Z+npm-recovery.RUN_ID` tag using the failed release run ID. The recovery path
  accepts only the exact failed `release.yml` run for that immutable release, reverifies its assets
  and attestations, repeats both platform smoke tests, and publishes the same candidate through
  OIDC. Delete the temporary recovery tag after the recovery succeeds.
- A published npm version is immutable. The workflow treats an existing version as a rerun only when
  its public tarball is byte-for-byte identical to the tested candidate.
- Never move or reuse a published tag. Fix a bad release forward with a new patch version.
