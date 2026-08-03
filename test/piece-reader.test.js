/**
 * @file Turning a byte range into positions in shared memory.
 *
 * This arithmetic fails silently when it is wrong: the response comes back the
 * right length and full of the wrong bytes. Piece numbers are torrent-wide
 * while a read is expressed in file coordinates, and the first and last pieces
 * of a range are almost always partial — so every case here is a boundary.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFragments } from "../services/torrent-worker/piece-reader.js";
import { SharedPieceStore } from "../services/piece-store/shared-piece-store.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";

const PIECE = 1024;

/**
 * A torrent whose pieces are all present, backed by a real store so that
 * `locate`/`reside`/`pin` behave as they do in production.
 *
 * @param {{ fileOffset: number, fileLength: number, totalLength: number }} shape
 */
async function fakeTorrent({ fileOffset, fileLength, totalLength }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "piece-reader-test-"));
  const store = new SharedPieceStore(PIECE, {
    length: totalLength,
    memoryBytes: 64 * PIECE,
    path: directory,
    name: "test"
  });

  const pieceCount = Math.ceil(totalLength / PIECE);
  for (let index = 0; index < pieceCount; index += 1) {
    const length = index === pieceCount - 1 ? totalLength - index * PIECE : PIECE;
    const piece = Buffer.alloc(length);
    // Each byte encodes its own absolute position, so a misplaced offset is
    // visible in the value itself rather than only in the length.
    for (let at = 0; at < length; at += 1) {
      piece[at] = (index * PIECE + at) % 251;
    }
    await new Promise((resolve, reject) => {
      store.put(index, piece, (error) => (error ? reject(error) : resolve()));
    });
  }

  const torrent = Object.assign(new EventEmitter(), {
    pieceLength: PIECE,
    store,
    bitfield: { get: () => true },
    files: [{ offset: fileOffset, length: fileLength, name: "file.bin" }],
    select() {},
    critical() {}
  });

  return { torrent, store, directory };
}

/** Collect a range through the reader, as the worker does. */
async function readRange(torrent, start, end) {
  const collected = [];
  const positions = [];
  const pool = Buffer.from(torrent.store.sharedBuffer);
  for await (const fragment of readFragments({
    torrent,
    fileIndex: 0,
    start,
    end,
    cancellation: { isCancelled: () => false }
  })) {
    collected.push(Buffer.from(pool.subarray(fragment.offset, fragment.offset + fragment.length)));
    positions.push({ piece: fragment.pieceIndex, length: fragment.length });
    fragment.release();
  }
  return { bytes: Buffer.concat(collected), positions };
}

/** What the bytes at an absolute torrent offset should be. */
function expectedBytes(absoluteStart, length) {
  const expected = Buffer.alloc(length);
  for (let at = 0; at < length; at += 1) {
    expected[at] = (absoluteStart + at) % 251;
  }
  return expected;
}

test("a range inside one piece is read from that piece only", async () => {
  const { torrent, store, directory } = await fakeTorrent({
    fileOffset: 0,
    fileLength: 4 * PIECE,
    totalLength: 4 * PIECE
  });
  try {
    const { bytes, positions } = await readRange(torrent, 100, 199);
    assert.equal(positions.length, 1);
    assert.deepEqual(bytes, expectedBytes(100, 100));
  } finally {
    store.destroy(() => undefined);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a range spanning pieces reassembles in order", async () => {
  const { torrent, store, directory } = await fakeTorrent({
    fileOffset: 0,
    fileLength: 4 * PIECE,
    totalLength: 4 * PIECE
  });
  try {
    const start = PIECE - 10;
    const end = 2 * PIECE + 9;
    const { bytes, positions } = await readRange(torrent, start, end);
    assert.deepEqual(positions.map((entry) => entry.piece), [0, 1, 2]);
    assert.deepEqual(bytes, expectedBytes(start, end - start + 1));
  } finally {
    store.destroy(() => undefined);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a file that does not start at a piece boundary is still read correctly", async () => {
  // The usual case in a multi-file torrent, and the one where using file
  // offsets as if they were torrent offsets returns the wrong bytes at the
  // right length.
  const fileOffset = PIECE + 300;
  const { torrent, store, directory } = await fakeTorrent({
    fileOffset,
    fileLength: 2 * PIECE,
    totalLength: 5 * PIECE
  });
  try {
    const { bytes } = await readRange(torrent, 0, 1499);
    assert.deepEqual(bytes, expectedBytes(fileOffset, 1500));
  } finally {
    store.destroy(() => undefined);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("every fragment releases its pin, so nothing stays held", async () => {
  const { torrent, store, directory } = await fakeTorrent({
    fileOffset: 0,
    fileLength: 4 * PIECE,
    totalLength: 4 * PIECE
  });
  try {
    await readRange(torrent, 0, 4 * PIECE - 1);
    // With every piece unpinned the store can still make room; if a pin leaked
    // it would eventually refuse.
    const before = store.stats().blockedByPins;
    for (let index = 0; index < 200; index += 1) {
      await store.reside(index % 4);
    }
    assert.equal(store.stats().blockedByPins, before, "a pin was left behind");
  } finally {
    store.destroy(() => undefined);
    await fs.rm(directory, { recursive: true, force: true });
  }
});
