#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const usage =
  "Usage: node scripts/release-notes-baseline.ts CURRENT_TAG RELEASES_JSON [--root PATH]";
const STABLE_TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;

interface ReleaseCandidate {
  readonly publishedTimestamp: number;
  readonly tag: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function flattenReleasePages(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error("GitHub releases response must be an array.");
  const entries: unknown[] = [];
  const pages = value.every(Array.isArray);
  const flat = value.every((entry) => !Array.isArray(entry));
  if (!pages && !flat) throw new Error("GitHub releases response mixes pages and releases.");
  if (pages) {
    for (const page of value) {
      if (!Array.isArray(page)) throw new Error("GitHub releases response has an invalid page.");
      for (const entry of page) entries.push(entry as unknown);
    }
  } else {
    for (const entry of value) entries.push(entry as unknown);
  }
  if (!entries.every(isObject)) {
    throw new Error("GitHub releases response contains an invalid release entry.");
  }
  return entries;
}

function stableVersionFromTag(tag: string): readonly [bigint, bigint, bigint] {
  const match = STABLE_TAG_PATTERN.exec(tag);
  if (!match?.[1] || !match[2] || !match[3]) {
    throw new Error(`Invalid stable release tag: ${tag}. Expected vMAJOR.MINOR.PATCH.`);
  }
  return [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])];
}

function compareVersions(
  left: readonly [bigint, bigint, bigint],
  right: readonly [bigint, bigint, bigint]
): number {
  for (let index = 0; index < left.length; index += 1) {
    const leftPart = left[index];
    const rightPart = right[index];
    if (leftPart === undefined || rightPart === undefined) {
      throw new Error("Stable versions must contain exactly three components.");
    }
    if (leftPart > rightPart) return 1;
    if (leftPart < rightPart) return -1;
  }
  return 0;
}

/** Selects the newest published stable release, ignoring tags without a published release. */
export function selectReleaseNotesBaseline(currentTag: string, response: unknown): string | null {
  const currentVersion = stableVersionFromTag(currentTag);
  const candidates: ReleaseCandidate[] = [];

  for (const [index, release] of flattenReleasePages(response).entries()) {
    const draft = release.draft;
    const prerelease = release.prerelease;
    const publishedAt = release.published_at;
    if (typeof draft !== "boolean" || typeof prerelease !== "boolean") {
      throw new Error(`GitHub release ${String(index)} has invalid publication flags.`);
    }
    if (publishedAt !== null && typeof publishedAt !== "string") {
      throw new Error(`GitHub release ${String(index)} has an invalid published_at value.`);
    }
    if (draft || prerelease || publishedAt === null) continue;

    const tag = release.tag_name;
    if (typeof tag !== "string") {
      throw new Error(`Published GitHub release ${String(index)} has an invalid tag name.`);
    }
    const publishedTimestamp = Date.parse(publishedAt);
    if (!Number.isFinite(publishedTimestamp)) {
      throw new Error(`Published GitHub release ${tag} has an invalid publication time.`);
    }
    stableVersionFromTag(tag);
    candidates.push({ publishedTimestamp, tag });
  }

  candidates.sort(
    (left, right) =>
      right.publishedTimestamp - left.publishedTimestamp || right.tag.localeCompare(left.tag)
  );
  const baseline = candidates[0]?.tag;
  if (baseline === undefined) return null;
  if (compareVersions(stableVersionFromTag(baseline), currentVersion) >= 0) {
    throw new Error(`Release-notes baseline ${baseline} must precede ${currentTag}.`);
  }
  return baseline;
}

function runGit(root: string, arguments_: readonly string[]): string {
  const result = spawnSync("git", arguments_, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status === 0) return result.stdout.trim();
  const detail = result.stderr.trim() || result.stdout.trim() || `exit ${String(result.status)}`;
  throw new Error(`git ${arguments_[0] ?? "command"} failed: ${detail}`);
}

function validateGitBaseline(root: string, baseline: string, currentTag: string): void {
  for (const tag of [baseline, currentTag]) {
    const ref = `refs/tags/${tag}`;
    if (runGit(root, ["cat-file", "-t", ref]) !== "tag") {
      throw new Error(`Release-notes tag ${tag} must be annotated.`);
    }
  }
  const result = spawnSync(
    "git",
    ["merge-base", "--is-ancestor", `${baseline}^{commit}`, `${currentTag}^{commit}`],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
  );
  if (result.status === 1) {
    throw new Error(`Release-notes baseline ${baseline} is not an ancestor of ${currentTag}.`);
  }
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${String(result.status)}`;
    throw new Error(`git merge-base failed: ${detail}`);
  }
}

async function main(): Promise<void> {
  const arguments_ = process.argv.slice(2);
  const currentTag = arguments_[0];
  const releasesPath = arguments_[1];
  let root = process.cwd();
  if (arguments_[2] === "--root" && arguments_[3] && arguments_.length === 4) {
    root = resolve(process.cwd(), arguments_[3]);
  } else if (arguments_.length !== 2) {
    throw new Error(usage);
  }
  if (!currentTag || !releasesPath) throw new Error(usage);
  stableVersionFromTag(currentTag);
  const response = JSON.parse(
    await readFile(resolve(process.cwd(), releasesPath), "utf8")
  ) as unknown;
  const baseline = selectReleaseNotesBaseline(currentTag, response);
  if (baseline !== null) validateGitBaseline(root, baseline, currentTag);
  process.stdout.write(`${baseline ?? ""}\n`);
}

const entry = process.argv[1];
if (entry !== undefined && fileURLToPath(import.meta.url) === resolve(entry)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
