import { request as httpsRequest } from "node:https";

export interface GitHubTokenSource {
  token(repositoryId: string): Promise<string>;
  invalidate?(repositoryId: string, token: string): void;
}

export interface GitHubRestApi {
  request(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown
  ): Promise<unknown>;
}

export class GitHubApiError extends Error {
  public constructor(
    public readonly statusCode: number,
    message: string
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

export interface GitHubRestClientOptions {
  readonly repositoryId: string;
  readonly tokenSource: GitHubTokenSource;
  readonly timeoutMs?: number;
  readonly maximumRequestBytes?: number;
  readonly maximumResponseBytes?: number;
  readonly userAgent?: string;
}

/** Minimal bounded GitHub REST client; credentials never enter URLs, argv, artifacts, or errors. */
export class GitHubRestClient implements GitHubRestApi {
  readonly #timeoutMs: number;
  readonly #maximumRequestBytes: number;
  readonly #maximumResponseBytes: number;
  readonly #userAgent: string;

  public constructor(private readonly options: GitHubRestClientOptions) {
    assertRepositoryId(options.repositoryId);
    this.#timeoutMs = options.timeoutMs ?? 20_000;
    this.#maximumRequestBytes = options.maximumRequestBytes ?? 1 * 1_024 * 1_024;
    this.#maximumResponseBytes = options.maximumResponseBytes ?? 2 * 1_024 * 1_024;
    this.#userAgent = options.userAgent ?? "agentlab-factory-broker";
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1) {
      throw new Error("GitHub API timeout must be a positive integer.");
    }
    if (!Number.isSafeInteger(this.#maximumRequestBytes) || this.#maximumRequestBytes < 1) {
      throw new Error("GitHub API request limit must be a positive integer.");
    }
    if (!Number.isSafeInteger(this.#maximumResponseBytes) || this.#maximumResponseBytes < 1) {
      throw new Error("GitHub API response limit must be a positive integer.");
    }
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,255}$/u.test(this.#userAgent)) {
      throw new Error("GitHub API user agent must be a bounded HTTP token.");
    }
  }

  public async request(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: unknown
  ): Promise<unknown> {
    assertApiPath(path, this.options.repositoryId);
    if ((method === "GET" || method === "DELETE") && body !== undefined) {
      throw new Error(`GitHub API ${method} requests cannot carry a body.`);
    }
    const payload = body === undefined ? null : JSON.stringify(body);
    if (payload !== null && Buffer.byteLength(payload, "utf8") > this.#maximumRequestBytes) {
      throw new Error("GitHub API request exceeded its size limit.");
    }
    const token = validateToken(await this.options.tokenSource.token(this.options.repositoryId));
    return new Promise((resolve, reject) => {
      let settled = false;
      const succeed = (value: unknown): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
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
          method,
          path,
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${token}`,
            "User-Agent": this.#userAgent,
            "X-GitHub-Api-Version": "2026-03-10",
            ...(payload === null
              ? {}
              : {
                  "Content-Type": "application/json",
                  "Content-Length": String(Buffer.byteLength(payload))
                })
          }
        },
        (response) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on("data", (chunk: Buffer) => {
            if (settled) return;
            bytes += chunk.byteLength;
            if (bytes > this.#maximumResponseBytes) {
              fail(new Error("GitHub API response exceeded its size limit."));
              response.destroy();
              request.destroy();
              return;
            }
            chunks.push(chunk);
          });
          response.on("end", () => {
            if (settled) return;
            const status = response.statusCode ?? 0;
            const text = Buffer.concat(chunks).toString("utf8");
            if (status < 200 || status >= 300) {
              if (status === 401)
                this.options.tokenSource.invalidate?.(this.options.repositoryId, token);
              fail(new GitHubApiError(status, githubErrorMessage(status, text)));
              return;
            }
            if (text.length === 0) {
              succeed(null);
              return;
            }
            try {
              succeed(JSON.parse(text) as unknown);
            } catch (error: unknown) {
              fail(new Error("GitHub API returned invalid JSON.", { cause: error }));
            }
          });
          response.on("aborted", () => {
            fail(new Error("GitHub API response was aborted."));
          });
          response.on("error", (error) => {
            fail(new Error("GitHub API response failed.", { cause: error }));
          });
        }
      );
      request.setTimeout(this.#timeoutMs, () => {
        request.destroy(new Error("GitHub API request timed out."));
      });
      request.on("error", (error) => {
        fail(new Error("GitHub API request failed.", { cause: error }));
      });
      request.end(payload ?? undefined);
    });
  }
}

function assertRepositoryId(repositoryId: string): void {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/u.test(repositoryId)) {
    throw new Error("GitHub broker repository must be a lowercase owner/name pair.");
  }
}

function assertApiPath(path: string, repositoryId: string): void {
  if (
    !path.startsWith(`/repos/${repositoryId}/`) ||
    path.includes("\0") ||
    path.includes("\r") ||
    path.includes("\n") ||
    path.includes("..") ||
    path.includes("://")
  ) {
    throw new Error("GitHub API path is outside the configured repository.");
  }
}

function validateToken(token: string): string {
  if (token.length < 1 || token.length > 4_096 || /[\0\r\n]/u.test(token)) {
    throw new Error("GitHub broker credential is invalid.");
  }
  return token;
}

function githubErrorMessage(status: number, text: string): string {
  let message = "request failed";
  try {
    const parsed = JSON.parse(text) as { readonly message?: unknown };
    if (typeof parsed.message === "string" && parsed.message.length <= 500) {
      message = parsed.message;
    }
  } catch {
    // Avoid reflecting arbitrary response bodies or credentials into broker logs.
  }
  return `GitHub API returned ${String(status)}: ${message}`;
}
