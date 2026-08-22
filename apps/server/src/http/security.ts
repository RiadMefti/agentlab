import type { FastifyInstance, FastifyRequest } from "fastify";

import { ApplicationError } from "../domain/errors.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function registerLoopbackGuards(app: FastifyInstance): void {
  app.addHook("onRequest", (request) => {
    assertLoopbackHost(request);
    assertLoopbackOrigin(request);
    return Promise.resolve();
  });
}

export function assertLoopbackOrigin(request: FastifyRequest): void {
  const origin = request.headers.origin;
  if (origin === undefined) return;

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new ApplicationError("INVALID_ORIGIN", "Invalid request origin.", 403);
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    !LOOPBACK_HOSTS.has(normalizeHostname(parsed.hostname))
  ) {
    throw new ApplicationError(
      "INVALID_ORIGIN",
      "Only local browser connections are accepted.",
      403
    );
  }
}

function assertLoopbackHost(request: FastifyRequest): void {
  const rawHost = request.headers.host;
  if (rawHost === undefined) {
    throw new ApplicationError("INVALID_HOST", "Host header is required.", 400);
  }

  const hostname = rawHost.startsWith("[")
    ? rawHost.slice(0, rawHost.indexOf("]") + 1)
    : rawHost.split(":", 1)[0];
  if (hostname === undefined || !LOOPBACK_HOSTS.has(normalizeHostname(hostname))) {
    throw new ApplicationError("INVALID_HOST", "The server accepts loopback requests only.", 403);
  }
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/u, "");
}
