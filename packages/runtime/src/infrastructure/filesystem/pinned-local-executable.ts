import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import { access, lstat, open, realpath } from "node:fs/promises";

import { sha256DigestSchema, type Sha256Digest } from "@agentlab/contracts";

/** Hashes one canonical executable through a stable no-follow descriptor. */
export async function pinnedLocalExecutableDigest(
  path: string,
  label: string
): Promise<Sha256Digest> {
  if ((await realpath(path)) !== path) {
    throw new Error(`${label} must be canonical and symlink-free.`);
  }
  const before = await lstat(path, { bigint: true });
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size < 1n ||
    before.size > 1_073_741_824n
  ) {
    throw new Error(`${label} must be a bounded real file.`);
  }
  await access(path, constants.X_OK);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!sameFile(before, opened)) throw new Error(`${label} changed while it was opened.`);
    const hash = createHash("sha256");
    const stream = handle.createReadStream({ autoClose: false });
    for await (const chunk of stream as AsyncIterable<Buffer>) hash.update(chunk);
    const after = await handle.stat({ bigint: true });
    if (!sameFile(opened, after)) throw new Error(`${label} changed while it was hashed.`);
    return sha256DigestSchema.parse(`sha256:${hash.digest("hex")}`);
  } finally {
    await handle.close();
  }
}

function sameFile(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}
