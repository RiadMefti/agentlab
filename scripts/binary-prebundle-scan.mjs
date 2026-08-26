import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

const MAXIMUM_BINARY_BYTES = 512 * 1024 * 1024;
const SCAN_CONTEXT_BYTES = 8 * 1024;
const HEADER_LOOKAHEAD_BYTES = 256;
const STAINLESS_HEADER = Buffer.from("X-Stainless-Package-Version", "ascii");
const ANTHROPIC_BASE_URL = Buffer.from("https://api.anthropic.com", "ascii");
const STAINLESS_LANGUAGE_HEADER = Buffer.from("X-Stainless-Lang", "ascii");
const PACKAGE_VERSION = "\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?";

/**
 * Reads bounded overlapping windows so large compiled executables are not decoded wholesale.
 * @param {string} binaryPath
 * @returns {Promise<string>}
 */
export async function discoverAnthropicSdkVersionInBinary(binaryPath) {
  const metadata = await stat(binaryPath);
  if (!metadata.isFile() || metadata.size > MAXIMUM_BINARY_BYTES) {
    throw new Error(`Compiled binary ${binaryPath} exceeds the provenance scan budget.`);
  }

  /** @type {Set<string>} */
  const versions = new Set();
  /** @type {Set<number>} */
  const processedHeaders = new Set();
  let foundAnthropicBaseUrl = false;
  let foundLanguageHeader = false;
  let consumedBytes = 0;
  let tail = Buffer.alloc(0);

  for await (const rawChunk of createReadStream(binaryPath, { highWaterMark: 1024 * 1024 })) {
    const chunk = /** @type {unknown} */ (rawChunk);
    if (!Buffer.isBuffer(chunk)) {
      throw new Error(`Could not scan compiled binary ${binaryPath}.`);
    }
    const window = Buffer.concat([tail, chunk]);
    const windowOffset = consumedBytes - tail.length;
    foundAnthropicBaseUrl ||= window.includes(ANTHROPIC_BASE_URL);
    foundLanguageHeader ||= window.includes(STAINLESS_LANGUAGE_HEADER);
    scanHeaderWindows(
      window,
      windowOffset,
      Math.max(0, window.length - HEADER_LOOKAHEAD_BYTES),
      processedHeaders,
      versions,
      binaryPath
    );
    consumedBytes += chunk.length;
    tail = Buffer.from(window.subarray(Math.max(0, window.length - SCAN_CONTEXT_BYTES)));
  }

  scanHeaderWindows(
    tail,
    consumedBytes - tail.length,
    tail.length,
    processedHeaders,
    versions,
    binaryPath
  );
  if (
    !foundAnthropicBaseUrl ||
    !foundLanguageHeader ||
    processedHeaders.size < 2 ||
    versions.size !== 1
  ) {
    throw new Error(`Compiled binary ${binaryPath} has no unambiguous Anthropic SDK marker.`);
  }
  const version = versions.values().next().value;
  if (typeof version !== "string") {
    throw new Error(`Compiled binary ${binaryPath} has no Anthropic SDK version.`);
  }
  return version;
}

/**
 * @param {Buffer} binary
 * @param {number} binaryOffset
 * @param {number} safeEnd
 * @param {Set<number>} processedHeaders
 * @param {Set<string>} versions
 * @param {string} sourceLabel
 */
function scanHeaderWindows(binary, binaryOffset, safeEnd, processedHeaders, versions, sourceLabel) {
  let headerOffset = binary.indexOf(STAINLESS_HEADER);
  while (headerOffset >= 0 && headerOffset < safeEnd) {
    const absoluteOffset = binaryOffset + headerOffset;
    if (!processedHeaders.has(absoluteOffset)) {
      const before = binary
        .subarray(Math.max(0, headerOffset - 4_096), headerOffset + HEADER_LOOKAHEAD_BYTES)
        .toString("utf8");
      const reference = /X-Stainless-Package-Version["']\s*:\s*([A-Za-z_$][0-9A-Za-z_$]*)/u.exec(
        before
      )?.[1];
      if (reference === undefined) {
        throw new Error(`Compiled binary ${sourceLabel} has a malformed Stainless marker.`);
      }
      const assignment = new RegExp(
        `(?:^|[;,]|\\b(?:const|let|var)\\s+)${escapeRegularExpression(reference)}\\s*=\\s*["'](${PACKAGE_VERSION})["']`,
        "gu"
      );
      const matches = [...before.matchAll(assignment)];
      const version = matches.at(-1)?.[1];
      if (version === undefined) {
        throw new Error(`Compiled binary ${sourceLabel} has an unbound Stainless marker.`);
      }
      versions.add(version);
      processedHeaders.add(absoluteOffset);
    }
    headerOffset = binary.indexOf(STAINLESS_HEADER, headerOffset + STAINLESS_HEADER.length);
  }
}

/** @param {string} value */
function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
