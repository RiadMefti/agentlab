import { z } from "zod";

import type { GitHubTokenSource } from "./github-rest-client.js";
import type { GitHubAppInstallationApi } from "./github-app-installation-client.js";
import { issueGitHubAppJwt, type GitHubAppJwtSigner } from "./github-app-jwt.js";

const repositoryPattern = /^[a-z0-9](?:[a-z0-9-]{0,38})\/[a-z0-9._-]{1,100}$/u;
const tokenResponseSchema = z.object({
  token: z
    .string()
    .min(1)
    .max(4_096)
    .refine((value) => !/[\0\r\n]/u.test(value)),
  expires_at: z.iso.datetime(),
  permissions: z.record(z.string().min(1).max(128), z.enum(["read", "write"])),
  repository_selection: z.literal("selected"),
  repositories: z
    .array(
      z.object({
        id: z.number().int().positive(),
        full_name: z.string().min(3).max(140)
      })
    )
    .length(1)
});

interface CachedInstallationToken {
  readonly value: string;
  readonly expiresAtMilliseconds: number;
}

export interface GitHubAppInstallationTokenSourceOptions {
  readonly clientId: string;
  readonly installationId: number;
  readonly repositoryId: string;
  readonly repositoryNumericId: number;
  readonly signer: GitHubAppJwtSigner;
  readonly api: GitHubAppInstallationApi;
  readonly now?: () => number;
}

/** Mints and caches only short-lived, exact-repository credentials for the PR broker. */
export class GitHubAppInstallationTokenSource implements GitHubTokenSource {
  readonly #clientId: string;
  readonly #installationId: number;
  readonly #repositoryId: string;
  readonly #repositoryNumericId: number;
  readonly #signer: GitHubAppJwtSigner;
  readonly #api: GitHubAppInstallationApi;
  readonly #now: () => number;
  #cached: CachedInstallationToken | null = null;
  #minting: Promise<string> | null = null;

  public constructor(options: GitHubAppInstallationTokenSourceOptions) {
    if (!/^[A-Za-z0-9._-]{1,128}$/u.test(options.clientId)) {
      throw new Error("GitHub App client ID is invalid.");
    }
    if (!repositoryPattern.test(options.repositoryId)) {
      throw new Error("GitHub App token repository must be a lowercase owner/name pair.");
    }
    if (!positiveIdentifier(options.installationId)) {
      throw new Error("GitHub App installation ID is invalid.");
    }
    if (!positiveIdentifier(options.repositoryNumericId)) {
      throw new Error("GitHub repository numeric ID is invalid.");
    }
    this.#clientId = options.clientId;
    this.#installationId = options.installationId;
    this.#repositoryId = options.repositoryId;
    this.#repositoryNumericId = options.repositoryNumericId;
    this.#signer = options.signer;
    this.#api = options.api;
    this.#now = options.now ?? Date.now;
  }

  public token(repositoryId: string): Promise<string> {
    if (repositoryId !== this.#repositoryId) {
      return Promise.reject(new Error("GitHub App token source is bound to another repository."));
    }
    const now = this.#timestamp();
    if (
      this.#cached !== null &&
      now < this.#cached.expiresAtMilliseconds - tokenRefreshLeadMilliseconds
    ) {
      return Promise.resolve(this.#cached.value);
    }
    if (this.#minting !== null) return this.#minting;
    const attempt = this.#mint(now);
    const shared = attempt.finally(() => {
      if (this.#minting === shared) this.#minting = null;
    });
    this.#minting = shared;
    return shared;
  }

  public invalidate(repositoryId: string, token: string): void {
    if (
      repositoryId === this.#repositoryId &&
      this.#cached !== null &&
      this.#cached.value === token
    ) {
      this.#cached = null;
    }
  }

  public clear(): void {
    this.#cached = null;
  }

  async #mint(now: number): Promise<string> {
    const jwt = await issueGitHubAppJwt({
      clientId: this.#clientId,
      nowMilliseconds: now,
      signer: this.#signer
    });
    const response = tokenResponseSchema.parse(
      await this.#api.createToken({
        installationId: this.#installationId,
        repositoryNumericId: this.#repositoryNumericId,
        jwt
      })
    );
    assertExactBrokerPermissions(response.permissions);
    const repository = response.repositories[0];
    if (
      repository?.id !== this.#repositoryNumericId ||
      repository.full_name.toLowerCase() !== this.#repositoryId
    ) {
      throw new Error("GitHub installation token is not scoped to the exact broker repository.");
    }
    const observedAt = this.#timestamp();
    const expiresAt = Date.parse(response.expires_at);
    const lifetime = expiresAt - observedAt;
    if (
      !Number.isFinite(expiresAt) ||
      lifetime <= tokenRefreshLeadMilliseconds ||
      lifetime > maximumInstallationTokenLifetimeMilliseconds
    ) {
      throw new Error("GitHub installation token has an unsafe expiration time.");
    }
    this.#cached = { value: response.token, expiresAtMilliseconds: expiresAt };
    return response.token;
  }

  #timestamp(): number {
    const value = this.#now();
    if (!Number.isSafeInteger(value) || value < 60_000) {
      throw new Error("GitHub App token time source is invalid.");
    }
    return value;
  }
}

const tokenRefreshLeadMilliseconds = 5 * 60 * 1_000;
const maximumInstallationTokenLifetimeMilliseconds = 65 * 60 * 1_000;

function positiveIdentifier(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function assertExactBrokerPermissions(
  permissions: Readonly<Record<string, "read" | "write">>
): void {
  const keys = Object.keys(permissions).sort();
  const allowed = ["contents", "metadata", "pull_requests"];
  if (
    permissions.contents !== "write" ||
    permissions.pull_requests !== "write" ||
    (permissions.metadata !== undefined && permissions.metadata !== "read") ||
    keys.some((key) => !allowed.includes(key))
  ) {
    throw new Error("GitHub installation token permissions exceed the PR broker boundary.");
  }
}
