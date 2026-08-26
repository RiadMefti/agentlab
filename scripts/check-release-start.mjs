import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { checkRelease, stableVersionFromTag } from "./release-versions.mjs";

const usage =
  "Usage: npm run release:start:check -- MAJOR.MINOR.PATCH --base-ref REF [--root PATH] [--json]";
const SAFE_GIT_REF = /^(?!.*(?:\.\.|\/\/|@\{))[A-Za-z0-9][A-Za-z0-9._/-]*$/u;

/**
 * @typedef {object} ReleaseStartOptions
 * @property {string} baseRef
 * @property {boolean} json
 * @property {string} root
 * @property {string} version
 */

/**
 * @param {string[]} arguments_
 * @returns {ReleaseStartOptions}
 */
function parseArguments(arguments_) {
  /** @type {string | undefined} */
  let baseRef;
  let json = false;
  let root = process.cwd();
  /** @type {string | undefined} */
  let version;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--base-ref" || argument === "--root") {
      const value = arguments_[index + 1];
      if (!value) throw new Error(`${usage}\n${argument} requires a value.`);
      if (argument === "--base-ref") baseRef = value;
      else root = resolve(process.cwd(), value);
      index += 1;
      continue;
    }
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (!argument || argument.startsWith("-")) {
      throw new Error(`${usage}\nUnknown option: ${argument ?? ""}`);
    }
    if (version !== undefined) throw new Error(`${usage}\nOnly one version may be supplied.`);
    version = argument;
  }

  if (!version || !baseRef) throw new Error(usage);
  if (!SAFE_GIT_REF.test(baseRef)) throw new Error(`Invalid base Git ref: ${baseRef}.`);
  return { baseRef, json, root, version };
}

/**
 * @param {string} root
 * @param {string[]} arguments_
 * @returns {string}
 */
function runGit(root, arguments_) {
  const result = spawnSync("git", arguments_, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status === 0) return result.stdout.trim();
  const detail = result.stderr.trim() || result.stdout.trim() || `exit ${String(result.status)}`;
  throw new Error(`git ${arguments_[0] ?? "command"} failed: ${detail}`);
}

/**
 * @param {string} root
 * @param {string} ref
 * @returns {boolean}
 */
function hasGitRef(root, ref) {
  const result = spawnSync("git", ["show-ref", "--verify", "--quiet", ref], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (result.status === 0) return true;
  if (result.status === 1) return false;
  const detail = result.stderr.trim() || result.stdout.trim() || `exit ${String(result.status)}`;
  throw new Error(`git show-ref failed: ${detail}`);
}

/**
 * @param {ReleaseStartOptions} options
 * @returns {Promise<{commit: string, tag: string, tagState: "existing" | "missing", version: string}>}
 */
async function inspectReleaseStart({ baseRef, root, version }) {
  const tag = `v${version}`;
  stableVersionFromTag(tag);
  await checkRelease(root, tag);

  const status = runGit(root, ["status", "--porcelain=v1", "--untracked-files=normal"]);
  if (status.length > 0) throw new Error("Release start requires a clean working tree.");

  const commit = runGit(root, ["rev-parse", "--verify", "HEAD^{commit}"]);
  const baseCommit = runGit(root, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    `${baseRef}^{commit}`
  ]);
  if (commit !== baseCommit) {
    throw new Error(`HEAD ${commit} does not match ${baseRef} ${baseCommit}.`);
  }

  const tagRef = `refs/tags/${tag}`;
  const existingRef = hasGitRef(root, tagRef);
  /** @type {"existing" | "missing"} */
  let tagState = "missing";
  if (existingRef) {
    const objectType = runGit(root, ["cat-file", "-t", tagRef]);
    if (objectType !== "tag") throw new Error(`Existing ${tag} is not an annotated tag.`);
    const tagCommit = runGit(root, ["rev-parse", "--verify", `${tagRef}^{commit}`]);
    if (tagCommit !== commit) {
      throw new Error(`Existing ${tag} points to ${tagCommit}, not ${commit}.`);
    }
    tagState = "existing";
  }

  return { commit, tag, tagState, version };
}

try {
  const options = parseArguments(process.argv.slice(2));
  const result = await inspectReleaseStart(options);
  if (options.json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else {
    console.info(
      `Release start is valid for ${result.tag} at ${result.commit} (${result.tagState} tag).`
    );
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
