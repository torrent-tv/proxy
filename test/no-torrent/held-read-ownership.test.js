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
import { MessageChannel } from "node:worker_threads";
import { createHash } from "node:crypto";

import { heldRangesOf, isRangeHeld, ownsItsMemory, readHeldBytes, readHeldRanges } from "../../services/torrent/worker/held-bytes.js";
import { heldFileBytes } from "../../services/torrent/worker/held-file-bytes.js";

test("whole-file assembly copies held pieces at file offsets without download demand", async () => {
  const store = Buffer.from(Array.from({ length: 64 }, (_, index) => index));
  const { torrent, streams } = torrentOver(store, () => true);
  torrent.files[0].offset = 5;
  torrent.files[0].length = 38;
  const chunks = [];
  for await (const bytes of heldFileBytes(torrent, 0)) {
    assert.ok(ownsItsMemory(bytes));
    chunks.push(bytes);
  }
  assert.deepEqual(chunks.map(bytes => bytes.length), [11, 16, 11]);
  assert.deepEqual(Buffer.concat(chunks), store.subarray(5, 43));
  assert.equal(streams.length, 3);
  store.fill(0);
  assert.equal(chunks[0][0], 5);
});

test("whole-file assembly rejects lost storage and releases failed reads", async () => {
  const { torrent } = torrentOver(Buffer.alloc(32), index => index === 0);
  await assert.rejects(async () => {
    for await (const _bytes of heldFileBytes(torrent, 0)) { /* Consume the file. */ }
  }, /lost held bytes 16-31/);
  let releases = 0;
  torrent.store.holdAvailable = () => () => { releases++; };
  torrent.store.get = (_index, _options, callback) => callback(new Error("storage failed"));
  await assert.rejects(async () => {
    for await (const _bytes of heldFileBytes(torrent, 0)) { /* Consume the file. */ }
  }, /lost held bytes 0-15/);
  assert.equal(releases, 1);
});

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

test("segment ranges acquire every piece before reading and stay held until the last copy", async () => {
  const { torrent, streams } = torrentOver(Buffer.alloc(64, 7), () => true);
  const acquisitions = [];
  const active = new Set();
  const get = torrent.store.get;
  torrent.store.holdAvailable = indexes => {
    const token = { indexes };
    acquisitions.push(token);
    active.add(token);
    return () => active.delete(token);
  };
  torrent.store.get = (index, options, callback) => {
    assert.ok(active.has(acquisitions[0]));
    assert.deepEqual(acquisitions[0].indexes, [0, 3]);
    get(index, options, callback);
  };
  const result = await readHeldRanges(torrent, 0, [[2, 5], [50, 55]], 10);
  assert.deepEqual(result.map(bytes => bytes.length), [4, 6]);
  assert.ok(result.every(ownsItsMemory));
  assert.equal(streams.length, 2);
  assert.equal(active.size, 0);
});

test("segment ranges read each source piece once even when many packet ranges share it", async () => {
  const bytes = Buffer.from(Array.from({ length: 64 }, (_, index) => index));
  const { torrent, streams } = torrentOver(bytes, () => true);
  const ranges = Array.from({ length: 8 }, (_, index) => [index * 2, index * 2]);
  const result = await readHeldRanges(torrent, 0, ranges, ranges.length);
  assert.deepEqual(result.map(buffer => buffer[0]), ranges.map(([start]) => bytes[start]));
  assert.deepEqual(streams, [{ index: 0, offset: 0, length: 15 }]);
});

test("segment range assembly preserves file offsets and ranges crossing torrent pieces", async () => {
  const bytes = Buffer.from(Array.from({ length: 64 }, (_, index) => index));
  const { torrent, streams } = torrentOver(bytes, () => true);
  torrent.files[0].offset = 5;
  torrent.files[0].length = 38;
  const result = await readHeldRanges(torrent, 0, [[10, 20], [25, 30]], 17);
  assert.deepEqual(result.map(buffer => [...buffer]), [
    [...bytes.subarray(15, 26)], [...bytes.subarray(30, 36)]
  ]);
  assert.deepEqual(streams, [
    { index: 0, offset: 15, length: 1 },
    { index: 1, offset: 0, length: 16 },
    { index: 2, offset: 0, length: 4 }
  ]);
});

test("an incomplete or over-budget segment reads no partial input", async () => {
  const { torrent, streams } = torrentOver(Buffer.alloc(64), index => index !== 3);
  assert.equal(await readHeldRanges(torrent, 0, [[0, 3], [48, 51]], 8), null);
  assert.equal(await readHeldRanges(torrent, 0, [[0, 15]], 8), null);
  assert.equal(streams.length, 0);
});

/** A torrent of one file whose stream serves views of one shared store buffer. */
function torrentOver(store, held) {
  const streams = [];
  const file = {
    name: "film.mkv",
    length: store.length,
    offset: 0,
    createReadStream() { assert.fail("A held read must not open a torrent stream."); }
  };
  return {
    streams,
    torrent: {
      pieceLength: 16, bitfield: { get: (index) => held(index) }, files: [file],
      store: {
        protectedRanges: () => [],
        locationOf: (index) => held(index) ? "memory" : "missing",
        holdAvailable: (indexes) => indexes.every(held) ? () => {} : null,
        get(index, { offset, length }, callback) {
          streams.push({ index, offset, length });
          callback(null, store.subarray(index * 16 + offset, index * 16 + offset + length));
        }
      }
    }
  };
}

test("availability is the storage fact even when the library bitfield disagrees", () => {
  const { torrent } = torrentOver(Buffer.alloc(64), (index) => index === 0 || index === 2);
  torrent.bitfield.get = () => true;
  assert.deepEqual(heldRangesOf(torrent, 0), [[0, 15], [32, 47]]);
  assert.equal(isRangeHeld(torrent, 0, 0, 31), false);
  torrent.bitfield.get = () => false;
  assert.equal(isRangeHeld(torrent, 0, 32, 47), true);
  assert.equal(isRangeHeld(torrent, 0, -1, 15), false);
  assert.equal(isRangeHeld(torrent, 0, 32, 100), false);
});

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
