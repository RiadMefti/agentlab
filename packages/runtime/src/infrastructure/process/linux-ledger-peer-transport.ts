import { z } from "zod";

import {
  ledgerPeerOptionsSchema,
  ownLedgerPeerProcess,
  peerUidSchema,
  startLedgerPeerProcess,
  type LedgerPeerOptions
} from "./linux-ledger-peer-process.js";

export interface LedgerPeerIdentity {
  readonly pid: number;
  readonly uid: number;
  readonly gid: number;
}

/** Internal transport only: the application must authorize and strictly parse every operation. */
export async function listenLinuxLedgerPeer(
  input: LedgerPeerOptions & { allowedUids: readonly number[] },
  handle: (peer: LedgerPeerIdentity, request: Uint8Array) => Promise<Uint8Array>
): Promise<{ closed: Promise<void>; close: () => Promise<void> }> {
  const { allowedUids, ...rawOptions } = input;
  const options = ledgerPeerOptionsSchema.parse(rawOptions);
  z.array(peerUidSchema).min(1).max(32).parse(allowedUids);
  if (new Set(allowedUids).size !== allowedUids.length) {
    throw new Error("Ledger peer UIDs must be unique.");
  }
  const child = await startLedgerPeerProcess("serve", options, { allowedUids });
  const owner = ownLedgerPeerProcess(child);
  let pending = Buffer.alloc(0);
  let ready = false;
  let busy = false;
  let lastSequence = 0;
  let stopped = false;
  let completeReady: () => void = () => undefined;
  let failReady: (error: Error) => void = () => undefined;
  const readiness = new Promise<void>((resolve, reject) => {
    completeReady = resolve;
    failReady = reject;
  });
  const stop = (): void => {
    stopped = true;
    failReady(new Error("Ledger peer transport stopped before readiness."));
    void owner.close();
  };
  const startup = setTimeout(stop, options.timeoutMs);
  void owner.closed.then(() => {
    stopped = true;
    clearTimeout(startup);
    failReady(new Error("Ledger peer transport exited before readiness."));
  });
  child.stdout.on("data", (chunk: Buffer) => {
    if (stopped) return;
    if (busy || pending.length + chunk.length > options.maximumBytes + 40) {
      stop();
      return;
    }
    pending = Buffer.concat([pending, chunk]);
    if (!ready && pending.length >= 20) {
      if (!pending.subarray(0, 20).equals(Buffer.alloc(20))) {
        stop();
        return;
      }
      pending = pending.subarray(20);
      ready = true;
      clearTimeout(startup);
      completeReady();
    }
    if (!ready || pending.length < 20) return;
    const sequence = pending.readUInt32BE(0);
    const peer = {
      pid: pending.readUInt32BE(4),
      uid: pending.readUInt32BE(8),
      gid: pending.readUInt32BE(12)
    };
    const length = pending.readUInt32BE(16);
    if (
      sequence !== lastSequence + 1 ||
      peer.pid < 1 ||
      !allowedUids.includes(peer.uid) ||
      length < 1 ||
      length > options.maximumBytes
    ) {
      stop();
      return;
    }
    if (pending.length < 20 + length) return;
    if (pending.length !== 20 + length) {
      stop();
      return;
    }
    const request = pending.subarray(20);
    pending = Buffer.alloc(0);
    lastSequence = sequence;
    busy = true;
    void Promise.resolve()
      .then(() => handle(Object.freeze(peer), request))
      .then((response) => {
        if (stopped) return;
        if (response.length < 1 || response.length > options.maximumBytes) {
          stop();
          return;
        }
        const header = Buffer.alloc(8);
        header.writeUInt32BE(sequence, 0);
        header.writeUInt32BE(response.length, 4);
        busy = false;
        child.stdin.write(Buffer.concat([header, response]));
      })
      .catch(stop);
  });
  try {
    await readiness;
  } catch (error) {
    await owner.close();
    throw error;
  }
  return {
    closed: owner.closed,
    async close() {
      stopped = true;
      await owner.close();
    }
  };
}

/** Authenticates the server's kernel UID before sending any request bytes. */
export async function requestLinuxLedgerPeer(
  input: LedgerPeerOptions & { serverUid: number },
  request: Uint8Array
): Promise<Uint8Array> {
  const { serverUid, ...rawOptions } = input;
  const options = ledgerPeerOptionsSchema.parse(rawOptions);
  peerUidSchema.parse(serverUid);
  if (request.length < 1 || request.length > options.maximumBytes) {
    throw new Error("Ledger request exceeds its frame bounds.");
  }
  const child = await startLedgerPeerProcess("request", options, { serverUid });
  const owner = ownLedgerPeerProcess(child);
  let result = Buffer.alloc(0);
  const state = { exceeded: false };
  const timeout = setTimeout(() => {
    state.exceeded = true;
    void owner.close();
  }, options.timeoutMs + 1000);
  child.stdout.on("data", (chunk: Buffer) => {
    if (result.length + chunk.length > options.maximumBytes) {
      state.exceeded = true;
      void owner.close();
    } else if (!state.exceeded) {
      result = Buffer.concat([result, chunk]);
    }
  });
  const header = Buffer.alloc(4);
  header.writeUInt32BE(request.length);
  child.stdin.end(Buffer.concat([header, request]));
  try {
    await owner.closed;
    if (state.exceeded || child.exitCode !== 0 || result.length < 1) {
      throw new Error("Ledger request failed; reconcile any mutation before retrying.");
    }
    return result;
  } finally {
    clearTimeout(timeout);
    await owner.close();
  }
}
