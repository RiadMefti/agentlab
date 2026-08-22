import { providerIdSchema, type AgentRole, type ProviderId } from "@orchestrator/contracts";

const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const PROVIDER_PATTERN = "codex|claude|opencode";
const WORKER_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/u;
const SESSION_PATTERN = new RegExp(
  `^ao__(${UUID_PATTERN})__(captain)__(${PROVIDER_PATTERN})$|^ao__(${UUID_PATTERN})__(worker)__(${PROVIDER_PATTERN})__([a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?)$`,
  "u"
);

export interface ParsedSessionName {
  readonly conversationId: string;
  readonly role: AgentRole;
  readonly provider: ProviderId;
  readonly slug: string | null;
}

export function buildCaptainSessionName(conversationId: string, provider: ProviderId): string {
  assertUuid(conversationId);
  return `ao__${conversationId}__captain__${provider}`;
}

export function buildWorkerSessionPrefix(conversationId: string): string {
  assertUuid(conversationId);
  return `ao__${conversationId}__worker__`;
}

export function buildWorkerSessionName(
  conversationId: string,
  provider: ProviderId,
  slug: string
): string {
  if (!WORKER_SLUG_PATTERN.test(slug)) {
    throw new Error("Worker slug must be 1–32 lowercase letters, digits, or hyphens.");
  }
  return `${buildWorkerSessionPrefix(conversationId)}${provider}__${slug}`;
}

export function workerSlugFromLabel(label: string): string {
  const slug = label.trim().toLowerCase().replaceAll(" ", "-");
  if (!WORKER_SLUG_PATTERN.test(slug)) {
    throw new Error("Worker name must be 1–32 letters, digits, spaces, or hyphens.");
  }
  return slug;
}

export function parseSessionName(name: string): ParsedSessionName | null {
  const match = SESSION_PATTERN.exec(name);
  if (match === null) return null;

  if (match[1] !== undefined) {
    return {
      conversationId: match[1],
      role: "captain",
      provider: providerIdSchema.parse(match[3]),
      slug: null
    };
  }

  const conversationId = match[4];
  const provider = match[6];
  const slug = match[7];
  if (conversationId === undefined || provider === undefined || slug === undefined) return null;

  return {
    conversationId,
    role: "worker",
    provider: providerIdSchema.parse(provider),
    slug
  };
}

export function sessionLabel(parsed: ParsedSessionName): string {
  if (parsed.role === "captain") return "Captain";
  const slug = parsed.slug ?? "Agent";
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function assertUuid(value: string): void {
  if (!new RegExp(`^${UUID_PATTERN}$`, "u").test(value)) {
    throw new Error("Conversation ID must be a UUID.");
  }
}
