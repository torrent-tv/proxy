/**
 * @file A read for a reader asks the store for several pieces at once, each
 * written straight into the copy (torrent-tv/meta#178).
 *
 * One piece after another, every read from disk waited for the torrent
 * thread's loop on its own, and that loop ran 0.3-0.7 s late while the swarm
 * delivered 7-14 MB/s: a 210 MB stretch took 11 s. What is checked: the store
 * writes a piece from memory and from disk into a buffer it is given; a read
 * has at most as many pieces in flight as libuv has file threads; the bytes
 * land where they belong; a piece shared by several ranges is still read once;
 * a short or failed piece read gives no partial input and starts no further
 * reads. Nothing here reaches a torrent: the store is the real one over a
 * temporary directory, or a fake.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate } from "node:timers/promises";
import { SharedPieceStore } from "../../services/storage/piece-store/shared-piece-store.js";
import { ownsItsMemory, readHeldRanges } from "../../services/torrent/worker/held-bytes.js";

const CHUNK = 64 * 1024;
const put = (store, index, bytes) =>
  new Promise((resolve, reject) => store.put(index, bytes, (error) => (error ? reject(error) : resolve())));
const piece = (index) => Buffer.from(Array.from({ length: CHUNK }, (_, at) => (index * 7 + at) % 251));

test("the store writes a piece from memory and from disk into a buffer it is given", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "piece-store-into-"));
  const store = new SharedPieceStore(CHUNK, { length: CHUNK * 8, memoryBytes: CHUNK * 2, path: directory, name: "into" });
  try {
    for (let index = 0; index < 4; index += 1) await put(store, index, piece(index));
    const fromDisk = Buffer.alloc(1000);
    assert.equal(await store.getInto(0, 500, fromDisk), true, "piece 0 is on disk by now");
    assert.deepEqual(fromDisk, piece(0).subarray(500, 1500));
    const fromMemory = Buffer.alloc(CHUNK);
    assert.equal(await store.getInto(3, 0, fromMemory), true);
    assert.deepEqual(fromMemory, piece(3));
    assert.equal(await store.getInto(3, CHUNK - 10, Buffer.alloc(11)), false, "past the piece's end is not a read");
    assert.ok(store.stats().fromDisk >= 1 || store.spilledCount >= 1);
  } finally {
    await new Promise((resolve) => store.destroy(resolve));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

/** A torrent of `pieces` pieces of 16 bytes whose store answers `getInto` when the check lets it. */
function torrentOver(pieces, { fail = null } = {}) {
  const bytes = Buffer.from(Array.from({ length: pieces * 16 }, (_, at) => at % 256));
  const waiting = [];
  const asked = [];
  let inFlight = 0, mostInFlight = 0, inFlightAtRelease = null;
  const store = {
    protectedRanges: () => [],
    locationOf: () => "disk",
    holdAvailable: () => () => { inFlightAtRelease = inFlight; },
    getInto(index, offset, target) {
      asked.push(index);
      inFlight += 1;
      mostInFlight = Math.max(mostInFlight, inFlight);
      return new Promise((resolve, reject) => waiting.push(() => {
        inFlight -= 1;
        if (fail?.(index) === "throw") return reject(new Error("disk went away"));
        if (fail?.(index) === "short") return resolve(false);
        bytes.copy(target, 0, index * 16 + offset, index * 16 + offset + target.length);
        resolve(true);
      }));
    },
    get(index, { offset, length }, callback) {
      asked.push(`get ${index}`);
      callback(null, Buffer.from(bytes.subarray(index * 16 + offset, index * 16 + offset + length)));
    }
  };
  const torrent = { pieceLength: 16, files: [{ name: "film.avi", length: bytes.length, offset: 0 }], store };
  const releaseAll = async () => {
    while (waiting.length) { waiting.shift()(); await setImmediate(); }
  };
  return { torrent, bytes, asked, waiting, releaseAll, mostInFlight: () => mostInFlight, inFlightAtRelease: () => inFlightAtRelease };
}

test("a read has at most four pieces in flight, and every byte lands where it belongs", async () => {
  const { torrent, bytes, asked, waiting, releaseAll, mostInFlight } = torrentOver(12);
  const reading = readHeldRanges(torrent, 0, [[3, 180]], 1000);
  await setImmediate();
  assert.equal(waiting.length, 4, "four asked at once, not one and not twelve");
  await releaseAll();
  const [range] = await reading;
  assert.ok(ownsItsMemory(range));
  assert.deepEqual(range, bytes.subarray(3, 181));
  assert.equal(mostInFlight(), 4);
  assert.deepEqual([...asked].sort((left, right) => left - right), Array.from({ length: 12 }, (_, index) => index));
});

test("a piece shared by several ranges is read once and divided", async () => {
  const { torrent, bytes, asked, releaseAll } = torrentOver(4);
  const reading = readHeldRanges(torrent, 0, [[1, 2], [5, 7], [16, 40]], 100);
  await releaseAll();
  const result = await reading;
  assert.deepEqual(result.map(buffer => [...buffer]), [[...bytes.subarray(1, 3)], [...bytes.subarray(5, 8)], [...bytes.subarray(16, 41)]]);
  assert.deepEqual(asked.filter(entry => typeof entry === "string"), ["get 0"], "piece 0 holds two ranges: one read of it");
});

for (const failure of ["short", "throw"]) test(`a ${failure === "short" ? "short" : "failed"} piece read gives no partial input and starts no further reads`, async () => {
  const { torrent, asked, releaseAll, inFlightAtRelease } = torrentOver(12, { fail: (index) => index === 1 ? failure : null });
  const reading = readHeldRanges(torrent, 0, [[0, 191]], 1000);
  await releaseAll();
  assert.equal(await reading, null);
  assert.ok(asked.length < 12, `${asked.length} of 12 pieces were asked for after one failed`);
  assert.equal(inFlightAtRelease(), 0, "the pieces are let go only once no read of them is in flight");
});
