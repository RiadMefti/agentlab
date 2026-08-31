import { privateLocalFilePath, readPrivateLocalFile } from "../filesystem/private-local-file.js";
import type { GitHubAppPrivateKeySource } from "./github-app-jwt.js";

const maximumPrivateKeyBytes = 64 * 1_024;

/** Reads one owner-only, non-linked PEM into a fresh buffer for immediate one-use signing. */
export class FileGitHubAppPrivateKeySource implements GitHubAppPrivateKeySource {
  readonly #path: string;

  public constructor(path: string) {
    this.#path = privateLocalFilePath(path, "GitHub App private-key file");
  }

  public async load(): Promise<Uint8Array> {
    return readPrivateLocalFile(this.#path, {
      label: "GitHub App private-key file",
      minimumBytes: 64,
      maximumBytes: maximumPrivateKeyBytes
    });
  }
}
