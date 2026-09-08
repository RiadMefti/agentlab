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
import { SqliteFactoryRepository } from "./infrastructure/persistence/sqlite-factory-repository.js";
import { acquireSqliteWriterLease } from "./infrastructure/persistence/sqlite-writer-lease.js";
import { listenLinuxLedgerPeer } from "./infrastructure/process/linux-ledger-peer-transport.js";

/** Long-lived exclusive ledger owner. V1 serves scoped reads, never grants execution authority. */
export async function createLocalFactoryLedger(input: LocalFactoryLedgerConfig): Promise<{
  readonly policyDigest: ReturnType<typeof factoryLedgerReadPolicyDigest>;
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
          return new TextEncoder().encode(JSON.stringify(await queries.execute(peer.uid, request)));
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
    return { policyDigest, stopped, close };
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
