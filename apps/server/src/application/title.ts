const DEFAULT_TITLE = "New conversation";
const MAX_TITLE_LENGTH = 56;

export function deriveTitle(prompt: string): string {
  const firstLine = prompt.split(/\r?\n/u, 1)[0] ?? "";
  const normalized = firstLine.replace(/\s+/gu, " ").trim();

  if (normalized.length === 0) {
    return DEFAULT_TITLE;
  }

  if (normalized.length <= MAX_TITLE_LENGTH) {
    return normalized;
  }

  return `${normalized.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`;
}
