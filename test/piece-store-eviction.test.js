/**
 * Eviction under concurrency.
 *
 * Pieces arrive from several peers at once, so `put` runs concurrently by
 * nature. Choosing a victim and releasing it either side of the spill write
 * therefore let two claims pick the SAME victim and receive the SAME slot, at
 * which point two pieces overwrite each other, both fail their hash, and the
 * torrent re-downloads them without end — which looks from outside exactly like
 * a seek that never completes while the download runs at full speed.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SharedPieceStore } from "../services/piece-store/shared-piece-store.js";

const PIECE = 1024;

/**
 * @param {number} capacityPieces
 * @returns {Promise<{ store: SharedPieceStore, directory: string }>}
 */
async function makeStore(capacityPieces) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "piece-store-test-"));
  const store = new SharedPieceStore(PIECE, {
    length: PIECE * 64,
    memoryBytes: PIECE * capacityPieces,
    spillDirectory: directory,
    name: "eviction-test"
  });
  return { store, directory };
}

/**
 * @param {number} index
 * @returns {Buffer} A piece whose every byte identifies it.
 */
const pieceOf = (index) => Buffer.alloc(PIECE, index % 251);

/**
 * @param {SharedPieceStore} store
 * @param {number} index
 * @param {Buffer} bytes
 * @returns {Promise<void>}
 */
const put = (store, index, bytes) =>
  new Promise((resolve, reject) => {
    store.put(index, bytes, (error) => (error ? reject(error) : resolve()));
  });

/**
 * @param {SharedPieceStore} store
 * @param {number} index
 * @returns {Promise<Buffer>}
 */
const get = (store, index) =>
  new Promise((resolve, reject) => {
    store.get(index, (error, bytes) => (error ? reject(error) : resolve(bytes)));
  });

test("concurrent puts past capacity never hand two pieces the same slot", async () => {
  const capacity = 4;
  const { store, directory } = await makeStore(capacity);
  try {
    const total = 24;

    // All at once — the interleaving that a sequential test never produces.
    await Promise.all(
      Array.from({ length: total }, (unused, index) => put(store, index, pieceOf(index)))
    );

    // Every piece must read back as itself, from memory or from disk. A shared
    // slot shows up here as one piece carrying another's bytes.
    for (let index = 0; index < total; index += 1) {
      const bytes = await get(store, index);
      assert.equal(bytes.length, PIECE, `piece ${index} came back the wrong length`);
      assert.ok(
        bytes.equals(pieceOf(index)),
        `piece ${index} came back as piece ${bytes[0]} — two pieces shared a slot`
      );
    }

    const stats = store.stats();
    assert.ok(
      stats.resident <= stats.capacity,
      `resident ${stats.resident} exceeds capacity ${stats.capacity}: slots were handed out twice`
    );
  } finally {
    await store.destroy();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a piece caught mid-spill is waited for, not reported missing", async () => {
  const { store, directory } = await makeStore(2);
  try {
    await put(store, 0, pieceOf(0));
    await put(store, 1, pieceOf(1));

    // Forces piece 0 out while piece 0 is asked for in the same tick.
    const evicting = put(store, 2, pieceOf(2));
    const reading = get(store, 0);

    await evicting;
    const bytes = await reading;
    assert.ok(bytes.equals(pieceOf(0)), "piece 0 came back wrong while being spilled");
  } finally {
    await store.destroy();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("pinned pieces are never evicted, and the pin count is reported", async () => {
  const { store, directory } = await makeStore(2);
  try {
    await put(store, 0, pieceOf(0));
    store.pin(0);
    assert.equal(store.stats().pinned, 1, "pin is not reflected in the stats");

    await put(store, 1, pieceOf(1));
    await put(store, 2, pieceOf(2));

    // Piece 0 is pinned, so it must still be the one in memory, not on disk.
    assert.ok(store.locate(0), "a pinned piece was evicted");

    store.unpin(0);
    assert.equal(store.stats().pinned, 0, "unpin is not reflected in the stats");
  } finally {
    await store.destroy();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("the store says why it spills: what is asked of it, what it had to take, how soon it came back", async () => {
  const capacity = 4;
  const { store, directory } = await makeStore(capacity);
  try {
    // A reader declaring more than the store may hold. This is the shape the
    // field session of 2026-09-02 is suspected of — 88 slots against an
    // encoder running 120-380 s ahead of a viewer, half the reads missing —
    // and nothing recorded it (roadmap item 9).
    store.protectRange("video", 0, 9);
    for (let index = 0; index < 10; index += 1) {
      await put(store, index, pieceOf(index));
    }

    const asked = store.stats();
    assert.equal(asked.demand.readers, 1);
    assert.equal(asked.demand.unionPieces, 10);
    assert.equal(asked.demand.capacity, capacity);
    assert.ok(
      asked.demand.unionPieces > asked.demand.capacity,
      "a reader asking for more than the store holds is arithmetic, not a policy fault"
    );
    assert.ok(
      asked.evictedProtected > 0,
      "every eviction here had to take a piece the reader had declared"
    );

    // Read back the pieces that were spilled: each one comes home, and the
    // store says how long it had been away.
    for (let index = 0; index < 10; index += 1) {
      const bytes = await get(store, index);
      assert.ok(bytes.equals(pieceOf(index)), `piece ${index} came back changed`);
    }

    const after = store.stats();
    assert.ok(after.revivalAgeSamples > 0, "pieces came back and their age was recorded");
    assert.equal(typeof after.revivalAgeMedianMs, "number");
    assert.ok(
      after.revivedWithinFiveSeconds > 0,
      "a piece wanted again seconds after it left should not have left"
    );

    store.releaseProtection("video");
    assert.equal(store.stats().demand.readers, 0, "a reader that ends stops being counted");
  } finally {
    store.destroy(() => undefined);
    await fs.rm(directory, { recursive: true, force: true });
  }
});
