/**
 * @file Pieces in shared memory, spilling to disk.
 *
 * The cases worth having are the ones that describe past failures: a buffer
 * handed out must not be invalidated by later activity (2.9.71 transferred
 * memory it did not own), and a piece being read must not be evicted (2.9.71
 * again, at the torrent level).
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SharedPieceStore } from "../services/piece-store/shared-piece-store.js";

const CHUNK = 64 * 1024;

/**
 * @param {object} [options]
 * @returns {Promise<{ store: SharedPieceStore, directory: string }>}
 */
async function makeStore({ pieces = 4, totalPieces = 16 } = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "piece-store-"));
  const store = new SharedPieceStore(CHUNK, {
    length: CHUNK * totalPieces,
    memoryBytes: CHUNK * pieces,
    path: directory,
    name: "test"
  });
  return { store, directory };
}

/**
 * @param {number} index
 * @param {number} [length]
 * @returns {Buffer}
 */
function piece(index, length = CHUNK) {
  const bytes = Buffer.allocUnsafeSlow(length);
  bytes.fill(index % 256);
  bytes.writeUInt32BE(index, 0);
  return bytes;
}

/** Promise-shaped wrappers, so the tests read as the sequence they describe. */
const put = (store, index, bytes) =>
  new Promise((resolve, reject) => store.put(index, bytes, (error) => (error ? reject(error) : resolve())));
const get = (store, index, options) =>
  new Promise((resolve, reject) =>
    store.get(index, options, (error, bytes) => (error ? reject(error) : resolve(bytes)))
  );

test("a stored piece comes back byte for byte", async () => {
  const { store, directory } = await makeStore();
  try {
    await put(store, 0, piece(0));
    const read = await get(store, 0);
    assert.deepEqual(read, piece(0));
  } finally {
    await new Promise((resolve) => store.destroy(resolve));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

test("pieces past the memory budget spill to disk and read back intact", async () => {
  const { store, directory } = await makeStore({ pieces: 4, totalPieces: 16 });
  try {
    for (let index = 0; index < 10; index += 1) {
      await put(store, index, piece(index));
    }

    assert.equal(store.residentCount, 4, "more pieces stayed resident than the budget allows");
    assert.ok(store.spilledCount >= 6, "pieces over budget were not written out");

    // The earliest pieces can only come from disk now.
    for (const index of [0, 1, 2, 5]) {
      assert.deepEqual(await get(store, index), piece(index), `piece ${index} came back wrong`);
    }
  } finally {
    await new Promise((resolve) => store.destroy(resolve));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

test("the short last piece keeps its own length", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "piece-store-"));
  const store = new SharedPieceStore(CHUNK, {
    length: CHUNK * 3 + 1234,
    memoryBytes: CHUNK * 4,
    path: directory,
    name: "tail"
  });
  try {
    const tail = piece(3, 1234);
    await put(store, 3, tail);
    const read = await get(store, 3);
    assert.equal(read.length, 1234);
    assert.deepEqual(read, tail);
  } finally {
    await new Promise((resolve) => store.destroy(resolve));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

test("a buffer handed out survives later writes to the same slot", async () => {
  // This is the shape of the shipped defect: the caller keeps what it was
  // given while the store carries on working.
  const { store, directory } = await makeStore({ pieces: 2, totalPieces: 8 });
  try {
    await put(store, 0, piece(0));
    const held = await get(store, 0);

    for (let index = 1; index < 6; index += 1) {
      await put(store, index, piece(index));
    }

    assert.deepEqual(held, piece(0), "the buffer changed under its holder");
  } finally {
    await new Promise((resolve) => store.destroy(resolve));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

test("a pinned piece is not evicted to make room", async () => {
  const { store, directory } = await makeStore({ pieces: 2, totalPieces: 8 });
  try {
    await put(store, 0, piece(0));
    await put(store, 1, piece(1));

    store.pin(0);
    await put(store, 2, piece(2));

    const located = store.locate(0);
    assert.ok(located, "the pinned piece was evicted while held");
    const view = Buffer.from(located.buffer, located.offset, located.length);
    assert.deepEqual(view, piece(0), "the pinned piece was overwritten in place");

    store.unpin(0);
  } finally {
    await new Promise((resolve) => store.destroy(resolve));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

test("refuses to make room when every resident piece is being read", async () => {
  const { store, directory } = await makeStore({ pieces: 2, totalPieces: 8 });
  try {
    await put(store, 0, piece(0));
    await put(store, 1, piece(1));
    store.pin(0);
    store.pin(1);

    // The pinned pieces stay where they are, and the arrival is kept anyway —
    // on the disk, which is what it has. Refusing it was how a store short of
    // memory ended a torrent: the refusal travelled out through the torrent
    // client's own write callback and the client destroyed the torrent
    // (field 2026-09-11).
    await put(store, 2, piece(2));
    assert.ok(store.locate(0), "the pinned piece was taken from under its reader");
    assert.ok(store.locate(1), "the pinned piece was taken from under its reader");
    assert.equal(store.locate(2), null, "and the arrival did not displace either of them");
    assert.ok((await get(store, 2)).equals(piece(2)), "the arrival is kept, and reads back");
  } finally {
    store.unpin(0);
    store.unpin(1);
    await new Promise((resolve) => store.destroy(resolve));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

test("a piece revived from disk is readable by offset again", async () => {
  const { store, directory } = await makeStore({ pieces: 2, totalPieces: 8 });
  try {
    await put(store, 0, piece(0));
    await put(store, 1, piece(1));
    await put(store, 2, piece(2)); // pushes piece 0 out to disk
    assert.equal(store.locate(0), null, "piece 0 should have left memory");

    await store.reside(0); // brings it back, which is what a playback read does
    const located = store.locate(0);
    assert.ok(located, "piece 0 was not brought back into memory");
    const view = Buffer.from(located.buffer, located.offset, located.length);
    assert.deepEqual(view, piece(0));
  } finally {
    await new Promise((resolve) => store.destroy(resolve));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

test("a range within a piece is served correctly from memory and from disk", async () => {
  const { store, directory } = await makeStore({ pieces: 2, totalPieces: 8 });
  try {
    const source = piece(4);
    await put(store, 4, source);

    assert.deepEqual(
      await get(store, 4, { offset: 100, length: 256 }),
      source.subarray(100, 356),
      "range from memory is wrong"
    );

    await put(store, 5, piece(5));
    await put(store, 6, piece(6)); // piece 4 spills

    assert.deepEqual(
      await get(store, 4, { offset: 100, length: 256 }),
      source.subarray(100, 356),
      "range after revival is wrong"
    );
  } finally {
    await new Promise((resolve) => store.destroy(resolve));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

test("takes memory as it needs it, not the whole budget up front", async () => {
  // The budget is per torrent, so a torrent that is merely open — or one being
  // probed for its codecs — must not charge the host for the ceiling.
  const { store, directory } = await makeStore({ pieces: 16, totalPieces: 64 });
  try {
    assert.equal(store.capacity, 16);
    const initial = store.stats().committedBytes;
    assert.ok(initial === 0, `claimed ${initial} bytes before holding anything`);

    for (let index = 0; index < 5; index += 1) {
      await put(store, index, piece(index));
    }

    assert.equal(store.residentCount, 5);
    assert.equal(store.stats().committedBytes, CHUNK * 5, "committed should equal resident");
    assert.equal(store.stats().residentBytes, CHUNK * 5);

    // Per-piece buffers must not disturb early pieces.
    assert.deepEqual(await get(store, 0), piece(0), "an early piece was disturbed");
  } finally {
    await new Promise((resolve) => store.destroy(resolve));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

test("counts where reads were served from, so the budget can be judged", async () => {
  const { store, directory } = await makeStore({ pieces: 2, totalPieces: 8 });
  try {
    await put(store, 0, piece(0));
    await get(store, 0); // memory
    await get(store, 0); // memory

    await put(store, 1, piece(1));
    await put(store, 2, piece(2)); // piece 0 spills
    await get(store, 0); // disk

    const stats = store.stats();
    assert.equal(stats.fromMemory, 2, "memory reads miscounted");
    assert.equal(stats.fromDisk, 1, "disk reads miscounted");
    // One: piece 0 goes out to make room for piece 2. The read that follows is
    // the torrent client's, and since 2026-09-11 it is answered from the disk
    // copy without taking a block — so nothing has to be written out for it and
    // nothing is revived. A read for PLAYBACK still populates memory, and pays
    // for it with a spill; that is the next assertion.
    assert.equal(stats.spills, 1, "spills miscounted");
    assert.equal(stats.revivals, 0, "the client's own read does not revive");

    await store.reside(0);
    const afterPlayback = store.stats();
    assert.equal(afterPlayback.revivals, 1, "a read for playback revives");
    assert.equal(afterPlayback.spills, 2, "and pays for its block with a spill");
    assert.equal(stats.blockedByPins, 0);
    assert.equal(stats.capacity, 2);
  } finally {
    await new Promise((resolve) => store.destroy(resolve));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

test("counts a refusal caused by pinned pieces", async () => {
  const { store, directory } = await makeStore({ pieces: 2, totalPieces: 8 });
  try {
    await put(store, 0, piece(0));
    await put(store, 1, piece(1));
    store.pin(0);
    store.pin(1);
    await put(store, 2, piece(2));

    const stats = store.stats();
    assert.equal(stats.blockedByPins, 1, "the store not being able to give a block went unrecorded");
    assert.equal(stats.admittedWithoutSlot, 1, "and what it did instead went unrecorded");
  } finally {
    store.unpin(0);
    store.unpin(1);
    await new Promise((resolve) => store.destroy(resolve));
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

test("destroy removes the spill file", async () => {
  const { store, directory } = await makeStore({ pieces: 2, totalPieces: 8 });
  await put(store, 0, piece(0));
  await put(store, 1, piece(1));
  await put(store, 2, piece(2)); // forces a spill

  const before = await fs.readdir(directory);
  assert.ok(before.length > 0, "nothing was written to spill");

  await new Promise((resolve) => store.destroy(resolve));
  const after = await fs.readdir(directory);
  assert.equal(after.length, 0, "the spill file outlived the store");

  await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});
