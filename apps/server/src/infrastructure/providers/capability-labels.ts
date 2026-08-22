const REASONING_LABELS: Readonly<Record<string, string>> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max"
};

export function reasoningLabel(id: string): string {
  return (
    REASONING_LABELS[id] ??
    id.replaceAll(/[-_.]+/gu, " ").replace(/\b\w/gu, (letter) => letter.toUpperCase())
  );
}
