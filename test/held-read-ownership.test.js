/**
 * @file A read of what is downloaded asks for nothing, and hands the other
 * thread memory that is its own.
 *
 * Until 2026-10-01 the read opened the torrent's own file stream on bytes that
 * had not arrived; that stream selects pieces itself, outside the demand
 * register, and waited up to thirty seconds — 36 such reads at a torrent's open
 * competed with the file being watched. And the bytes it returns are now handed
 * to the main thread instead of copied, which is safe only for a buffer that is
 * the whole of its own memory. Fakes only.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { MessageChannel } from "node:worker_threads";
import { createHash } from "node:crypto";

import { ownsItsMemory, readHeldBytes } from "../services/torrent/worker/held-bytes.js";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** A torrent of one file whose stream serves views of one shared store buffer. */
function torrentOver(store, held) {
  const streams = [];
  const file = {
    name: "film.mkv",
    length: store.length,
    offset: 0,
    createReadStream({ start, end }) {
      streams.push({ start, end });
      return Readable.from([store.subarray(start, end + 1)]);
    }
  };
  return {
    streams,
    torrent: { pieceLength: 16, bitfield: { get: (index) => held(index) }, files: [file] }
  };
}

test("a range not wholly downloaded is answered at once with nothing, and no stream is opened", async () => {
  const store = Buffer.alloc(64, 1);
  const { torrent, streams } = torrentOver(store, (index) => index !== 2);
  assert.equal(await readHeldBytes(torrent, 0, 0, 63), null);
  assert.equal(streams.length, 0, "nothing was asked of the torrent");
  assert.notEqual(await readHeldBytes(torrent, 0, 0, 31), null, "a range that is here is read");
});

test("what a held read returns owns its memory; a pool slice and shared memory do not", async () => {
  const store = Buffer.from(Array.from({ length: 64 }, (_, index) => index));
  const { torrent } = torrentOver(store, () => true);
  const bytes = await readHeldBytes(torrent, 0, 3, 40);
  assert.equal(ownsItsMemory(bytes), true);
  assert.equal(ownsItsMemory(Buffer.from("small")), false, "a slice of Node's pool");
  assert.equal(ownsItsMemory(new Uint8Array(new SharedArrayBuffer(8))), false, "shared memory");
  assert.equal(ownsItsMemory(store.subarray(4, 8)), false, "a view into another buffer");
});

test("handing a read's bytes to another thread leaves the store and an overlapping read as they were", async () => {
  const store = Buffer.from(Array.from({ length: 256 }, (_, index) => index % 251));
  const before = digest(store);
  const { torrent } = torrentOver(store, () => true);
  const [first, second] = await Promise.all([readHeldBytes(torrent, 0, 10, 200), readHeldBytes(torrent, 0, 50, 120)]);
  const secondBefore = digest(second);

  const { port1, port2 } = new MessageChannel();
  const received = new Promise((resolve) => port2.once("message", resolve));
  port1.postMessage({ bytes: first }, [first.buffer]);
  const message = await received;
  port1.close();
  port2.close();

  assert.equal(first.byteLength, 0, "the sender no longer holds the memory it handed over");
  assert.deepEqual(Buffer.from(message.bytes), store.subarray(10, 201), "the receiver has every byte");
  assert.equal(digest(store), before, "the store's own bytes are untouched");
  assert.equal(digest(second), secondBefore, "the overlapping read is untouched");
});
