import { performance } from "node:perf_hooks";

import type { BinaryDownloadProgress } from "./cache.js";
import type { ReleaseTargetKey } from "./manifest.js";

const BAR_WIDTH = 16;
const BYTES_PER_MEGABYTE = 1_000_000;
const MINIMUM_RENDER_INTERVAL_MILLISECONDS = 100;
const CLEAR_LINE = "\r\u001B[2K";

const targetLabels: Readonly<Record<ReleaseTargetKey, string>> = {
  "linux-x64": "Linux x64",
  "mac-arm64": "macOS arm64"
};

export interface InstallProgressOptions {
  readonly isTTY: boolean;
  readonly now?: (() => number) | undefined;
  readonly target: ReleaseTargetKey;
  readonly version: string;
  readonly write: (message: string) => void;
}

export class InstallProgressReporter {
  private readonly isTTY: boolean;
  private readonly now: () => number;
  private readonly targetLabel: string;
  private readonly version: string;
  private readonly write: (message: string) => void;
  private active = false;
  private finished = false;
  private lastRenderAt: number | undefined;
  private startedAt: number | undefined;

  public constructor(options: InstallProgressOptions) {
    this.isTTY = options.isTTY;
    this.now = options.now ?? (() => performance.now());
    this.targetLabel = targetLabels[options.target];
    this.version = options.version;
    this.write = options.write;
  }

  public report(progress: BinaryDownloadProgress): void {
    if (this.finished) return;
    const now = this.now();
    if (!this.active) {
      this.active = true;
      this.startedAt = now;
      if (!this.isTTY) {
        this.write(
          `Downloading AgentLab ${this.version} for ${this.targetLabel} (${formatMegabytes(progress.totalBytes)} MB)...\n`
        );
        return;
      }
    }
    if (!this.isTTY) return;

    const complete = progress.downloadedBytes >= progress.totalBytes;
    if (
      !complete &&
      this.lastRenderAt !== undefined &&
      now - this.lastRenderAt < MINIMUM_RENDER_INTERVAL_MILLISECONDS
    ) {
      return;
    }
    this.lastRenderAt = now;
    this.write(
      `${CLEAR_LINE}${renderProgress(progress, now - (this.startedAt ?? now), this.version)}`
    );
  }

  public complete(): void {
    if (!this.active || this.finished) return;
    this.finished = true;
    if (this.isTTY) this.write(CLEAR_LINE);
    const marker = this.isTTY ? "✓ " : "";
    this.write(`${marker}AgentLab ${this.version} installed for ${this.targetLabel}.\n`);
    this.write("Starting AgentLab...\n");
  }

  public clear(): void {
    if (!this.active || this.finished) return;
    this.finished = true;
    if (this.isTTY) this.write(CLEAR_LINE);
  }
}

function renderProgress(
  progress: BinaryDownloadProgress,
  elapsedMilliseconds: number,
  version: string
): string {
  const ratio = clamp(progress.downloadedBytes / progress.totalBytes, 0, 1);
  const filled = ratio === 1 ? BAR_WIDTH : Math.floor(ratio * BAR_WIDTH);
  const bar = `${"█".repeat(filled)}${"░".repeat(BAR_WIDTH - filled)}`;
  const percent = Math.floor(ratio * 100);
  const elapsedSeconds = Math.max(elapsedMilliseconds / 1_000, 0.001);
  const megabytesPerSecond = progress.downloadedBytes / BYTES_PER_MEGABYTE / elapsedSeconds;
  return `Downloading AgentLab ${version} [${bar}] ${String(percent).padStart(3)}% ${formatMegabytes(progress.downloadedBytes)}/${formatMegabytes(progress.totalBytes)} MB ${megabytesPerSecond.toFixed(1)} MB/s`;
}

function formatMegabytes(bytes: number): string {
  return (bytes / BYTES_PER_MEGABYTE).toFixed(1);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
