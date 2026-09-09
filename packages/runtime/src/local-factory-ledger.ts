import { randomUUID } from "node:crypto";

import type {
  FactoryLedgerOperation,
  FactoryLedgerOperationResult,
  Sha256Digest
} from "@agentlab/contracts";

import { FactoryLedgerAuthority } from "./application/factory-ledger-authority.js";
import { FactoryLedgerArtifacts } from "./application/factory-ledger-artifacts.js";
import { FactoryLedgerOperationQueue } from "./application/factory-ledger-operation-queue.js";
import type { CanonicalFactoryDocument } from "./domain/factory-documents.js";
import type { FactoryLedgerArtifactContexts } from "./domain/factory-ledger-artifacts.js";
import { FactoryLedgerQueries } from "./application/factory-ledger-queries.js";
import { cleanupFailedRuntimeConstruction } from "./application/local-runtime-construction.js";
import { RuntimeRepositoryOwner } from "./application/runtime-repository-owner.js";
import { RuntimeTaskOwner } from "./application/runtime-task-owner.js";
import {
  assertLedgerOwnedDirectories,
  factoryLedgerReadPolicyDigest,
  localFactoryLedgerConfigSchema,
  type LocalFactoryLedgerConfig
} from "./infrastructure/filesystem/local-factory-ledger-config.js";
import { isUnconfirmedDatabaseInitializationError } from "./infrastructure/persistence/sqlite-database.js";
import { FileFactoryArtifactStore } from "./infrastructure/filesystem/file-factory-artifact-store.js";
import { NodeFactoryArtifactWireCodec } from "./infrastructure/filesystem/node-factory-artifact-wire-codec.js";
import { SqliteFactoryExecutionRepository } from "./infrastructure/persistence/sqlite-factory-execution-repository.js";
import { SqliteFactoryPullRequestRepairExecutionRepository } from "./infrastructure/persistence/sqlite-factory-pull-request-repair-execution-repository.js";
import { SqliteFactoryLedgerArtifactRepository } from "./infrastructure/persistence/sqlite-factory-ledger-artifact-repository.js";
import { SqliteFactoryLedgerOperationQueue } from "./infrastructure/persistence/sqlite-factory-ledger-operation-queue.js";
import {
  encodeCanonicalDocument,
  NodeFactoryDocumentCodec
} from "./infrastructure/persistence/canonical-factory-documents.js";
import { SqliteFactoryRepository } from "./infrastructure/persistence/sqlite-factory-repository.js";
import { acquireSqliteWriterLease } from "./infrastructure/persistence/sqlite-writer-lease.js";
import { listenLinuxLedgerPeer } from "./infrastructure/process/linux-ledger-peer-transport.js";

/** Long-lived exclusive ledger owner. V1 serves scoped reads, never grants execution authority. */
export async function createLocalFactoryLedger(input: LocalFactoryLedgerConfig): Promise<{
  readonly policyDigest: ReturnType<typeof factoryLedgerReadPolicyDigest>;
  readonly authorityPolicyDigest: ReturnType<typeof factoryLedgerReadPolicyDigest> | null;
  readonly artifactPolicyDigest: ReturnType<typeof factoryLedgerReadPolicyDigest> | null;
  readonly operationPolicyDigest: Sha256Digest | null;
  readonly enqueueOperation: (
    job: CanonicalFactoryDocument<FactoryLedgerOperation>
  ) => Promise<Sha256Digest>;
  /** Owner-only result read used by the captain bridge; absent for pre-v4 ledgers. */
  readonly readOperationResult: (
    job: CanonicalFactoryDocument<FactoryLedgerOperation>
  ) => Promise<CanonicalFactoryDocument<FactoryLedgerOperationResult> | null>;
  readonly stopped: Promise<void>;
  close: () => Promise<void>;
}> {
  const config = localFactoryLedgerConfigSchema.parse(input);
  if (
    process.platform !== "linux" ||
    process.getuid?.() === 0 ||
    config.policy.principals.some(({ uid }) => uid === process.getuid?.())
  ) {
    throw new Error("Ledger requires a non-root owner distinct from every client UID.");
  }
  await assertLedgerOwnedDirectories(config);
  const lease = acquireSqliteWriterLease(config.databasePath);
  const repositories = new RuntimeRepositoryOwner();
  const tasks = new RuntimeTaskOwner();
  try {
    const repository = repositories.track(new SqliteFactoryRepository(lease.databasePath));
    const policyDigest = factoryLedgerReadPolicyDigest(config.policy);
    const authorityPolicyDigest =
      "authorityPolicy" in config && config.authorityPolicy !== undefined
        ? encodeCanonicalDocument(config.authorityPolicy).digest
        : null;
    const authority =
      "authorityPolicy" in config &&
      config.authorityPolicy !== undefined &&
      authorityPolicyDigest !== null
        ? new FactoryLedgerAuthority({
            peerPolicy: config.policy,
            peerPolicyDigest: policyDigest,
            authorityPolicy: config.authorityPolicy,
            authorityPolicyDigest,
            repository,
            documents: new NodeFactoryDocumentCodec(),
            encode: encodeCanonicalDocument,
            now: () => new Date().toISOString(),
            createId: randomUUID
          })
        : null;
    const artifactPolicyDigest =
      "artifacts" in config ? encodeCanonicalDocument(config.artifacts.policy).digest : null;
    let artifacts: FactoryLedgerArtifacts | null = null;
    let operations: FactoryLedgerOperationQueue | null = null;
    const operationPolicyDigest =
      config.schemaVersion === "agentlab.local-factory-ledger.v4"
        ? encodeCanonicalDocument(config.operationPolicy).digest
        : null;
    if ("artifacts" in config && artifactPolicyDigest !== null) {
      const executions = repositories.track(
        new SqliteFactoryExecutionRepository(lease.databasePath)
      );
      const repairs = repositories.track(
        new SqliteFactoryPullRequestRepairExecutionRepository(lease.databasePath)
      );
      const artifactReservations = repositories.track(
        new SqliteFactoryLedgerArtifactRepository(lease.databasePath)
      );
      const contexts: FactoryLedgerArtifactContexts = {
        task: (taskId) => repository.findById(taskId),
        execution: (taskId, coordinate) =>
          coordinate.kind === "execution"
            ? executions.findByTaskId(taskId)
            : repairs.findByAuthorizationDigest(coordinate.authorizationDigest)
      };
      const artifactStore = new FileFactoryArtifactStore(config.artifacts.root, {
        maximumArtifactBytes: config.artifacts.policy.maximumArtifactBytes
      });
      artifacts = new FactoryLedgerArtifacts({
        peerPolicy: config.policy,
        peerPolicyDigest: policyDigest,
        policy: config.artifacts.policy,
        policyDigest: artifactPolicyDigest,
        contexts,
        repository: artifactReservations,
        artifacts: artifactStore,
        wire: new NodeFactoryArtifactWireCodec(),
        encode: encodeCanonicalDocument,
        now: () => new Date().toISOString()
      });
      if (
        config.schemaVersion === "agentlab.local-factory-ledger.v4" &&
        operationPolicyDigest !== null
      ) {
        operations = new FactoryLedgerOperationQueue({
          peerPolicy: config.policy,
          peerPolicyDigest: policyDigest,
          policy: config.operationPolicy,
          policyDigest: operationPolicyDigest,
          artifactPolicy: config.artifacts.policy,
          artifactPolicyDigest,
          contexts,
          repository: repositories.track(new SqliteFactoryLedgerOperationQueue(lease.databasePath)),
          artifactReservations,
          artifacts: artifactStore,
          wire: new NodeFactoryArtifactWireCodec(),
          encode: encodeCanonicalDocument,
          now: () => new Date().toISOString()
        });
      }
    }
    const queries = new FactoryLedgerQueries({
      policy: config.policy,
      policyDigest,
      controls: repository,
      tasks: repository,
      now: () => new Date().toISOString()
    });
    const listener = await listenLinuxLedgerPeer(
      { ...config.transport, allowedUids: config.policy.principals.map(({ uid }) => uid) },
      (peer, bytes) =>
        tasks.run(async () => {
          let request: unknown = null;
          try {
            request = JSON.parse(
              new TextDecoder("utf-8", { fatal: true }).decode(bytes)
            ) as unknown;
          } catch {
            // A constant denial is returned; malformed bytes never reach repository methods.
          }
          const operation =
            typeof request === "object" &&
            request !== null &&
            "operation" in request &&
            typeof request.operation === "string"
              ? request.operation
              : null;
          const response =
            operation !== null &&
            operations !== null &&
            ["operation.next", "operation.inspect", "operation.claim", "operation.report"].includes(
              operation
            )
              ? await operations.execute(peer.uid, request)
              : operation !== null &&
                  ["authority.inspect", "authority.change", "authority.receipt"].includes(
                    operation
                  ) &&
                  authority !== null
                ? await authority.execute(peer.uid, request)
                : operation !== null &&
                    ["artifact.submit", "artifact.read", "artifact.receipt"].includes(operation) &&
                    artifacts !== null
                  ? await artifacts.execute(peer.uid, request)
                  : await queries.execute(peer.uid, request);
          return new TextEncoder().encode(JSON.stringify(response));
        })
    );
    let closing: Promise<void> | null = null;
    const close = (): Promise<void> => {
      if (closing !== null) return closing;
      const attempt = (async () => {
        const drained = tasks.stopAndDrain();
        await listener.close();
        await drained;
        repositories.close();
        lease.close();
      })();
      const shared = attempt.catch((error: unknown) => {
        closing = null;
        throw error;
      });
      closing = shared;
      return shared;
    };
    // Unexpected helper exit stops admission and drains all work before releasing the database.
    const stopped = listener.closed.then(close);
    // Keep rejected shutdown observable through stopped without an unhandled process rejection.
    void stopped.catch(() => undefined);
    return {
      policyDigest,
      authorityPolicyDigest,
      artifactPolicyDigest,
      operationPolicyDigest,
      stopped,
      close,
      enqueueOperation: async (job) => {
        const queue = operations;
        if (queue === null) throw new Error("Ledger operation dispatch is not configured.");
        return tasks.run(async () => (await queue.enqueue(job)).job.digest);
      },
      readOperationResult: async (job) => {
        const queue = operations;
        if (queue === null) throw new Error("Ledger operation dispatch is not configured.");
        return tasks.run(() => queue.readResult(job));
      }
    };
  } catch (error: unknown) {
    await tasks.stopAndDrain();
    const failures = cleanupFailedRuntimeConstruction(
      repositories,
      lease,
      !isUnconfirmedDatabaseInitializationError(error)
    );
    if (failures.length > 0)
      throw new AggregateError([error, ...failures], "Ledger construction and cleanup failed.");
    throw error;
  }
}

export {
  loadLocalFactoryLedgerConfig,
  type LocalFactoryLedgerConfig
} from "./infrastructure/filesystem/local-factory-ledger-config.js";
