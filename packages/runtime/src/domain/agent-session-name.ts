import { providerIdSchema, type AgentRole, type ProviderId } from "@orchestrator/contracts";

const UUID_PATTERN = "[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const PROVIDER_PATTERN = providerIdSchema.options.map(escapeRegularExpression).join("|");
const WORKER_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/u;
const CAPTAIN_SESSION_PATTERN = new RegExp(
  `^ao__(${UUID_PATTERN})__captain__(${PROVIDER_PATTERN})$`,
  "u"
);
const WORKER_SESSION_PATTERN = new RegExp(
  `^ao__(${UUID_PATTERN})__worker__(${PROVIDER_PATTERN})__([a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?)$`,
  "u"
);

/** Identity encoded into an app-owned tmux session name. */
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
  const captain = CAPTAIN_SESSION_PATTERN.exec(name);
  if (captain !== null) {
    const conversationId = captain[1];
    const provider = providerIdSchema.safeParse(captain[2]);
    if (conversationId === undefined || !provider.success) return null;
    return {
      conversationId,
      role: "captain",
      provider: provider.data,
      slug: null
    };
  }

  const worker = WORKER_SESSION_PATTERN.exec(name);
  if (worker === null) return null;
  const conversationId = worker[1];
  const provider = providerIdSchema.safeParse(worker[2]);
  const slug = worker[3];
  if (conversationId === undefined || !provider.success || slug === undefined) return null;

  return {
    conversationId,
    role: "worker",
    provider: provider.data,
    slug
  };
}

/** Refuses persisted captain identities that do not belong to their conversation row. */
export function assertCaptainSessionOwnership(
  sessionName: string,
  conversationId: string,
  provider: ProviderId
): void {
  const identity = parseSessionName(sessionName);
  if (
    identity?.role !== "captain" ||
    identity.conversationId !== conversationId ||
    identity.provider !== provider
  ) {
    throw new Error("Persisted captain session does not match its conversation owner.");
  }
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

function escapeRegularExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
