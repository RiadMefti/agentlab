import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, normalize } from "node:path";

import {
  factoryLedgerReadPolicySchema,
  factoryLedgerAuthorityPolicySchema,
  type Sha256Digest
} from "@agentlab/contracts";
import { z } from "zod";

import { canonicalJson } from "../persistence/canonical-factory-documents.js";
import { ledgerPeerOptionsSchema } from "../process/linux-ledger-peer-process.js";
import { privateLocalFilePath, readPrivateLocalFile } from "./private-local-file.js";

const readOnlyLedgerConfigSchema = z.strictObject({
  schemaVersion: z.literal("agentlab.local-factory-ledger.v1"),
  databasePath: z
    .string()
    .min(1)
    .max(4096)
    .refine((path) => isAbsolute(path) && normalize(path) === path && !path.includes("\0")),
  transport: ledgerPeerOptionsSchema,
  policy: factoryLedgerReadPolicySchema
});
export const localFactoryLedgerConfigSchema = z
  .discriminatedUnion("schemaVersion", [
    readOnlyLedgerConfigSchema,
    readOnlyLedgerConfigSchema.extend({
      schemaVersion: z.literal("agentlab.local-factory-ledger.v2"),
      authorityPolicy: factoryLedgerAuthorityPolicySchema
    })
  ])
  .superRefine((config, context) => {
    if (
      config.schemaVersion === "agentlab.local-factory-ledger.v2" &&
      config.authorityPolicy.grants.some(
        (grant) =>
          !config.policy.principals.some(
            (peer) => peer.uid === grant.uid && peer.id === grant.id && peer.role === "operator"
          )
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "Authority grants require matching operator principals."
      });
    }
  });
export type LocalFactoryLedgerConfig = z.infer<typeof localFactoryLedgerConfigSchema>;

/** Provisioning creates these directories; a service must not bless a shared writable parent. */
export async function assertLedgerOwnedDirectories(
  config: LocalFactoryLedgerConfig
): Promise<void> {
  for (const path of [dirname(config.databasePath), dirname(config.transport.socketPath)]) {
    const metadata = await lstat(path);
    if (
      (await realpath(path)) !== path ||
      !metadata.isDirectory() ||
      metadata.uid !== process.getuid?.() ||
      (metadata.mode & 0o022) !== 0
    ) {
      throw new Error(
        "Ledger storage and socket parents must be canonical, owner-controlled directories."
      );
    }
  }
}

export function factoryLedgerReadPolicyDigest(policy: unknown): Sha256Digest {
  const json = canonicalJson(factoryLedgerReadPolicySchema.parse(policy));
  return `sha256:${createHash("sha256").update(json).digest("hex")}`;
}

/** The owner-reviewed UID grants and executable pin are not worker-controlled configuration. */
export async function loadLocalFactoryLedgerConfig(
  pathInput: string
): Promise<LocalFactoryLedgerConfig> {
  const path = privateLocalFilePath(pathInput, "Local factory ledger config");
  const bytes = await readPrivateLocalFile(path, {
    label: "Local factory ledger config",
    minimumBytes: 2,
    maximumBytes: 1_048_576
  });
  try {
    const value: unknown = JSON.parse(bytes.toString("utf8"));
    return localFactoryLedgerConfigSchema.parse(value);
  } finally {
    bytes.fill(0);
  }
}
