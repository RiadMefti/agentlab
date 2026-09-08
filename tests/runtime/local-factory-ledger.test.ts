import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadLocalFactoryLedgerConfig,
  localFactoryLedgerConfigSchema,
  type LocalFactoryLedgerConfig
} from "../../packages/runtime/src/infrastructure/filesystem/local-factory-ledger-config.js";
import { pinnedLocalExecutableDigest } from "../../packages/runtime/src/infrastructure/filesystem/pinned-local-executable.js";
import { acquireSqliteWriterLease } from "../../packages/runtime/src/infrastructure/persistence/sqlite-writer-lease.js";
import { createLocalFactoryLedger } from "../../packages/runtime/src/local-factory-ledger.js";

describe.skipIf(process.platform !== "linux" || process.getuid?.() === 0)(
  "local factory ledger ownership and lifecycle",
  () => {
    let root: string;
    let config: LocalFactoryLedgerConfig;
    const services: Awaited<ReturnType<typeof createLocalFactoryLedger>>[] = [];

    beforeEach(async () => {
      root = await mkdtemp(join(tmpdir(), "agentlab-ledger-lifecycle-"));
      const pythonPath = await realpath("/usr/bin/python3");
      config = {
        schemaVersion: "agentlab.local-factory-ledger.v1",
        databasePath: join(root, "ledger.sqlite"),
        transport: {
          pythonPath,
          pythonDigest: await pinnedLocalExecutableDigest(pythonPath, "Test interpreter"),
          socketPath: join(root, "ledger.sock"),
          maximumBytes: 65_536,
          timeoutMs: 1000
        },
        policy: {
          schemaVersion: "agentlab.ledger-read-policy.v1",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          principals: [
            { uid: (process.getuid?.() ?? 0) + 1, id: "worker", role: "worker", tasks: [] }
          ]
        }
      };
    });

    afterEach(async () => {
      await Promise.all(services.splice(0).map((service) => service.close()));
      await rm(root, { recursive: true, force: true });
    });

    it("requires private strict configuration without following a config symlink", async () => {
      const path = join(root, "ledger.json");
      await writeFile(path, JSON.stringify(config), { mode: 0o600 });
      await expect(loadLocalFactoryLedgerConfig(path)).resolves.toEqual(config);
      await chmod(path, 0o640);
      await expect(loadLocalFactoryLedgerConfig(path)).rejects.toThrow(/owner-only/u);
      await chmod(path, 0o600);
      const alias = join(root, "alias.json");
      await symlink(path, alias);
      await expect(loadLocalFactoryLedgerConfig(alias)).rejects.toThrow(/owner-only/u);
      await writeFile(path, JSON.stringify({ ...config, authority: "enabled" }));
      await expect(loadLocalFactoryLedgerConfig(path)).rejects.toThrow(/Unrecognized/u);
    });

    it("rejects shared owner/client identities and writable parents before creating storage", async () => {
      await expect(
        createLocalFactoryLedger({
          ...config,
          policy: {
            ...config.policy,
            principals: [{ uid: process.getuid?.() ?? 0, id: "worker", role: "worker", tasks: [] }]
          }
        })
      ).rejects.toThrow(/distinct/u);
      await chmod(root, 0o770);
      await expect(createLocalFactoryLedger(config)).rejects.toThrow(/owner-controlled/u);
      await expect(lstat(config.databasePath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        lstat(`${config.databasePath}.agentlab-writer-lock.sqlite`)
      ).rejects.toMatchObject({
        code: "ENOENT"
      });
    });

    it("releases storage on failed transport construction without replacing the occupied path", async () => {
      await writeFile(config.transport.socketPath, "do not replace", { mode: 0o600 });
      await expect(createLocalFactoryLedger(config)).rejects.toThrow(/readiness/u);
      expect(await readFile(config.transport.socketPath, "utf8")).toBe("do not replace");
      const lease = acquireSqliteWriterLease(config.databasePath, { contentionTimeoutMs: 50 });
      lease.close();
    });

    it("requires isolated artifact storage, matching producers, coherent quotas and enough frame capacity", async () => {
      const artifactRoot = join(root, "artifacts");
      const principal = config.policy.principals[0];
      if (principal === undefined) throw new Error("Missing fixture principal.");
      const candidate = {
        ...config,
        schemaVersion: "agentlab.local-factory-ledger.v3",
        artifacts: {
          root: artifactRoot,
          policy: {
            schemaVersion: "agentlab.ledger-artifact-policy.v1",
            expiresAt: config.policy.expiresAt,
            maximumArtifactBytes: 1024,
            maximumTaskBytes: 4096,
            maximumTaskArtifacts: 4,
            maximumTotalBytes: 8192,
            maximumTotalArtifacts: 8,
            principals: [{ uid: principal.uid, id: "worker", kind: "implementer" }]
          }
        }
      };
      const parsed = localFactoryLedgerConfigSchema.parse(candidate);
      await expect(createLocalFactoryLedger(parsed)).rejects.toMatchObject({ code: "ENOENT" });
      await mkdir(artifactRoot, { mode: 0o700 });
      await chmod(artifactRoot, 0o750);
      await expect(createLocalFactoryLedger(parsed)).rejects.toThrow(/owner-only/u);
      await expect(lstat(config.databasePath)).rejects.toMatchObject({ code: "ENOENT" });
      await chmod(artifactRoot, 0o700);
      for (const invalid of [
        { ...candidate, artifacts: { ...candidate.artifacts, root } },
        { ...candidate, transport: { ...candidate.transport, maximumBytes: 1024 } },
        {
          ...candidate,
          artifacts: {
            ...candidate.artifacts,
            policy: { ...candidate.artifacts.policy, maximumTotalBytes: 2048 }
          }
        },
        {
          ...candidate,
          policy: {
            ...config.policy,
            principals: [{ ...config.policy.principals[0], role: "broker" }]
          }
        }
      ])
        expect(localFactoryLedgerConfigSchema.safeParse(invalid).success).toBe(false);
      const service = await createLocalFactoryLedger(parsed);
      services.push(service);
      expect(service.artifactPolicyDigest).toMatch(/^sha256:/u);
      expect(service.authorityPolicyDigest).toBeNull();
      await service.close();
    });

    it("keeps an exclusive lease until close, then supports idempotent shutdown and restart", async () => {
      const first = await createLocalFactoryLedger(config);
      services.push(first);
      expect(() =>
        acquireSqliteWriterLease(config.databasePath, { contentionTimeoutMs: 50 })
      ).toThrow(/already owns/u);
      expect((await lstat(config.databasePath)).mode & 0o777).toBe(0o600);
      await Promise.all([first.close(), first.close(), first.stopped]);
      await expect(lstat(config.transport.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
      const next = await createLocalFactoryLedger(config);
      services.push(next);
      await next.close();
      await next.stopped;
      const lease = acquireSqliteWriterLease(config.databasePath, { contentionTimeoutMs: 50 });
      lease.close();
    });
  }
);
