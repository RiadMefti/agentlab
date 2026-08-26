const STABLE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MAXIMUM_BINARY_SIZE = 512 * 1024 * 1024;

export const releaseTargetKeys = ["linux-x64", "mac-arm64"] as const;
export type ReleaseTargetKey = (typeof releaseTargetKeys)[number];

export interface ReleaseTarget {
  readonly asset: string;
  readonly sha256: string;
  readonly size: number;
}

export interface ReleaseManifest {
  readonly version: string;
  readonly repository: string;
  readonly targets: Readonly<Record<ReleaseTargetKey, ReleaseTarget>>;
}

export interface RuntimePlatform {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly glibcVersionRuntime?: string | undefined;
}

export function parseReleaseManifest(input: unknown): ReleaseManifest {
  const manifest = expectRecord(input, "release manifest");
  const version = expectString(manifest.version, "release manifest version");
  if (!STABLE_VERSION_PATTERN.test(version)) {
    throw new Error("Release manifest version must be MAJOR.MINOR.PATCH.");
  }

  const repository = expectString(manifest.repository, "release manifest repository");
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new Error("Release manifest repository must be an owner/name pair.");
  }

  const targetInput = expectRecord(manifest.targets, "release manifest targets");
  const names = Object.keys(targetInput).sort();
  if (names.join(",") !== [...releaseTargetKeys].sort().join(",")) {
    throw new Error(`Release manifest targets must be exactly ${releaseTargetKeys.join(", ")}.`);
  }

  const targets = Object.fromEntries(
    releaseTargetKeys.map((key) => [key, parseReleaseTarget(targetInput[key], version, key)])
  ) as unknown as Record<ReleaseTargetKey, ReleaseTarget>;
  return { repository, targets, version };
}

export function resolveRuntimeTarget(runtime: RuntimePlatform): ReleaseTargetKey {
  if (runtime.platform === "linux" && runtime.arch === "x64") {
    if (runtime.glibcVersionRuntime === undefined || runtime.glibcVersionRuntime.length === 0) {
      throw new Error("AgentLab requires glibc on Linux; musl is not supported.");
    }
    return "linux-x64";
  }
  if (runtime.platform === "darwin" && runtime.arch === "arm64") return "mac-arm64";
  throw new Error(
    `AgentLab does not support ${runtime.platform}-${runtime.arch}. Supported platforms are Linux x64 with glibc and macOS arm64.`
  );
}

export function currentRuntimePlatform(): RuntimePlatform {
  return {
    arch: process.arch,
    glibcVersionRuntime: readGlibcVersion(),
    platform: process.platform
  };
}

export function releaseDownloadUrl(manifest: ReleaseManifest, key: ReleaseTargetKey): string {
  const target = manifest.targets[key];
  return `https://github.com/${manifest.repository}/releases/download/v${manifest.version}/${target.asset}`;
}

function parseReleaseTarget(input: unknown, version: string, key: ReleaseTargetKey): ReleaseTarget {
  const target = expectRecord(input, `release target ${key}`);
  const asset = expectString(target.asset, `release target ${key} asset`);
  const expectedAsset = `agentlab-v${version}-${key}`;
  if (asset !== expectedAsset) {
    throw new Error(`Release target ${key} asset must be ${expectedAsset}.`);
  }

  const sha256 = expectString(target.sha256, `release target ${key} sha256`);
  if (!SHA256_PATTERN.test(sha256)) {
    throw new Error(`Release target ${key} sha256 must be 64 lowercase hexadecimal characters.`);
  }

  const size = target.size;
  if (
    !Number.isSafeInteger(size) ||
    typeof size !== "number" ||
    size <= 0 ||
    size > MAXIMUM_BINARY_SIZE
  ) {
    throw new Error(`Release target ${key} size is outside the supported range.`);
  }
  return { asset, sha256, size };
}

function readGlibcVersion(): string | undefined {
  if (process.platform !== "linux") return undefined;
  const report = process.report.getReport() as
    { readonly header?: { readonly glibcVersionRuntime?: unknown } } | undefined;
  const value = report?.header?.glibcVersionRuntime;
  return typeof value === "string" ? value : undefined;
}

function expectRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function expectString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}
