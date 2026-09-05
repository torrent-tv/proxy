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
 * Now a read claims only the piece it is STOPPED on, and gives it back when it
 * ends. What should be downloaded ahead of a viewer is the priority map's
 * answer, stated once for the whole file by the side that knows where the
 * viewers are; a read is consumption, not a forecast. Fifteen reads on one file
 * used to declare fifteen windows on a piece store holding sixteen pieces, and
 * half of all evictions then took a piece a reader had declared (field
 * 2026-09-05).
 *
 * These tests pin what is left: a read that is not stopped claims nothing, a
 * read that is stopped claims the pieces it is waiting for and nothing beyond
 * them, and every claim is given back.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import {
  nextWindowPieces,
  readFragments,
  readWindowFor
} from "../services/torrent-worker/piece-reader.js";
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
    _selections: { _items: [] },
    calls,
    held,
    _select(from, to, _priority, _notify, isStreamSelection) {
      calls.push({ call: "select", from, to, stream: isStreamSelection === true });
      held.push(`${from}-${to}`);
      this._selections._items.push({ from, to });
    },
    _deselect(from, to, isStreamSelection) {
      calls.push({ call: "deselect", from, to, stream: isStreamSelection === true });
      const at = held.indexOf(`${from}-${to}`);
      if (at >= 0) {
        held.splice(at, 1);
      }
      const item = this._selections._items.findIndex((one) => one.from === from && one.to === to);
      if (item >= 0) {
        this._selections._items.splice(item, 1);
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

test("a read that is not stopped claims nothing", async () => {
  // 8000 pieces of 1 KB, every one of them present, and the read asks as ffmpeg
  // does: to the last byte of the file. Nothing is missing, so this read is
  // waiting for nothing, so it wants nothing of the swarm — what lies ahead of
  // it belongs to the priority map.
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

    assert.deepEqual(
      torrent.held,
      [],
      "the read declared a window of its own, which is the forecast that has to come from the map"
    );

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

test("two stopped readers add up, and one leaving takes only its own", async () => {
  // Nothing has arrived yet, so both readers are stopped on their first piece
  // and each states it. Two claims, each withdrawn on its own.
  let arrived = false;
  const { torrent, store, directory } = await recordingTorrent({
    pieceCount: 8000,
    present: () => arrived
  });
  try {
    const head = readFragments({
      torrent, fileIndex: 0, start: 0, end: 8000 * PIECE - 1,
      cancellation: { isCancelled: () => false },
      windowBytes: WINDOW_PIECES * PIECE
    });
    const tail = readFragments({
      torrent, fileIndex: 0, start: 4000 * PIECE, end: 8000 * PIECE - 1,
      cancellation: { isCancelled: () => false },
      windowBytes: WINDOW_PIECES * PIECE
    });
    const headPending = head.next();
    const tailPending = tail.next();
    await new Promise((resolve) => setImmediate(resolve));

    const pieceOf = (range) => Number(range.split("-")[0]);
    const held = [...torrent.held];
    assert.ok(held.some((range) => pieceOf(range) < 4000), "the head reader claimed nothing");
    assert.ok(held.some((range) => pieceOf(range) >= 4000), "the tail reader claimed nothing");

    // Let both through to a yield, so ending them runs their `finally` at once.
    arrived = true;
    torrent.emit("verified", 0);
    torrent.emit("verified", 4000);
    (await headPending).value.release();
    (await tailPending).value.release();

    await tail.return();
    const after = [...torrent.held];
    assert.ok(
      after.every((range) => pieceOf(range) < 4000),
      "the tail reader left its claim behind"
    );

    await head.return();
    assert.deepEqual(torrent.held, [], "the last reader left something behind");
  } finally {
    store.destroy(() => undefined);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("criticality marks the window being waited for, not the whole range", async () => {
  // Nothing is present, so the reader blocks on its first piece and marks it.
  let arrived = false;
  const { torrent, store, directory } = await recordingTorrent({
    pieceCount: 8000,
    present: () => arrived
  });
  try {
    const iterator = readFragments({
      torrent, fileIndex: 0, start: 0, end: 8000 * PIECE - 1,
      cancellation: { isCancelled: () => false },
      windowBytes: WINDOW_PIECES * PIECE
    });
    const pending = iterator.next();
    await new Promise((resolve) => setImmediate(resolve));

    const criticals = torrent.calls.filter((entry) => entry.call === "critical");
    assert.equal(criticals.length, 1);
    const marked = criticals[0].to - criticals[0].from + 1;
    // The window, and nothing beyond it. Marking only the blocked piece made
    // the pieces after it arrive strictly one at a time — measured, the first
    // segment after a seek took 7.2 s for four pieces. Marking the whole
    // requested range would be the old mistake: for ffmpeg's input that is
    // every piece to the end of the file, and the flag stops meaning anything.
    assert.equal(marked, WINDOW_PIECES, `marked ${marked} pieces critical`);
    assert.ok(criticals[0].to < 8000 - 1, "criticality must not reach the end of the file");

    arrived = true;
    torrent.emit("verified", 0);
    (await pending).value.release();
    await iterator.return();
  } finally {
    store.destroy(() => undefined);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a reader that is abandoned mid-fragment does not keep the piece pinned", async () => {
  // The pin is taken before the fragment is handed out and released by the
  // consumer — but a seek abandons the iterator between two fragments, and the
  // consumer never gets the chance. Field 2026-08-06: after one seek every slot
  // in the store was pinned, the store answered `Every resident piece is
  // pinned; no slot can be freed` to the WebTorrent client, which closed the
  // store and destroyed the torrent.
  const { torrent, store, directory } = await recordingTorrent({ pieceCount: 40 });
  try {
    const iterator = readFragments({
      torrent,
      fileIndex: 0,
      start: 0,
      end: 40 * PIECE - 1,
      cancellation: { isCancelled: () => false },
      windowBytes: WINDOW_PIECES * PIECE
    });
    await iterator.next(); // held, deliberately NOT released
    await iterator.return(); // what a seek does

    assert.equal(
      store.stats().pinned,
      0,
      "the abandoned fragment's piece is still pinned; slots leak one per seek"
    );
  } finally {
    store.destroy(() => undefined);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

// ------------------------------------------ the window that grows into a lead

test("a wait that mattered widens the window by a piece", () => {
  // Field 2026-08-17: 5.1-5.9 MB/s delivered against ~1 MB/s consumed, and the
  // reader still blocked 47 times in two minutes. The surplus never became
  // distance ahead of the head.
  assert.equal(
    nextWindowPieces({ current: 4, base: 4, ceiling: 12, waitedMs: 1457, waitThresholdMs: 1000 }),
    5
  );
});

test("a piece that was already there gives a piece back", () => {
  assert.equal(
    nextWindowPieces({ current: 7, base: 4, ceiling: 12, waitedMs: 0, waitThresholdMs: 1000 }),
    6
  );
});

test("it never shrinks below what the caller asked for", () => {
  assert.equal(
    nextWindowPieces({ current: 4, base: 4, ceiling: 12, waitedMs: 0, waitThresholdMs: 1000 }),
    4
  );
});

test("it never grows past this reader's share of the store", () => {
  assert.equal(
    nextWindowPieces({ current: 12, base: 4, ceiling: 12, waitedMs: 4453, waitThresholdMs: 1000 }),
    12
  );
  // A ceiling below the base cannot pull the window under it: the caller sized
  // the base from the file's own byte rate, and a store too small to hold it is
  // an argument about memory, not about what the reader needs next.
  assert.equal(
    nextWindowPieces({ current: 4, base: 4, ceiling: 1, waitedMs: 2000, waitThresholdMs: 1000 }),
    4
  );
});

test("a wait exactly at the threshold counts as a wait", () => {
  assert.equal(
    nextWindowPieces({ current: 4, base: 4, ceiling: 9, waitedMs: 1000, waitThresholdMs: 1000 }),
    5
  );
});
