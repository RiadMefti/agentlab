import type { AvailableUpdate, DesktopUpdateApi } from "@orchestrator/contracts";

export const CHECK_FOR_UPDATE_CHANNEL = "orchestrator:updates:check";
export const OPEN_LATEST_RELEASE_CHANNEL = "orchestrator:updates:open-latest";
export const LATEST_RELEASE_API_URL =
  "https://api.github.com/repos/RiadMefti/agent-orchestrator/releases/latest";
export const LATEST_RELEASE_PAGE_URL =
  "https://github.com/RiadMefti/agent-orchestrator/releases/latest";

const STABLE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const RELEASE_TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MAXIMUM_VERSION_LENGTH = 64;

interface ReleaseResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

interface ReleaseRequestOptions {
  readonly headers: Record<string, string>;
  readonly signal: AbortSignal;
}

export type ReleaseRequest = (
  url: string,
  options: ReleaseRequestOptions
) => Promise<ReleaseResponse>;

interface CheckLatestReleaseOptions {
  readonly currentVersion: string;
  readonly request: ReleaseRequest;
  readonly timeoutMs?: number;
}

interface DesktopUpdateOptions extends CheckLatestReleaseOptions {
  readonly isPackaged: boolean;
  readonly onCheckError?: (error: unknown) => void;
  readonly openExternal: (url: string) => Promise<void>;
}

export async function checkLatestRelease({
  currentVersion,
  request,
  timeoutMs = 5_000
}: CheckLatestReleaseOptions): Promise<AvailableUpdate | null> {
  parseStableVersion(currentVersion);
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const response = await request(LATEST_RELEASE_API_URL, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": `agent-orchestrator/${currentVersion}`,
        "X-GitHub-Api-Version": "2022-11-28"
      },
      signal: controller.signal
    });

    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(
        `GitHub latest-release request failed with status ${String(response.status)}.`
      );
    }

    const latestVersion = readStableReleaseVersion(await response.json());
    return compareStableVersions(latestVersion, currentVersion) > 0
      ? { version: latestVersion }
      : null;
  } finally {
    clearTimeout(timeout);
  }
}

export function createDesktopUpdateApi(options: DesktopUpdateOptions): DesktopUpdateApi {
  return {
    async checkForUpdate() {
      if (!options.isPackaged) return null;

      try {
        return await checkLatestRelease(options);
      } catch (error) {
        options.onCheckError?.(error);
        return null;
      }
    },
    async openLatestRelease() {
      await options.openExternal(LATEST_RELEASE_PAGE_URL);
    }
  };
}

export function compareStableVersions(candidate: string, current: string): number {
  const candidateParts = parseStableVersion(candidate);
  const currentParts = parseStableVersion(current);

  for (let index = 0; index < candidateParts.length; index += 1) {
    const candidatePart = candidateParts[index];
    const currentPart = currentParts[index];
    if (candidatePart === undefined || currentPart === undefined) {
      throw new Error("Stable versions must contain exactly three components.");
    }
    if (candidatePart > currentPart) return 1;
    if (candidatePart < currentPart) return -1;
  }

  return 0;
}

function readStableReleaseVersion(value: unknown): string {
  if (!isJsonObject(value) || value.draft !== false || value.prerelease !== false) {
    throw new Error("GitHub returned invalid stable-release metadata.");
  }

  const tag = value.tag_name;
  if (typeof tag !== "string" || tag.length > MAXIMUM_VERSION_LENGTH) {
    throw new Error("GitHub returned an invalid stable-release tag.");
  }

  const match = RELEASE_TAG_PATTERN.exec(tag);
  if (!match) throw new Error("GitHub returned a non-stable release tag.");
  return tag.slice(1);
}

function parseStableVersion(version: string): readonly [bigint, bigint, bigint] {
  if (version.length > MAXIMUM_VERSION_LENGTH) {
    throw new Error("Stable version is too long.");
  }

  const match = STABLE_VERSION_PATTERN.exec(version);
  if (!match?.[1] || !match[2] || !match[3]) {
    throw new Error(`Invalid stable version: ${version}.`);
  }

  return [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])];
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
