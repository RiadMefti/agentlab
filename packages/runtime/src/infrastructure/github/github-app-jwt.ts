import { constants as cryptoConstants, createPrivateKey, sign as signBytes } from "node:crypto";

export interface GitHubAppJwtSigner {
  sign(input: Uint8Array): Promise<Uint8Array>;
}

export interface GitHubAppPrivateKeySource {
  load(): Promise<string | Uint8Array>;
}

/** Loads a PEM only for one signature and never exposes it to the broker or agent process. */
export class NodeGitHubAppJwtSigner implements GitHubAppJwtSigner {
  public constructor(private readonly privateKeys: GitHubAppPrivateKeySource) {}

  public async sign(input: Uint8Array): Promise<Uint8Array> {
    if (!(input instanceof Uint8Array) || input.byteLength < 1 || input.byteLength > 4_096) {
      throw new Error("GitHub App JWT signing input is invalid.");
    }
    const loaded = await this.privateKeys.load();
    const material = typeof loaded === "string" ? Buffer.from(loaded, "utf8") : Buffer.from(loaded);
    if (material.byteLength < 64 || material.byteLength > 64 * 1_024) {
      material.fill(0);
      throw new Error("GitHub App private-key material has an invalid size.");
    }
    try {
      const key = createPrivateKey(material);
      if (key.type !== "private" || key.asymmetricKeyType !== "rsa") {
        throw new Error("GitHub App JWT signing requires an RSA private key.");
      }
      return signBytes("RSA-SHA256", input, {
        key,
        padding: cryptoConstants.RSA_PKCS1_PADDING
      });
    } catch (error: unknown) {
      throw new Error("GitHub App private key could not sign an RS256 JWT.", { cause: error });
    } finally {
      material.fill(0);
    }
  }
}

export async function issueGitHubAppJwt(input: {
  readonly clientId: string;
  readonly nowMilliseconds: number;
  readonly signer: GitHubAppJwtSigner;
}): Promise<string> {
  const clientId = validateClientId(input.clientId);
  if (!Number.isSafeInteger(input.nowMilliseconds) || input.nowMilliseconds < 60_000) {
    throw new Error("GitHub App JWT time source is invalid.");
  }
  const nowSeconds = Math.floor(input.nowMilliseconds / 1_000);
  const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64UrlJson({
    iat: nowSeconds - 60,
    exp: nowSeconds + 9 * 60,
    iss: clientId
  });
  const unsigned = `${header}.${payload}`;
  const signature = await input.signer.sign(Buffer.from(unsigned, "utf8"));
  if (
    !(signature instanceof Uint8Array) ||
    signature.byteLength < 1 ||
    signature.byteLength > 16_384
  ) {
    throw new Error("GitHub App JWT signer returned an invalid signature.");
  }
  return `${unsigned}.${Buffer.from(signature).toString("base64url")}`;
}

function validateClientId(value: string): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(value)) {
    throw new Error("GitHub App client ID is invalid.");
  }
  return value;
}

function base64UrlJson(value: Readonly<Record<string, string | number>>): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}
