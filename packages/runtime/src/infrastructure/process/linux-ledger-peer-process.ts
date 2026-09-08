import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { lstat } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";

import { sha256DigestSchema } from "@agentlab/contracts";
import { z } from "zod";

import { pinnedLocalExecutableDigest } from "../filesystem/pinned-local-executable.js";
import { linuxLedgerPeerHelper } from "./linux-ledger-peer-helper.js";

export const ledgerPeerOptionsSchema = z.strictObject({
  pythonPath: z.string().min(1).max(4096),
  pythonDigest: sha256DigestSchema,
  socketPath: z.string().min(2).max(100),
  maximumBytes: z.number().int().min(1).max(16_777_216),
  timeoutMs: z.number().int().min(100).max(30_000)
});

export type LedgerPeerOptions = z.infer<typeof ledgerPeerOptionsSchema>;
export const peerUidSchema = z.number().int().min(0).max(0xffff_fffe);

/** Pins an isolated interpreter, never resolving an executable through PATH or a shell. */
export async function startLedgerPeerProcess(
  mode: "serve" | "request",
  options: LedgerPeerOptions,
  identity: { allowedUids: readonly number[] } | { serverUid: number }
): Promise<ChildProcessWithoutNullStreams> {
  if (process.platform !== "linux") throw new Error("Ledger peer transport requires Linux.");
  ledgerPeerOptionsSchema.parse(options);
  for (const path of [options.pythonPath, options.socketPath]) {
    if (!isAbsolute(path) || normalize(path) !== path || path.includes("\0")) {
      throw new Error("Ledger peer paths must be absolute and normalized.");
    }
  }
  if (Buffer.byteLength(options.socketPath) > 100) {
    throw new Error("Ledger socket path exceeds the byte limit.");
  }
  const executable = await lstat(options.pythonPath);
  if (executable.uid !== 0 && executable.uid !== process.getuid?.()) {
    throw new Error("Ledger Python executable must be owned by root or the current principal.");
  }
  if ((executable.mode & 0o022) !== 0) {
    throw new Error("Ledger Python executable must not be group- or other-writable.");
  }
  if (
    (await pinnedLocalExecutableDigest(options.pythonPath, "Ledger Python executable")) !==
    options.pythonDigest
  ) {
    throw new Error("Ledger Python executable does not match its trusted pin.");
  }
  const child = spawn(
    options.pythonPath,
    [
      "-I",
      "-S",
      "-u",
      "-c",
      linuxLedgerPeerHelper,
      mode,
      JSON.stringify({ ...options, ...identity })
    ],
    { shell: false, env: {}, stdio: ["pipe", "pipe", "pipe"] }
  );
  // Diagnostics contain no request data and are deliberately not accumulated.
  child.stderr.resume();
  child.stdin.on("error", () => undefined);
  return child;
}

/** Does not relinquish child ownership until close, including the SIGKILL escalation. */
export function ownLedgerPeerProcess(child: ChildProcessWithoutNullStreams): {
  closed: Promise<void>;
  close: () => Promise<void>;
} {
  let terminal = false;
  const closed = new Promise<void>((resolve) => {
    child.once("close", () => {
      terminal = true;
      resolve();
    });
  });
  child.on("error", () => undefined);
  return {
    closed,
    async close() {
      if (terminal) return;
      child.kill("SIGTERM");
      const escalation = setTimeout(() => child.kill("SIGKILL"), 1000);
      try {
        await closed;
      } finally {
        clearTimeout(escalation);
      }
    }
  };
}
