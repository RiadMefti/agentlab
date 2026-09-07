import { request as httpsRequest } from "node:https";

import type { GitHubTokenSource } from "./github-rest-client.js";

export interface GitHubGraphqlApi {
  request(query: string, variables: Readonly<Record<string, unknown>>): Promise<unknown>;
}

export interface GitHubGraphqlClientOptions {
  readonly repositoryId: string;
  readonly tokenSource: GitHubTokenSource;
  readonly timeoutMs?: number;
  readonly maximumRequestBytes?: number;
  readonly maximumResponseBytes?: number;
  readonly userAgent?: string;
}

/** Bounded GraphQL transport used only behind fixed autonomous-merger operations. */
export class GitHubGraphqlClient implements GitHubGraphqlApi {
  readonly #timeoutMs: number;
  readonly #maximumRequestBytes: number;
  readonly #maximumResponseBytes: number;
  readonly #userAgent: string;

  public constructor(private readonly options: GitHubGraphqlClientOptions) {
    if (!/^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/u.test(options.repositoryId)) {
      throw new Error("GitHub GraphQL repository must be a lowercase owner/name pair.");
    }
    this.#timeoutMs = options.timeoutMs ?? 20_000;
    this.#maximumRequestBytes = options.maximumRequestBytes ?? 256 * 1_024;
    this.#maximumResponseBytes = options.maximumResponseBytes ?? 2 * 1_024 * 1_024;
    this.#userAgent = options.userAgent ?? "agentlab-factory-merger";
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1) {
      throw new Error("GitHub GraphQL timeout must be a positive integer.");
    }
    if (!Number.isSafeInteger(this.#maximumRequestBytes) || this.#maximumRequestBytes < 1) {
      throw new Error("GitHub GraphQL request limit must be a positive integer.");
    }
    if (!Number.isSafeInteger(this.#maximumResponseBytes) || this.#maximumResponseBytes < 1) {
      throw new Error("GitHub GraphQL response limit must be a positive integer.");
    }
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,255}$/u.test(this.#userAgent)) {
      throw new Error("GitHub GraphQL user agent must be a bounded HTTP token.");
    }
  }

  public async request(
    query: string,
    variables: Readonly<Record<string, unknown>>
  ): Promise<unknown> {
    if (
      query.length < 1 ||
      query.length > 64 * 1_024 ||
      query.includes("\0") ||
      !query.includes("AgentLab")
    ) {
      throw new Error("GitHub GraphQL operation is not a bounded AgentLab document.");
    }
    const payload = JSON.stringify({ query, variables });
    if (Buffer.byteLength(payload) > this.#maximumRequestBytes) {
      throw new Error("GitHub GraphQL request exceeded its size limit.");
    }
    const token = validateToken(await this.options.tokenSource.token(this.options.repositoryId));
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (error: Error): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const request = httpsRequest(
        {
          protocol: "https:",
          hostname: "api.github.com",
          port: 443,
          method: "POST",
          path: "/graphql",
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            "Content-Length": String(Buffer.byteLength(payload)),
            "User-Agent": this.#userAgent
          }
        },
        (response) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on("data", (chunk: Buffer) => {
            if (settled) return;
            bytes += chunk.byteLength;
            if (bytes > this.#maximumResponseBytes) {
              fail(new Error("GitHub GraphQL response exceeded its size limit."));
              response.destroy();
              request.destroy();
              return;
            }
            chunks.push(chunk);
          });
          response.on("end", () => {
            if (settled) return;
            const status = response.statusCode ?? 0;
            if (status === 401) {
              this.options.tokenSource.invalidate?.(this.options.repositoryId, token);
            }
            if (status < 200 || status >= 300) {
              fail(new Error(`GitHub GraphQL returned HTTP ${String(status)}.`));
              return;
            }
            try {
              const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              settled = true;
              resolve(body);
            } catch (error: unknown) {
              fail(new Error("GitHub GraphQL returned invalid JSON.", { cause: error }));
            }
          });
          response.on("aborted", () => {
            fail(new Error("GitHub GraphQL response was aborted."));
          });
          response.on("error", (error) => {
            fail(new Error("GitHub GraphQL response failed.", { cause: error }));
          });
        }
      );
      request.setTimeout(this.#timeoutMs, () => {
        request.destroy(new Error("GitHub GraphQL request timed out."));
      });
      request.on("error", (error) => {
        fail(new Error("GitHub GraphQL request failed.", { cause: error }));
      });
      request.end(payload);
    });
  }
}

function validateToken(token: string): string {
  if (token.length < 1 || token.length > 4_096 || /[\0\r\n]/u.test(token)) {
    throw new Error("GitHub merger credential is invalid.");
  }
  return token;
}
