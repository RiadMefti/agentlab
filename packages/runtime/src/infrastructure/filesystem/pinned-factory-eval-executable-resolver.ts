import type { Sha256Digest } from "@agentlab/contracts";

import type {
  FactoryEvalExecutableBinding,
  FactoryEvalExecutableResolver
} from "../../domain/factory-eval-harness.js";
import { pinnedLocalExecutableDigest } from "./pinned-local-executable.js";

/** Resolves only reviewed descriptor bindings and re-hashes their executable on every use. */
export class PinnedFactoryEvalExecutableResolver implements FactoryEvalExecutableResolver {
  readonly #bindings: ReadonlyMap<Sha256Digest, FactoryEvalExecutableBinding>;

  public constructor(bindings: readonly FactoryEvalExecutableBinding[]) {
    if (
      new Set(bindings.map(({ descriptorDigest }) => descriptorDigest)).size !== bindings.length
    ) {
      throw new Error("Factory eval executable descriptor bindings must be unique.");
    }
    this.#bindings = new Map(bindings.map((binding) => [binding.descriptorDigest, binding]));
  }

  public async resolve(
    descriptorDigest: Sha256Digest
  ): Promise<FactoryEvalExecutableBinding | null> {
    const binding = this.#bindings.get(descriptorDigest);
    if (binding === undefined) return null;
    const actual = await pinnedLocalExecutableDigest(
      binding.executable,
      `Factory eval executable ${descriptorDigest}`
    );
    if (actual !== binding.executableDigest) {
      throw new Error(`Factory eval executable ${descriptorDigest} changed after review.`);
    }
    return binding;
  }
}
