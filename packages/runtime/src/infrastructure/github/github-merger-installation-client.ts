import { request as httpsRequest } from "node:https";

import { z } from "zod";

import type {
  CreateGitHubAppInstallationTokenInput,
  GitHubAppInstallationApi
} from "./github-app-installation-api.js";
import { GitHubApiError } from "./github-rest-client.js";

export const githubAutonomousMergerPermissions = Object.freeze({
  contents: "write",
  pull_requests: "write"
} as const);

const requestSchema = z
  .object({
    installationId: z.number().int().positive(),
    repositoryNumericId: z.number().int().positive(),
    jwt: z
      .string()
      .min(1)
      .max(16_384)
      .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u)
  })
  .strict();

export interface GitHubMergerInstallationRestClientOptions {
  readonly timeoutMs?: number;
  readonly maximumResponseBytes?: number;
  readonly userAgent?: string;
}

/** Fixed-purpose token client for ready-for-review and merge-queue mutations only. */
export class GitHubMergerInstallationRestClient implements GitHubAppInstallationApi {
  readonly #timeoutMs: number;
  readonly #maximumResponseBytes: number;
  readonly #userAgent: string;

  public constructor(options: GitHubMergerInstallationRestClientOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? 20_000;
    this.#maximumResponseBytes = options.maximumResponseBytes ?? 1 * 1_024 * 1_024;
    this.#userAgent = options.userAgent ?? "agentlab-factory-merger";
    if (!Number.isSafeInteger(this.#timeoutMs) || this.#timeoutMs < 1) {
      throw new Error("GitHub merger token timeout must be a positive integer.");
    }
    if (!Number.isSafeInteger(this.#maximumResponseBytes) || this.#maximumResponseBytes < 1) {
      throw new Error("GitHub merger token response limit must be a positive integer.");
    }
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,255}$/u.test(this.#userAgent)) {
      throw new Error("GitHub merger user agent must be a bounded HTTP token.");
    }
  }

  public async createToken(inputValue: CreateGitHubAppInstallationTokenInput): Promise<unknown> {
    const input = requestSchema.parse(inputValue);
    const payload = JSON.stringify({
      repository_ids: [input.repositoryNumericId],
      permissions: githubAutonomousMergerPermissions
    });
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
          path: `/app/installations/${String(input.installationId)}/access_tokens`,
          headers: {
            Accept: "application/vnd.github+json",
            Authorization: `Bearer ${input.jwt}`,
            "Content-Type": "application/json",
            "Content-Length": String(Buffer.byteLength(payload)),
            "User-Agent": this.#userAgent,
            "X-GitHub-Api-Version": "2026-03-10"
          }
        },
        (response) => {
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on("data", (chunk: Buffer) => {
            if (settled) return;
            bytes += chunk.byteLength;
            if (bytes > this.#maximumResponseBytes) {
              fail(new Error("GitHub merger token response exceeded its size limit."));
              response.destroy();
              request.destroy();
              return;
            }
            chunks.push(chunk);
          });
          response.on("end", () => {
            if (settled) return;
            const status = response.statusCode ?? 0;
            if (status !== 201) {
              fail(
                new GitHubApiError(
                  status,
                  `GitHub API returned ${String(status)} while minting a merger token.`
                )
              );
              return;
            }
            try {
              const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
              settled = true;
              resolve(body);
            } catch (error: unknown) {
              fail(new Error("GitHub merger token API returned invalid JSON.", { cause: error }));
            }
          });
          response.on("aborted", () => {
            fail(new Error("GitHub merger token response aborted."));
          });
          response.on("error", (error) => {
            fail(new Error("GitHub merger token response failed.", { cause: error }));
          });
        }
      );
      request.setTimeout(this.#timeoutMs, () =>
        request.destroy(new Error("GitHub merger token request timed out."))
      );
      request.on("error", (error) => {
        fail(new Error("GitHub merger token request failed.", { cause: error }));
      });
      request.end(payload);
    });
  }
}
