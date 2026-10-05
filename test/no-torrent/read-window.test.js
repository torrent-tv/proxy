/** Reads consume the published map without declaring download demand. */

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import {
  readFragments
} from "../../services/torrent/worker/piece-reader.js";
import { demandFor, forgetTorrent } from "../../services/torrent/download/registry.js";
import { SharedPieceStore } from "../../services/storage/piece-store/shared-piece-store.js";

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
  // ROOM FOR THE WHOLE FIXTURE, because none of these tests is about eviction.
  // At 64 pieces of memory an 8000-piece fixture spilled 7936 of them to disk —
  // a file each — and read most of them back, so four checks about which piece
  // RANGES a reader claims cost 25-28 seconds apiece and this one file took
  // 132 s of a 140 s suite. The store's own behaviour under pressure is
  // measured where that is the subject (`piece-store-eviction`,
  // `piece-lru`, `piece-disk-store`).
  const store = new SharedPieceStore(PIECE, {
    length: totalLength,
    memoryBytes: totalLength,
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
    forgetTorrent(torrent);
    store.destroy(() => undefined);
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

test("a finished read leaves nothing selected", async () => {
  const { torrent, store, directory } = await recordingTorrent({ pieceCount: 40 });
  try {
    await drain(torrent, 0, 40 * PIECE - 1);
    assert.deepEqual(torrent.held, [], "the read kept its claim after finishing");
  } finally {
    forgetTorrent(torrent);
    store.destroy(() => undefined);
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
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
    forgetTorrent(torrent);
    store.destroy(() => undefined);
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
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
    forgetTorrent(torrent);
    store.destroy(() => undefined);
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});



test("a missing mapped piece waits without creating reader claims and map withdrawal ends the wait", async () => {
  const { torrent, store, directory } = await recordingTorrent({ pieceCount: 1, present: () => false });
  try {
    const register = demandFor(torrent).register;
    register.state({ claimant: "priority-map:test", fileIndex: 0, byteStart: 0, byteEnd: PIECE - 1, urgency: 0 });
    const iterator = readFragments({ torrent, fileIndex: 0, start: 0, end: PIECE - 1,
      cancellation: { isCancelled: () => false } });
    const pending = iterator.next();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(register.size, 1);
    assert.deepEqual(torrent.calls, []);
    assert.equal(torrent.listenerCount("verified"), 2, "the reader adds one subscription beside the scheduler");
    register.withdraw("priority-map:test");
    torrent.emit("priority-map-changed", 0);
    await assert.rejects(pending, { code: "SOURCE_RANGE_NOT_WANTED", canRetry: false });
    assert.equal(torrent.listenerCount("verified"), 1, "only the scheduler remains after the read ends");
    assert.equal(torrent.listenerCount("priority-map-changed"), 0);
    assert.equal(store.stats().pinned, 0);
  } finally {
    forgetTorrent(torrent);
    store.destroy(() => undefined);
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

test("missing bytes outside the map fail without selecting pieces or waiting", async () => {
  const { torrent, store, directory } = await recordingTorrent({ pieceCount: 1, present: () => false });
  try {
    const iterator = readFragments({ torrent, fileIndex: 0, start: 0, end: PIECE - 1,
      cancellation: { isCancelled: () => false } });
    await assert.rejects(iterator.next(), { code: "SOURCE_RANGE_NOT_WANTED" });
    assert.deepEqual(torrent.calls, []);
    assert.equal(demandFor(torrent).register.size, 0);
    assert.equal(torrent.listenerCount("verified"), 1, "only the scheduler remains after the read ends");
  } finally {
    forgetTorrent(torrent);
    store.destroy(() => undefined);
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});

test("cancellation during listener registration removes every piece wait subscription", async () => {
  const { torrent, store, directory } = await recordingTorrent({ pieceCount: 1, present: () => false });
  try {
    demandFor(torrent).register.state({ claimant: "priority-map:test", fileIndex: 0,
      byteStart: 0, byteEnd: PIECE - 1, urgency: 0 });
    let detached = 0;
    const iterator = readFragments({ torrent, fileIndex: 0, start: 0, end: PIECE - 1,
      cancellation: { isCancelled: () => false, onCancel: listener => {
        listener();
        return () => { detached++; };
      } } });
    await assert.rejects(iterator.next(), /Read cancelled/);
    assert.equal(detached, 1);
    assert.equal(torrent.listenerCount("verified"), 1, "only the scheduler remains after the read ends");
    assert.equal(torrent.listenerCount("close"), 0);
    assert.equal(torrent.listenerCount("priority-map-changed"), 0);
    assert.equal(store.stats().pinned, 0);
  } finally {
    forgetTorrent(torrent);
    store.destroy(() => undefined);
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
  }
});
