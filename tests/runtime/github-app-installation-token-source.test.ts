import {
  constants as cryptoConstants,
  generateKeyPairSync,
  verify as verifySignature
} from "node:crypto";

import { describe, expect, it } from "vitest";

import type {
  CreateGitHubAppInstallationTokenInput,
  GitHubAppInstallationApi
} from "../../packages/runtime/src/infrastructure/github/github-app-installation-client.js";
import { GitHubAppInstallationRestClient } from "../../packages/runtime/src/infrastructure/github/github-app-installation-client.js";
import { GitHubAppInstallationTokenSource } from "../../packages/runtime/src/infrastructure/github/github-app-installation-token-source.js";
import {
  issueGitHubAppJwt,
  NodeGitHubAppJwtSigner,
  type GitHubAppJwtSigner
} from "../../packages/runtime/src/infrastructure/github/github-app-jwt.js";

const nowMilliseconds = Date.parse("2026-08-30T12:00:00.000Z");
const repositoryId = "riadmefti/agentlab";
const repositoryNumericId = 12_345;
const installationId = 67_890;

describe("GitHubAppInstallationTokenSource", () => {
  it("coalesces and caches an exact repository-scoped short-lived token", async () => {
    const api = new RecordingInstallationApi(() => tokenResponse("ghs_modern_variable_token_1"));
    const signer = new RecordingSigner();
    const source = tokenSource(api, signer);

    const [first, second] = await Promise.all([
      source.token(repositoryId),
      source.token(repositoryId)
    ]);
    const cached = await source.token(repositoryId);

    expect(first).toBe("ghs_modern_variable_token_1");
    expect(second).toBe(first);
    expect(cached).toBe(first);
    expect(api.inputs).toHaveLength(1);
    expect(signer.inputs).toHaveLength(1);
    expect(api.inputs[0]).toMatchObject({ installationId, repositoryNumericId });
    const jwt = requiredInput(api).jwt;
    const [header, payload] = decodeJwt(jwt);
    expect(header).toEqual({ alg: "RS256", typ: "JWT" });
    expect(payload).toEqual({
      iat: Math.floor(nowMilliseconds / 1_000) - 60,
      exp: Math.floor(nowMilliseconds / 1_000) + 9 * 60,
      iss: "Iv1.agentlab-test"
    });
  });

  it("invalidates only the exact cached repository credential", async () => {
    let sequence = 0;
    const api = new RecordingInstallationApi(() => {
      sequence += 1;
      return tokenResponse(`ghs_token_${String(sequence)}`);
    });
    const source = tokenSource(api, new RecordingSigner());
    const first = await source.token(repositoryId);

    source.invalidate(repositoryId, "different-token");
    source.invalidate("other/repository", first);
    expect(await source.token(repositoryId)).toBe(first);
    expect(api.inputs).toHaveLength(1);

    source.invalidate(repositoryId, first);
    expect(await source.token(repositoryId)).toBe("ghs_token_2");
    expect(api.inputs).toHaveLength(2);
    await expect(source.token("other/repository")).rejects.toThrow(/another repository/u);
  });

  it.each([
    {
      name: "missing checks-read permission",
      response: {
        ...tokenResponse("ghs_missing_checks"),
        permissions: { contents: "write", pull_requests: "write" }
      },
      message: /permissions.*boundary/u
    },
    {
      name: "extra permission",
      response: {
        ...tokenResponse("ghs_extra_permission"),
        permissions: {
          checks: "read",
          contents: "write",
          pull_requests: "write",
          issues: "write"
        }
      },
      message: /permissions.*boundary/u
    },
    {
      name: "different repository",
      response: {
        ...tokenResponse("ghs_wrong_repository"),
        repositories: [{ id: repositoryNumericId + 1, full_name: "riadmefti/other" }]
      },
      message: /exact broker repository/u
    },
    {
      name: "unsafe lifetime",
      response: {
        ...tokenResponse("ghs_unsafe_lifetime"),
        expires_at: new Date(nowMilliseconds + 4 * 60 * 1_000).toISOString()
      },
      message: /unsafe expiration/u
    }
  ])("rejects and does not cache a token with $name", async ({ response, message }) => {
    const api = new RecordingInstallationApi(() => response);
    const source = tokenSource(api, new RecordingSigner());

    await expect(source.token(repositoryId)).rejects.toThrow(message);
    await expect(source.token(repositoryId)).rejects.toThrow(message);
    expect(api.inputs).toHaveLength(2);
  });
});

describe("GitHub App JWT boundary", () => {
  it("issues an RS256 JWT with the bounded GitHub App claims", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2_048 });
    const keyMaterial = Buffer.from(
      privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      "utf8"
    );
    let keyLoads = 0;
    const signer = new NodeGitHubAppJwtSigner({
      load: () => {
        keyLoads += 1;
        return Promise.resolve(keyMaterial);
      }
    });

    const jwt = await issueGitHubAppJwt({
      clientId: "Iv1.agentlab-test",
      nowMilliseconds,
      signer
    });
    const segments = jwt.split(".");
    expect(segments).toHaveLength(3);
    const unsigned = segments.slice(0, 2).join(".");
    const signature = segments[2];
    if (signature === undefined) throw new Error("JWT signature segment is missing.");
    expect(
      verifySignature(
        "RSA-SHA256",
        Buffer.from(unsigned, "utf8"),
        { key: publicKey, padding: cryptoConstants.RSA_PKCS1_PADDING },
        Buffer.from(signature, "base64url")
      )
    ).toBe(true);
    expect(keyLoads).toBe(1);
    expect(keyMaterial.every((byte) => byte === 0)).toBe(true);
  });

  it.each([Buffer.alloc(63, 1), Buffer.alloc(128, 1)])(
    "erases rejected private-key material",
    async (keyMaterial) => {
      const signer = new NodeGitHubAppJwtSigner({
        load: () => Promise.resolve(keyMaterial)
      });

      await expect(signer.sign(Buffer.from("agentlab", "utf8"))).rejects.toThrow(
        /private-key|private key/u
      );
      expect(keyMaterial.every((byte) => byte === 0)).toBe(true);
    }
  );

  it("rejects malformed installation requests before opening a network connection", async () => {
    expect(() => new GitHubAppInstallationRestClient({ userAgent: "bad user agent\r\n" })).toThrow(
      /HTTP token/u
    );
    const client = new GitHubAppInstallationRestClient();
    await expect(
      client.createToken({ installationId: 0, repositoryNumericId, jwt: "a.b.c" })
    ).rejects.toThrow();
    await expect(
      client.createToken({ installationId, repositoryNumericId, jwt: "not-a-jwt" })
    ).rejects.toThrow();
  });
});

class RecordingSigner implements GitHubAppJwtSigner {
  public readonly inputs: Uint8Array[] = [];

  public sign(input: Uint8Array): Promise<Uint8Array> {
    this.inputs.push(Buffer.from(input));
    return Promise.resolve(Uint8Array.from([1, 2, 3, 4]));
  }
}

class RecordingInstallationApi implements GitHubAppInstallationApi {
  public readonly inputs: CreateGitHubAppInstallationTokenInput[] = [];

  public constructor(private readonly response: () => unknown) {}

  public createToken(input: CreateGitHubAppInstallationTokenInput): Promise<unknown> {
    this.inputs.push(input);
    return Promise.resolve(this.response());
  }
}

function tokenSource(
  api: GitHubAppInstallationApi,
  signer: GitHubAppJwtSigner
): GitHubAppInstallationTokenSource {
  return new GitHubAppInstallationTokenSource({
    clientId: "Iv1.agentlab-test",
    installationId,
    repositoryId,
    repositoryNumericId,
    signer,
    api,
    now: () => nowMilliseconds
  });
}

function tokenResponse(token: string) {
  return {
    token,
    expires_at: new Date(nowMilliseconds + 60 * 60 * 1_000).toISOString(),
    permissions: {
      checks: "read",
      contents: "write",
      metadata: "read",
      pull_requests: "write"
    },
    repository_selection: "selected",
    repositories: [{ id: repositoryNumericId, full_name: "RiadMefti/AgentLab" }]
  };
}

function requiredInput(api: RecordingInstallationApi): CreateGitHubAppInstallationTokenInput {
  const input = api.inputs[0];
  if (input === undefined) throw new Error("Installation API was not called.");
  return input;
}

function decodeJwt(jwt: string): readonly [unknown, unknown] {
  const segments = jwt.split(".");
  const header = segments[0];
  const payload = segments[1];
  if (header === undefined || payload === undefined) throw new Error("JWT is incomplete.");
  return [
    JSON.parse(Buffer.from(header, "base64url").toString("utf8")) as unknown,
    JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown
  ];
}
