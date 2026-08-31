import type { FactoryEvalAttestationKeySource } from "../../domain/factory-eval-attestation-crypto.js";

import { privateLocalFilePath, readPrivateLocalFile } from "./private-local-file.js";

/** Owner-only, non-linked PEM source for an eval-attestation trust root or signing key. */
export class FileFactoryEvalAttestationKeySource implements FactoryEvalAttestationKeySource {
  readonly #path: string;
  readonly #label: string;

  public constructor(path: string, label: "private" | "public") {
    this.#label = `Factory eval attestation ${label}-key file`;
    this.#path = privateLocalFilePath(path, this.#label);
  }

  public async load(): Promise<Uint8Array> {
    return readPrivateLocalFile(this.#path, {
      label: this.#label,
      minimumBytes: 32,
      maximumBytes: 64 * 1_024
    });
  }
}
