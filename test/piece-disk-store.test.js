/**
 * @file The spilled pieces are bounded, and the bound returns disk.
 *
 * What these pin is the difference between this store and the tier it replaced.
 * That one wrote into one sparse file and answered `forget` by dropping a
 * number: nothing it did returned a block, and a store holding 400 MB had
 * written 14.4 GB to the disk in fifty minutes (field 2026-08-31). So the
 * assertions here are about the DISK, read back from the file system, not about
 * the store's own bookkeeping — the bookkeeping was never what was wrong.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PieceDiskStore } from "../services/piece-store/piece-disk-store.js";

const PIECE = 4096;

/**
 * @param {number | null} allowanceBytes
 * @returns {Promise<{ store: PieceDiskStore, directory: string, clock: { at: number } }>}
 */
async function makeStore(allowanceBytes) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "piece-disk-test-"));
  const clock = { at: 1000 };
  const store = new PieceDiskStore({
    directory,
    name: "pieces",
    chunkLength: PIECE,
    allowanceBytes,
    now: () => clock.at
  });
  return { store, directory, clock };
}

/**
 * What the store's directory actually holds, in bytes and in files.
 *
 * @param {PieceDiskStore} store
 * @returns {Promise<{ files: number, bytes: number }>}
 */
async function onDisk(store) {
  let names = [];
  try {
    names = await fs.readdir(store.path);
  } catch {
    return { files: 0, bytes: 0 };
  }
  let bytes = 0;
  for (const name of names) {
    const stat = await fs.stat(path.join(store.path, name));
    bytes += stat.size;
  }
  return { files: names.length, bytes };
}

const pieceOf = (index) => Buffer.alloc(PIECE, index % 251);

test("told nothing, it holds everything — which is what it did before it could count", async () => {
  const { store, directory } = await makeStore(null);
  try {
    for (let index = 0; index < 8; index += 1) {
      await store.write(index, pieceOf(index));
    }
    assert.equal(store.size, 8, "a store with no allowance threw something away");
    assert.equal(store.bytes, 8 * PIECE);
    assert.deepEqual(await onDisk(store), { files: 8, bytes: 8 * PIECE });
  } finally {
    await store.destroy();
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

test("over its allowance it throws the least recently used away, and the disk shrinks with it", async () => {
  const { store, directory, clock } = await makeStore(3 * PIECE);
  try {
    for (const index of [0, 1, 2]) {
      clock.at += 100;
      await store.write(index, pieceOf(index));
    }
    assert.deepEqual(await onDisk(store), { files: 3, bytes: 3 * PIECE }, "the store did not fill");

    // Piece 0 is the oldest and nobody has read it since.
    clock.at += 100;
    await store.write(3, pieceOf(3));
    await store.settled();

    assert.equal(store.has(0), false, "the oldest piece was kept");
    assert.equal(store.has(3), true, "the arriving piece was not stored");
    assert.equal(store.bytes, 3 * PIECE, "the store counts more than its allowance");
    // THE POINT: not the count in memory, the blocks on the disk.
    assert.deepEqual(
      await onDisk(store),
      { files: 3, bytes: 3 * PIECE },
      "the disk kept the bytes of the piece that was thrown away"
    );
    assert.equal(store.stats().evictions, 1);
  } finally {
    await store.destroy();
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

test("reading a piece keeps it: the oldest is not the least wanted", async () => {
  const { store, directory, clock } = await makeStore(3 * PIECE);
  try {
    for (const index of [0, 1, 2]) {
      clock.at += 100;
      await store.write(index, pieceOf(index));
    }
    // Piece 0 is read, which makes piece 1 the oldest.
    clock.at += 100;
    await store.read(0, Buffer.alloc(PIECE));

    clock.at += 100;
    await store.write(3, pieceOf(3));
    await store.settled();

    assert.equal(store.has(0), true, "a piece that was just read was thrown away");
    assert.equal(store.has(1), false, "the piece nobody had touched was kept");
  } finally {
    await store.destroy();
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

test("a piece being read is never the victim, however old it is", async () => {
  const { store, directory, clock } = await makeStore(3 * PIECE);
  try {
    for (const index of [0, 1, 2]) {
      clock.at += 100;
      await store.write(index, pieceOf(index));
    }
    // Piece 0 is the oldest AND is being read. The read is not awaited, so the
    // write below decides while it is still outstanding.
    const reading = store.read(0, Buffer.alloc(PIECE));
    clock.at += 100;
    await store.write(3, pieceOf(3));
    const bytes = await reading;
    await store.settled();

    assert.equal(bytes, PIECE, "the read did not complete");
    assert.equal(store.has(0), true, "a piece being read was thrown away under the reader");
    assert.equal(store.has(1), false, "the next oldest should have gone instead");
  } finally {
    await store.destroy();
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

test("a piece thrown away is answered as absent, so the swarm is asked for it again", async () => {
  const { store, directory, clock } = await makeStore(PIECE);
  try {
    await store.write(0, pieceOf(0));
    clock.at += 100;
    await store.write(1, pieceOf(1));
    await store.settled();

    assert.equal(store.has(0), false, "the store still claims a piece it threw away");
    await assert.rejects(
      () => store.read(0, Buffer.alloc(PIECE)),
      /Piece 0 is not on disk/,
      "reading a thrown-away piece must say so rather than answer bytes"
    );
  } finally {
    await store.destroy();
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

test("a piece wanted again after being thrown away is written, not refused", async () => {
  const { store, directory, clock } = await makeStore(PIECE);
  try {
    await store.write(0, pieceOf(0));
    clock.at += 100;
    await store.write(1, pieceOf(1));
    clock.at += 100;
    // Piece 0 again, while its own removal may still be in flight.
    await store.write(0, pieceOf(0));
    await store.settled();

    assert.equal(store.has(0), true, "the piece did not come back");
    const target = Buffer.alloc(PIECE);
    await store.read(0, target);
    assert.ok(target.equals(pieceOf(0)), "the piece came back wrong");
    assert.equal(store.bytes, PIECE, "the store is over its allowance");
  } finally {
    await store.destroy();
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

test("lowering the allowance frees nothing by itself, and binds the next write", async () => {
  const { store, directory, clock } = await makeStore(null);
  try {
    for (const index of [0, 1, 2]) {
      clock.at += 100;
      await store.write(index, pieceOf(index));
    }
    store.reviseAllowance(PIECE);
    assert.equal(store.size, 3, "lowering the allowance threw pieces away on its own");

    clock.at += 100;
    await store.write(3, pieceOf(3));
    await store.settled();
    assert.equal(store.size, 1, "the next write did not bring it within the allowance");
    assert.deepEqual(await onDisk(store), { files: 1, bytes: PIECE });
  } finally {
    await store.destroy();
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

test("an allowance smaller than one piece keeps the arriving piece rather than losing it", async () => {
  // A piece the swarm has already paid for is not thrown away because the
  // arithmetic says there is no room for anything: the alternative is fetching
  // it again, which costs ~1430 ms against a write measured in milliseconds.
  const { store, directory } = await makeStore(1);
  try {
    await store.write(0, pieceOf(0));
    await store.settled();
    assert.equal(store.has(0), true, "the arriving piece was refused");
    assert.equal(store.size, 1);
  } finally {
    await store.destroy();
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

test("destroying it takes the directory with it", async () => {
  const { store, directory } = await makeStore(null);
  await store.write(0, pieceOf(0));
  const where = store.path;
  await store.destroy();
  await assert.rejects(() => fs.stat(where), /ENOENT/, "the store left its directory behind");
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
});

test("the spill ceiling is what the disk's owner said, divided between the stores", async () => {
  const { reviseSpillBudgets, SharedPieceStore } = await import("../services/piece-store/shared-piece-store.js");
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "spill-share-"));
  const stores = [
    new SharedPieceStore(PIECE, { length: PIECE * 8, memoryBytes: PIECE, path: directory, name: "one" }),
    new SharedPieceStore(PIECE, { length: PIECE * 8, memoryBytes: PIECE, path: directory, name: "two" })
  ];
  try {
    const revised = reviseSpillBudgets(100 * PIECE, stores);
    assert.deepEqual(
      revised.map((store) => store.allowanceBytes),
      [50 * PIECE, 50 * PIECE],
      "one thread's share is divided equally between its stores"
    );

    // Nobody has said yet: nothing is thrown away, which is what it always did.
    assert.deepEqual(
      reviseSpillBudgets(null, stores).map((store) => store.allowanceBytes),
      [null, null]
    );
  } finally {
    for (const store of stores) {
      await new Promise((resolve) => store.destroy(resolve));
    }
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

test("what lies behind every reader goes without waiting for the disk to be short", async () => {
  // THE SECOND RULE. The ceiling is a share of free space, and on a roomy host
  // that is tens of gigabytes against a measured growth of 14 400 MB in one
  // viewing — so the ceiling alone never binds and nothing is removed until the
  // torrent itself goes. A piece behind every read head has been read.
  const { store, directory } = await makeStore(1000 * PIECE);
  try {
    for (const index of [0, 1, 2, 3, 4, 5]) {
      await store.write(index, pieceOf(index));
    }

    const removed = store.forgetBehind([3, 4]);
    await store.settled();

    assert.equal(removed, 3, "the three behind the earliest reader should have gone");
    assert.deepEqual([0, 1, 2].map((index) => store.has(index)), [false, false, false]);
    assert.deepEqual([3, 4, 5].map((index) => store.has(index)), [true, true, true]);
    assert.equal(store.stats().behind, 3);
  } finally {
    await store.destroy();
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

test("with no reader at all, nothing is thrown away", async () => {
  // A store between reads is not a store nobody wants. What empties it whole is
  // the torrent going idle, which removes the store and its directory.
  const { store, directory } = await makeStore(1000 * PIECE);
  try {
    for (const index of [0, 1, 2]) {
      await store.write(index, pieceOf(index));
    }
    assert.equal(store.forgetBehind([]), 0);
    assert.equal(store.size, 3);
  } finally {
    await store.destroy();
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

test("a piece being read is not taken even when it is behind everybody", async () => {
  const { store, directory } = await makeStore(1000 * PIECE);
  try {
    await store.write(0, pieceOf(0));
    await store.write(5, pieceOf(5));
    const reading = store.read(0, Buffer.alloc(PIECE));
    const removed = store.forgetBehind([5]);
    await reading;
    await store.settled();

    assert.equal(removed, 0, "a piece under a reader was thrown away");
    assert.equal(store.has(0), true);
  } finally {
    await store.destroy();
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

test("when there is no room, what is behind the readers goes before what is ahead", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "piece-disk-heads-"));
  const clock = { at: 1000 };
  // The reader stands on #5. #4 is behind it and was touched LAST, so under the
  // old rule — least recently used — it would have been the safest piece there.
  const store = new PieceDiskStore({
    directory,
    name: "pieces",
    chunkLength: PIECE,
    allowanceBytes: 3 * PIECE,
    now: () => clock.at,
    readHeads: () => [5]
  });
  try {
    for (const index of [8, 7, 4]) {
      clock.at += 100;
      await store.write(index, pieceOf(index));
    }
    clock.at += 100;
    await store.write(9, pieceOf(9));
    await store.settled();

    assert.equal(store.has(4), false, "the piece behind the reader was kept because it was touched last");
    assert.deepEqual([7, 8, 9].map((index) => store.has(index)), [true, true, true]);
  } finally {
    await store.destroy();
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

test("a store takes up the pieces a previous life left in its directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "adopt-"));
  try {
    const first = new PieceDiskStore({ directory: root, name: "film.pieces", chunkLength: 1024 });
    await first.write(7, Buffer.alloc(1024, 7));
    await first.write(9, Buffer.alloc(1024, 9));
    await first.close();

    // A torrent torn down and added again gets a NEW store over the same
    // directory. Before 2026-09-11 its index started empty, so every piece it
    // in fact had read as missing and the film was downloaded a second time
    // while the first copy sat beside it.
    const second = new PieceDiskStore({ directory: root, name: "film.pieces", chunkLength: 1024 });
    assert.equal(second.size, 2, "the pieces already on disk were not taken up");
    assert.equal(second.bytes, 2048, "nor were their bytes counted");
    assert.ok(second.has(7) && second.has(9));

    const target = Buffer.alloc(1024);
    await second.read(7, target);
    assert.ok(target.equals(Buffer.alloc(1024, 7)), "and they read back as themselves");
    await second.destroy();
  } finally {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});
