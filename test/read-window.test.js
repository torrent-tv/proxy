/**
 * @file What a read asks the torrent to download, and what it gives back.
 *
 * A read used to select its whole requested range and never deselect it.
 * ffmpeg opens its input as `bytes <position>-<EOF>`, so the first read of a
 * session claimed the entire file and marked every piece of it critical — and
 * the claim outlived the read, which is abandoned a second later when ffmpeg
 * seeks. Nothing after that could outrank it: measured on a 4.7 GB film, a seek
 * to 89.1% waited 93 s while the swarm fetched 2.47 GB in file order.
 *
 * Now a read holds a moving window and returns it when it ends. These tests pin
 * the three properties that matter: the claim is bounded, it is given back, and
 * several readers add up instead of overwriting each other.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { readFragments, readWindowFor } from "../services/torrent-worker/piece-reader.js";
import { SharedPieceStore } from "../services/piece-store/shared-piece-store.js";

const PIECE = 1024;
// The production window is 32 MB against 8 MiB pieces — four of them. Sized
// here in pieces so the test does not depend on either constant.
const WINDOW_PIECES = 4;

/**
 * A torrent that records every selection call instead of downloading anything.
 *
 * @param {{ pieceCount: number, present?: (index: number) => boolean }} shape
 */
async function recordingTorrent({ pieceCount, present = () => true }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "read-window-test-"));
  const totalLength = pieceCount * PIECE;
  const store = new SharedPieceStore(PIECE, {
    length: totalLength,
    memoryBytes: 64 * PIECE,
    path: directory,
    name: "test"
  });
  for (let index = 0; index < pieceCount; index += 1) {
    await new Promise((resolve, reject) => {
      store.put(index, Buffer.alloc(PIECE, index % 251), (error) => (error ? reject(error) : resolve()));
    });
  }

  /** @type {Array<{ call: string, from: number, to: number, stream?: boolean }>} */
  const calls = [];
  /** Live stream selections, as WebTorrent counts them: exact bounds, duplicates allowed. */
  const held = [];

  const torrent = Object.assign(new EventEmitter(), {
    pieceLength: PIECE,
    store,
    bitfield: { get: (index) => present(index) },
    files: [{ offset: 0, length: totalLength, name: "file.bin" }],
    _critical: [],
    calls,
    held,
    _select(from, to, _priority, _notify, isStreamSelection) {
      calls.push({ call: "select", from, to, stream: isStreamSelection === true });
      held.push(`${from}-${to}`);
    },
    _deselect(from, to, isStreamSelection) {
      calls.push({ call: "deselect", from, to, stream: isStreamSelection === true });
      const at = held.indexOf(`${from}-${to}`);
      if (at >= 0) {
        held.splice(at, 1);
      }
    },
    critical(from, to) {
      calls.push({ call: "critical", from, to });
      for (let index = from; index <= to; index += 1) {
        this._critical[index] = true;
      }
    }
  });

  return { torrent, store, directory };
}

/** Read a range to the end, releasing every fragment. */
async function drain(torrent, start, end) {
  for await (const fragment of readFragments({
    torrent,
    fileIndex: 0,
    start,
    end,
    cancellation: { isCancelled: () => false }
  })) {
    fragment.release();
  }
}

test("the window is bounded and clamped to the end of the read", () => {
  assert.deepEqual(readWindowFor({ pieceIndex: 10, lastPiece: 999, windowPieces: 4 }), { from: 10, to: 13 });
  assert.deepEqual(
    readWindowFor({ pieceIndex: 997, lastPiece: 999, windowPieces: 4 }),
    { from: 997, to: 999 },
    "the window never reaches past the range the reader was given"
  );
  assert.deepEqual(
    readWindowFor({ pieceIndex: 5, lastPiece: 999, windowPieces: 0 }),
    { from: 5, to: 5 },
    "a degenerate size still asks for the piece under the head"
  );
});

test("an open-ended read does not claim the whole file at once", async () => {
  // 8000 pieces of 1 KB — far more than the 32 MB window, so a read to the end
  // of the file is exactly the ffmpeg case.
  const { torrent, store, directory } = await recordingTorrent({ pieceCount: 8000 });
  try {
    // Read only the first two pieces, but ask as ffmpeg does: to the last byte.
    const iterator = readFragments({
      torrent,
      fileIndex: 0,
      start: 0,
      end: 8000 * PIECE - 1,
      cancellation: { isCancelled: () => false },
      windowBytes: WINDOW_PIECES * PIECE
    });
    const first = await iterator.next();
    first.value.release();

    const selects = torrent.calls.filter((entry) => entry.call === "select");
    assert.ok(selects.length >= 1, "the reader claimed nothing");
    const claimed = selects[0].to - selects[0].from + 1;
    assert.equal(
      claimed,
      WINDOW_PIECES,
      `the reader claimed ${claimed} pieces of the file instead of its window`
    );
    assert.equal(selects[0].stream, true, "the claim must be a stream selection, so it can be counted");

    await iterator.return();
  } finally {
    store.destroy(() => undefined);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a finished read leaves nothing selected", async () => {
  const { torrent, store, directory } = await recordingTorrent({ pieceCount: 40 });
  try {
    await drain(torrent, 0, 40 * PIECE - 1);
    assert.deepEqual(torrent.held, [], "the read kept its claim after finishing");
  } finally {
    store.destroy(() => undefined);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("an abandoned read leaves nothing selected", async () => {
  const { torrent, store, directory } = await recordingTorrent({ pieceCount: 8000 });
  try {
    const iterator = readFragments({
      torrent,
      fileIndex: 0,
      start: 0,
      end: 8000 * PIECE - 1,
      cancellation: { isCancelled: () => false },
      windowBytes: WINDOW_PIECES * PIECE
    });
    const first = await iterator.next();
    first.value.release();
    // What ffmpeg does to its opening read the moment it seeks.
    await iterator.return();

    assert.deepEqual(torrent.held, [], "an abandoned read kept its claim forever");
  } finally {
    store.destroy(() => undefined);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("two readers add up, and one leaving takes only its own window", async () => {
  const { torrent, store, directory } = await recordingTorrent({ pieceCount: 8000 });
  try {
    const head = readFragments({
      torrent, fileIndex: 0, start: 0, end: 8000 * PIECE - 1,
      cancellation: { isCancelled: () => false }
    });
    const tail = readFragments({
      torrent, fileIndex: 0, start: 4000 * PIECE, end: 8000 * PIECE - 1,
      cancellation: { isCancelled: () => false }
    });
    (await head.next()).value.release();
    (await tail.next()).value.release();

    assert.equal(torrent.held.length, 2, "the two readers did not both hold a window");
    const [headWindow, tailWindow] = torrent.held;

    await tail.return();
    assert.deepEqual(
      torrent.held,
      [headWindow],
      `leaving reader took the wrong window (expected to remove ${tailWindow})`
    );

    await head.return();
    assert.deepEqual(torrent.held, []);
  } finally {
    store.destroy(() => undefined);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("criticality marks the piece being waited for, not the whole range", async () => {
  // Nothing is present, so the reader blocks on its first piece and marks it.
  let arrived = false;
  const { torrent, store, directory } = await recordingTorrent({
    pieceCount: 8000,
    present: () => arrived
  });
  try {
    const iterator = readFragments({
      torrent, fileIndex: 0, start: 0, end: 8000 * PIECE - 1,
      cancellation: { isCancelled: () => false }
    });
    const pending = iterator.next();
    await new Promise((resolve) => setImmediate(resolve));

    const criticals = torrent.calls.filter((entry) => entry.call === "critical");
    assert.equal(criticals.length, 1);
    assert.ok(
      criticals[0].to - criticals[0].from + 1 <= 3,
      `marked ${criticals[0].to - criticals[0].from + 1} pieces critical; the signal means "blocked here now"`
    );

    arrived = true;
    torrent.emit("verified", 0);
    (await pending).value.release();
    await iterator.return();
  } finally {
    store.destroy(() => undefined);
    await fs.rm(directory, { recursive: true, force: true });
  }
});
