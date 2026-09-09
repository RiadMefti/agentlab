import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { pinnedLocalExecutableDigest } from "../../packages/runtime/src/infrastructure/filesystem/pinned-local-executable.js";
import type { LedgerPeerOptions } from "../../packages/runtime/src/infrastructure/process/linux-ledger-peer-process.js";
import {
  listenLinuxLedgerPeer,
  requestLinuxLedgerPeer,
  type LedgerPeerIdentity
} from "../../packages/runtime/src/infrastructure/process/linux-ledger-peer-transport.js";

describe.skipIf(process.platform !== "linux")("Linux authenticated ledger transport", () => {
  let root: string;
  let options: LedgerPeerOptions;
  const listeners: { close: () => Promise<void> }[] = [];
  const uid = process.getuid?.() ?? -1;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "agentlab-peer-"));
    const pythonPath = await realpath("/usr/bin/python3");
    options = {
      pythonPath,
      pythonDigest: await pinnedLocalExecutableDigest(pythonPath, "Test interpreter"),
      socketPath: join(root, "ledger.sock"),
      maximumBytes: 1024,
      timeoutMs: 1000
    };
  });

  afterEach(async () => {
    await Promise.all(listeners.splice(0).map((listener) => listener.close()));
    await rm(root, { recursive: true, force: true });
  });

  it("obtains real peer credentials and survives a clean restart without relaxing the parent", async () => {
    const handle = vi.fn((peer: LedgerPeerIdentity, body: Uint8Array) => {
      expect(peer).toMatchObject({ uid, gid: process.getgid?.() });
      expect(peer.pid).toBeGreaterThan(0);
      return Promise.resolve(body);
    });
    const server = await listenLinuxLedgerPeer({ ...options, allowedUids: [uid] }, handle);
    listeners.push(server);
    const body = Buffer.from("immutable request");
    await expect(requestLinuxLedgerPeer({ ...options, serverUid: uid }, body)).resolves.toEqual(
      body
    );
    await server.close();
    listeners.push(await listenLinuxLedgerPeer({ ...options, allowedUids: [uid] }, handle));
    await expect(requestLinuxLedgerPeer({ ...options, serverUid: uid }, body)).resolves.toEqual(
      body
    );
    expect(handle).toHaveBeenCalledTimes(2);
  });

  it("rejects unknown callers before dispatch and authenticates the server before transmitting", async () => {
    const handle = vi.fn(() => Promise.resolve(Buffer.from("no")));
    listeners.push(await listenLinuxLedgerPeer({ ...options, allowedUids: [uid + 1] }, handle));
    await expect(
      requestLinuxLedgerPeer({ ...options, serverUid: uid }, Buffer.from("x"))
    ).rejects.toThrow(/reconcile/u);
    expect(handle).not.toHaveBeenCalled();
    await listeners[0]?.close();
    listeners.push(await listenLinuxLedgerPeer({ ...options, allowedUids: [uid] }, handle));
    await expect(
      requestLinuxLedgerPeer({ ...options, serverUid: uid + 1 }, Buffer.from("secret"))
    ).rejects.toThrow(/reconcile/u);
    expect(handle).not.toHaveBeenCalled();
  });

  it("bounds malicious frames and slow clients, then accepts the next valid request", async () => {
    const handle = vi.fn((_, body: Uint8Array) => Promise.resolve(body));
    listeners.push(
      await listenLinuxLedgerPeer({ ...options, timeoutMs: 200, allowedUids: [uid] }, handle)
    );
    for (const bytes of [Buffer.from([0xff, 0xff, 0xff, 0xff]), Buffer.from([0])]) {
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection(options.socketPath);
        socket.once("connect", () => {
          socket.write(bytes);
        });
        socket.once("error", reject);
        socket.once("close", () => {
          resolve();
        });
      });
    }
    const body = Buffer.from("valid");
    await expect(requestLinuxLedgerPeer({ ...options, serverUid: uid }, body)).resolves.toEqual(
      body
    );
    expect(handle).toHaveBeenCalledTimes(1);
  });

  it("terminates on a parent deadline without routing a late reply to a new request", async () => {
    let finish: (value: Uint8Array) => void = () => undefined;
    const reply = new Promise<Uint8Array>((resolve) => {
      finish = resolve;
    });
    const server = await listenLinuxLedgerPeer(
      { ...options, timeoutMs: 200, allowedUids: [uid] },
      () => reply
    );
    listeners.push(server);
    await expect(
      requestLinuxLedgerPeer({ ...options, serverUid: uid }, Buffer.from("x"))
    ).rejects.toThrow(/reconcile/u);
    await server.closed;
    finish(Buffer.from("late"));
    await expect(
      requestLinuxLedgerPeer({ ...options, serverUid: uid }, Buffer.from("next"))
    ).rejects.toThrow(/reconcile/u);
  });

  it("refuses writable socket parents, duplicate principals, and incorrect executable pins", async () => {
    const handle = () => Promise.resolve(Buffer.from("ok"));
    await chmod(root, 0o777);
    await expect(listenLinuxLedgerPeer({ ...options, allowedUids: [uid] }, handle)).rejects.toThrow(
      /readiness/u
    );
    await expect(
      listenLinuxLedgerPeer({ ...options, allowedUids: [uid, uid] }, handle)
    ).rejects.toThrow(/unique/u);
    await expect(
      listenLinuxLedgerPeer(
        { ...options, pythonDigest: `sha256:${"0".repeat(64)}`, allowedUids: [uid] },
        handle
      )
    ).rejects.toThrow(/pin/u);
  });

  it("never replaces a live socket or allows unbounded request/response bodies", async () => {
    listeners.push(
      await listenLinuxLedgerPeer({ ...options, allowedUids: [uid] }, () =>
        Promise.resolve(Buffer.alloc(1025))
      )
    );
    await expect(
      listenLinuxLedgerPeer({ ...options, allowedUids: [uid] }, () =>
        Promise.resolve(Buffer.from("no"))
      )
    ).rejects.toThrow(/readiness/u);
    await expect(
      requestLinuxLedgerPeer({ ...options, serverUid: uid }, Buffer.alloc(1025))
    ).rejects.toThrow(/bounds/u);
    await expect(
      requestLinuxLedgerPeer({ ...options, serverUid: uid }, Buffer.from("x"))
    ).rejects.toThrow(/reconcile/u);
  });
});
