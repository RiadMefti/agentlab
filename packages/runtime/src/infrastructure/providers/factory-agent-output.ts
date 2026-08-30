export function parseProviderJsonLines(
  output: string,
  provider: string
): readonly Record<string, unknown>[] {
  const lines = output.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length === 0 || lines.length > 100_000) {
    throw new Error(`${provider} returned an empty or excessive event stream.`);
  }
  return lines.map((line) => {
    let value: unknown;
    try {
      value = JSON.parse(line) as unknown;
    } catch (error: unknown) {
      throw new Error(`${provider} returned malformed JSONL.`, { cause: error });
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`${provider} returned a non-object JSONL event.`);
    }
    return value as Record<string, unknown>;
  });
}

export function objectValue(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function nonnegativeInteger(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function elapsedSeconds(startedAt: string, finishedAt: string): number {
  const milliseconds = Date.parse(finishedAt) - Date.parse(startedAt);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return 0;
  return Math.ceil(milliseconds / 1_000);
}

export function assertFactoryExecutable(executable: string): void {
  if (executable.length === 0 || executable.includes("\0")) {
    throw new Error("Factory provider executable is invalid.");
  }
}
