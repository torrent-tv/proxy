/**
 * @file The worker transport's memory contract.
 *
 * These cover the defect that broke playback in 2.9.71-2.9.73: the worker
 * handed the main thread ownership of memory it did not own. WebTorrent's piece
 * cache keeps the buffer it returns and slices it again on the next read, so
 * transferring it detached the cache's own memory and every later read failed
 * with "Cannot perform %TypedArray%.prototype.slice on a detached ArrayBuffer".
 *
 * The field could not tell us this, because the error never reached anyone: the
 * worker sent READ_END from its `finally` before the error was posted, and the
 * main thread had no handler for a read error at all. So a failed read looked
 * exactly like an empty file.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { MessageChannel } from "node:worker_threads";
import { createSendStream, createReceiveStream, createCaller } from "../services/torrent-worker/channel.js";
import { TorrentWorkerClient } from "../services/torrent-worker/client.js";

/**
 * A buffer standing in for one owned by WebTorrent's piece cache: allocated
 * outside Node's shared pool, covering its whole region, and still referenced
 * by its owner after we hand it on.
 *
 * @param {number} size
 * @param {number} fill
 * @returns {Buffer}
 */
function foreignPiece(size, fill) {
  const piece = Buffer.allocUnsafeSlow(size);
  piece.fill(fill);
  return piece;
}

test("sending a chunk leaves the source buffer usable by its owner", async () => {
  const { port1, port2 } = new MessageChannel();
  try {
    const sender = createSendStream({ port: port1, requestId: 1 });
    const piece = foreignPiece(1024 * 1024, 7);

    await sender.send(piece);

    // The owner reads its own buffer again, exactly as the piece cache does on
    // the next request for the same piece.
    assert.equal(piece.length, 1024 * 1024, "buffer was detached by the send");
    assert.equal(piece[0], 7);
    assert.equal(piece.subarray(0, 16).length, 16, "slicing the source failed");
  } finally {
    port1.close();
    port2.close();
  }
});

test("a second read of the same piece still returns its bytes", async () => {
  const { port1, port2 } = new MessageChannel();
  try {
    const piece = foreignPiece(512 * 1024, 3);

    for (const requestId of [1, 2]) {
      const sender = createSendStream({ port: port1, requestId });
      await sender.send(piece);
      sender.end();
    }

    assert.equal(piece[0], 3, "the piece did not survive being sent twice");
  } finally {
    port1.close();
    port2.close();
  }
});

test("chunks arrive with their contents intact", async () => {
  const { port1, port2 } = new MessageChannel();
  try {
    const received = [];
    // Waited on rather than slept through. This test used to sleep 50 ms and
    // then assert, so it failed whenever the run was busy — recorded as flaky in
    // roadmap items 53 and 54, and it failed again on 2026-09-02 for a reason
    // that shows exactly how little a chosen interval is worth: the worker had
    // gained one more module to load, and 50 ms stopped being enough.
    let arrived;
    const firstChunk = new Promise((resolve) => { arrived = resolve; });
    port2.on("message", (message) => {
      if (message?.type === "chunk") {
        received.push(Buffer.from(message.bytes));
        arrived();
      }
    });

    const sender = createSendStream({ port: port1, requestId: 1 });
    const piece = foreignPiece(256 * 1024, 42);
    await sender.send(piece);
    sender.end();

    await firstChunk;
    assert.equal(received.length, 1);
    assert.equal(received[0].length, 256 * 1024);
    assert.equal(received[0][0], 42);
    assert.equal(received[0][received[0].length - 1], 42);
  } finally {
    port1.close();
    port2.close();
  }
});

test("reads and commands never share a request id", () => {
  const { port1, port2 } = new MessageChannel();
  try {
    const commandIds = [];
    port2.on("message", (message) => commandIds.push(message.id));

    const caller = createCaller(port1);
    const readIds = [];

    // Interleaved exactly as the real client does it: commands through `call`,
    // reads taking an id directly, both over the same channel.
    for (let round = 0; round < 50; round += 1) {
      void caller.call("noop", {});
      readIds.push(caller.nextId());
    }

    // A repeat between the two sequences is the collision that let a read's
    // reply resolve a command — with its result, silently.
    const everyId = [...commandIds, ...readIds];
    assert.equal(
      new Set(everyId).size,
      everyId.length,
      "an id was handed out to both a command and a read"
    );
  } finally {
    port1.close();
    port2.close();
  }
});

test("a failed read surfaces on the reader instead of ending quietly", async () => {
  const { port1, port2 } = new MessageChannel();
  try {
    const receive = createReceiveStream({
      port: port1,
      requestId: 1,
      onCancel: () => undefined
    });

    receive.fail(new Error("read failed in the worker"));

    const reader = receive.stream.getReader();
    await assert.rejects(
      () => reader.read(),
      /read failed in the worker/,
      "the reader saw a clean end instead of the failure"
    );
  } finally {
    port1.close();
    port2.close();
  }
});

test("a read of an unknown source fails the stream rather than hanging", async () => {
  // End to end through a real worker, because this is where the defect lived:
  // the worker reported the failure, nothing on the main thread listened, and
  // the reader waited forever. A unit test on either half alone passes happily.
  const client = new TorrentWorkerClient({ memoryBytes: 8 * 1024 * 1024 });
  try {
    // Starting the worker takes several seconds — it builds a torrent client
    // and a DHT — so the first request would measure startup, not the failure
    // path under test.
    await client.listFiles("warm-up").catch(() => undefined);

    const stream = client.createReadStream({ sourceKey: "no-such-source", fileIndex: 0 });
    const reader = stream.getReader();

    const outcome = await Promise.race([
      reader.read().then(() => "resolved", (error) => `rejected: ${error?.message}`),
      new Promise((resolve) => setTimeout(() => resolve("hung"), 10_000))
    ]);

    assert.match(
      outcome,
      /^rejected: .*no-such-source/,
      `expected the read to fail, got "${outcome}"`
    );
  } finally {
    await client.destroyAll();
  }
});
