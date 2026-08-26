import { describe, expect, it } from "vitest";

import { InstallProgressReporter } from "../../packages/launcher/src/install-progress.js";

describe("AgentLab install progress", () => {
  it("renders a throttled terminal bar with percentage, size, and speed", () => {
    const output: string[] = [];
    let now = 0;
    const reporter = new InstallProgressReporter({
      isTTY: true,
      now: () => now,
      target: "linux-x64",
      version: "0.2.3",
      write: (message) => output.push(message)
    });

    reporter.report({ downloadedBytes: 0, totalBytes: 100_000_000 });
    now = 50;
    reporter.report({ downloadedBytes: 25_000_000, totalBytes: 100_000_000 });
    now = 1_000;
    reporter.report({ downloadedBytes: 50_000_000, totalBytes: 100_000_000 });
    now = 2_000;
    reporter.report({ downloadedBytes: 100_000_000, totalBytes: 100_000_000 });
    reporter.complete();

    expect(output).toHaveLength(6);
    expect(output.join("")).toContain(
      "Downloading AgentLab 0.2.3 [████████░░░░░░░░]  50% 50.0/100.0 MB 50.0 MB/s"
    );
    expect(output.join("")).toContain(
      "Downloading AgentLab 0.2.3 [████████████████] 100% 100.0/100.0 MB 50.0 MB/s"
    );
    expect(output.join("")).toContain("✓ AgentLab 0.2.3 installed for Linux x64.\n");
    expect(output.at(-1)).toBe("Starting AgentLab...\n");
  });

  it("prints stable milestones without terminal control codes when redirected", () => {
    const output: string[] = [];
    const reporter = new InstallProgressReporter({
      isTTY: false,
      target: "mac-arm64",
      version: "0.2.3",
      write: (message) => output.push(message)
    });

    reporter.report({ downloadedBytes: 0, totalBytes: 77_351_282 });
    reporter.report({ downloadedBytes: 38_000_000, totalBytes: 77_351_282 });
    reporter.report({ downloadedBytes: 77_351_282, totalBytes: 77_351_282 });
    reporter.complete();

    expect(output).toEqual([
      "Downloading AgentLab 0.2.3 for macOS arm64 (77.4 MB)...\n",
      "AgentLab 0.2.3 installed for macOS arm64.\n",
      "Starting AgentLab...\n"
    ]);
    expect(output.join("")).not.toContain("\u001B");
  });

  it("clears an active terminal line without claiming installation after a failure", () => {
    const output: string[] = [];
    const reporter = new InstallProgressReporter({
      isTTY: true,
      target: "linux-x64",
      version: "0.2.3",
      write: (message) => output.push(message)
    });

    reporter.report({ downloadedBytes: 1_000_000, totalBytes: 100_000_000 });
    reporter.clear();
    reporter.complete();

    expect(output.at(-1)).toBe("\r\u001B[2K");
    expect(output.join("")).not.toContain("installed");
    expect(output.join("")).not.toContain("Starting");
  });
});
