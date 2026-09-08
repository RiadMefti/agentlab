import { randomUUID } from "node:crypto";

import { FactoryLedgerAuthority } from "./application/factory-ledger-authority.js";
import { FactoryLedgerArtifacts } from "./application/factory-ledger-artifacts.js";
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
      config.schemaVersion === "agentlab.local-factory-ledger.v3"
        ? encodeCanonicalDocument(config.artifacts.policy).digest
        : null;
    let artifacts: FactoryLedgerArtifacts | null = null;
    if (
      config.schemaVersion === "agentlab.local-factory-ledger.v3" &&
      artifactPolicyDigest !== null
    ) {
      const executions = repositories.track(
        new SqliteFactoryExecutionRepository(lease.databasePath)
      );
      const repairs = repositories.track(
        new SqliteFactoryPullRequestRepairExecutionRepository(lease.databasePath)
      );
      const artifactReservations = repositories.track(
        new SqliteFactoryLedgerArtifactRepository(lease.databasePath)
      );
      artifacts = new FactoryLedgerArtifacts({
        peerPolicy: config.policy,
        peerPolicyDigest: policyDigest,
        policy: config.artifacts.policy,
        policyDigest: artifactPolicyDigest,
        contexts: {
          task: (taskId) => repository.findById(taskId),
          execution: (taskId, coordinate) =>
            coordinate.kind === "execution"
              ? executions.findByTaskId(taskId)
              : repairs.findByAuthorizationDigest(coordinate.authorizationDigest)
        },
        repository: artifactReservations,
        artifacts: new FileFactoryArtifactStore(config.artifacts.root, {
          maximumArtifactBytes: config.artifacts.policy.maximumArtifactBytes
        }),
        wire: new NodeFactoryArtifactWireCodec(),
        encode: encodeCanonicalDocument,
        now: () => new Date().toISOString()
      });
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
          const isAuthority =
            typeof request === "object" &&
            request !== null &&
            "operation" in request &&
            typeof request.operation === "string" &&
            ["authority.inspect", "authority.change", "authority.receipt"].includes(
              request.operation
            );
          const response =
            isAuthority && authority !== null
              ? await authority.execute(peer.uid, request)
              : typeof request === "object" &&
                  request !== null &&
                  "operation" in request &&
                  typeof request.operation === "string" &&
                  ["artifact.submit", "artifact.read", "artifact.receipt"].includes(
                    request.operation
                  ) &&
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
    return { policyDigest, authorityPolicyDigest, artifactPolicyDigest, stopped, close };
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
