import type { Sha256Digest } from "@agentlab/contracts";

import { FactoryEvalAttestorService } from "./application/factory-eval-attestor-service.js";
import {
  LocalFactoryEvalAttestorCoordinator,
  type LocalFactoryEvalAttestorRuntime
} from "./application/local-factory-eval-attestor-coordinator.js";
import { RuntimeTaskOwner } from "./application/runtime-task-owner.js";
import type { LocalFactoryEvalAttestorConfig } from "./infrastructure/filesystem/local-factory-eval-attestor-config.js";
import { FileFactoryEvalAttestationKeySource } from "./infrastructure/filesystem/file-factory-eval-attestation-key-source.js";
import { NodeFactoryDsseSigner } from "./infrastructure/crypto/node-factory-dsse-signer.js";
import { NodeFactoryDocumentCodec } from "./infrastructure/persistence/canonical-factory-documents.js";

export interface LocalFactoryEvalAttestorOptions {
  readonly runnerId: string;
  readonly privateKeyPath: string;
  readonly keyId: Sha256Digest;
  readonly attestationLifetimeSeconds: number;
  readonly maximumIssuanceDelaySeconds: number;
  readonly now?: () => string;
}

/** Composes signing only: no database, model, process, GitHub, merge, or release adapter. */
export function createLocalFactoryEvalAttestor(
  options: LocalFactoryEvalAttestorOptions
): LocalFactoryEvalAttestorRuntime {
  const documents = new NodeFactoryDocumentCodec();
  const signer = new NodeFactoryDsseSigner(
    new FileFactoryEvalAttestationKeySource(options.privateKeyPath, "private"),
    options.keyId
  );
  return new LocalFactoryEvalAttestorCoordinator({
    attestor: new FactoryEvalAttestorService({
      runnerId: options.runnerId,
      attestationLifetimeSeconds: options.attestationLifetimeSeconds,
      maximumIssuanceDelaySeconds: options.maximumIssuanceDelaySeconds,
      signer,
      documents,
      now: options.now ?? (() => new Date().toISOString())
    }),
    tasks: new RuntimeTaskOwner()
  });
}

export function createConfiguredLocalFactoryEvalAttestor(
  config: LocalFactoryEvalAttestorConfig
): LocalFactoryEvalAttestorRuntime {
  return createLocalFactoryEvalAttestor(config);
}

export type {
  FactoryEvalAttestorCommandPort,
  LocalFactoryEvalAttestorRuntime
} from "./application/local-factory-eval-attestor-coordinator.js";
export {
  loadLocalFactoryEvalAttestorConfig,
  type LocalFactoryEvalAttestorConfig
} from "./infrastructure/filesystem/local-factory-eval-attestor-config.js";
export { loadLocalFactoryEvalRun } from "./infrastructure/filesystem/local-factory-eval-run.js";
