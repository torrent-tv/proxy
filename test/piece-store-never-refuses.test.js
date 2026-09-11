/**
 * @file A store that is short of memory must inconvenience a read, never end a
 * torrent.
 *
 * The field failure of 2026-09-11, in one sentence: the store could not hand
 * out a block, threw, the throw travelled out through the torrent client's own
 * write callback, and the client destroyed the torrent. For the rest of the
 * process every read of that film answered `File 1 not found in
 * torrent:d4022ff4…`, `/stats` reported `peers=0 connected of 1186 known`, and
 * the viewer could not open anything until the addon was restarted.
 *
 * Three properties hold it shut, and each is checked here on its own:
 *
 *  1. an arriving piece is never refused — it has the disk;
 *  2. a read on the torrent client's own path takes no block at all, so an
 *     upload can neither wait for memory nor be refused it;
 *  3. a store between readers keeps room for one window, because that is what
 *     the next read asks for and the allowance is otherwise re-derived a
 *     minute later — twelve times slower than a claim gives up.
 */

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SharedPieceStore } from "../services/piece-store/shared-piece-store.js";

const PIECE = 1024;

/**
 * @param {SharedPieceStore} store
 * @param {number} index
 * @returns {Promise<void>}
 */
const put = (store, index) =>
  new Promise((resolve, reject) => {
    store.put(index, Buffer.alloc(PIECE, index % 251), (error) => (error ? reject(error) : resolve()));
  });

/**
 * @param {SharedPieceStore} store
 * @param {number} index
 * @param {{ offset: number, length: number }} range
 * @returns {Promise<Buffer>}
 */
const get = (store, index, range) =>
  new Promise((resolve, reject) => {
    store.get(index, range, (error, bytes) => (error ? reject(error) : resolve(bytes)));
  });

/**
 * @returns {Promise<string>}
 */
const directory = () => fs.mkdtemp(path.join(os.tmpdir(), "never-refuses-"));

test("a piece is never refused for want of memory", async () => {
  const root = await directory();
  // Every block held by a piece that may not leave. The ceiling never falls
  // below two, so this is how a store with nothing to give is reached: what
  // held the blocks in the field was two writes on their way to disk, and a pin
  // reaches the same state deterministically.
  //
  // This one takes the store's own patience to run — it must be seen to give
  // up and keep the piece anyway.
  const store = new SharedPieceStore(PIECE, {
    length: PIECE * 8,
    memoryBytes: PIECE * 2,
    path: root,
    name: "no-block-to-be-had"
  });
  try {
    await put(store, 0);
    await put(store, 1);
    store.pin(0);
    store.pin(1);

    await put(store, 3);
    const stats = store.stats();
    assert.equal(stats.spilled, 1, "the piece is on disk");
    assert.equal(store.locate(3), null, "and not in memory, since no block could be had for it");
    assert.equal(stats.resident, 2, "the pinned pieces were not taken from under their reader");
    assert.ok(
      stats.admittedWithoutSlot >= 1,
      "and the store says so, rather than the torrent client saying it with a destroyed torrent"
    );
    const bytes = await get(store, 3, { offset: 0, length: PIECE });
    assert.equal(bytes.length, PIECE, "and it reads back");
    assert.equal(bytes[0], 3 % 251, "with its own contents");
  } finally {
    await new Promise((resolve) => store.destroy(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a read for the torrent client takes no block and only its own range", async () => {
  const root = await directory();
  const store = new SharedPieceStore(PIECE, {
    length: PIECE * 8,
    memoryBytes: PIECE,
    path: root,
    name: "ranged-read"
  });
  try {
    // Two fit; the third displaces the oldest, which goes to disk.
    await put(store, 0);
    await put(store, 1);
    await put(store, 2);
    const before = store.stats();
    assert.equal(before.spilled, 1, "the first piece is on disk");

    const wanted = 16;
    const bytes = await get(store, 0, { offset: PIECE - wanted, length: wanted });
    assert.equal(bytes.length, wanted, "only what was asked for comes back");
    assert.equal(bytes[0], 0, "and it is that piece's own bytes");

    const after = store.stats();
    assert.equal(
      after.blocksAllocated,
      before.blocksAllocated,
      "and answering it took no block: a peer asks for kilobytes and a piece here is megabytes"
    );
    assert.equal(after.resident, before.resident, "nothing was revived for it");
    assert.equal(after.fromDisk, before.fromDisk + 1, "and the read is counted as coming from disk");
  } finally {
    await new Promise((resolve) => store.destroy(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a store between readers keeps room for one window", async () => {
  const root = await directory();
  const store = new SharedPieceStore(PIECE, {
    length: PIECE * 200,
    memoryBytes: PIECE * 64,
    path: root,
    name: "between-readers"
  });
  try {
    store.protectRange("read-1", 10, 21, 100);
    const asked = store.wantedBytes;
    assert.ok(asked >= PIECE * 12, "with a reader, the window it declared is asked for");

    store.releaseProtection("read-1");
    assert.ok(
      store.wantedBytes >= PIECE * 12,
      "and with the reader gone the floor is still one window — the next read asks for the same again"
    );
  } finally {
    await new Promise((resolve) => store.destroy(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});
