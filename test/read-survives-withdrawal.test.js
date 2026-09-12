/**
 * @file A read whose piece is withdrawn under it waits, rather than failing.
 *
 * The store drops a piece once every reader is past it, and the claim is
 * withdrawn with it, so the piece is fetched again. A read that meets the gap in
 * between must therefore WAIT — until 2026-09-12 it threw, ffmpeg read the empty
 * body as the end of the file, the encoder died, and the plan restarted it into
 * the same emptiness: 2432 starts in 23 minutes and a viewer looking at a still
 * picture for 92 minutes.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { readFragments } from "../services/torrent-worker/piece-reader.js";
import { SharedPieceStore } from "../services/piece-store/shared-piece-store.js";

const PIECE = 1024;
const TOTAL = 4 * PIECE;

/**
 * A torrent of four pieces over a real store, whose `reside` can be made to
 * answer "gone" for a chosen piece a chosen number of times — which is what the
 * store does between dropping a piece and the swarm bringing it back.
 *
 * @param {{ emptyFor: number, times: number }} gap
 */
async function torrentWithAGap({ emptyFor, times }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "withdrawal-read-"));
  const store = new SharedPieceStore(PIECE, {
    length: TOTAL,
    memoryBytes: 64 * PIECE,
    path: directory,
    name: "test",
    files: [{ offset: 0, length: TOTAL, name: "file.bin" }]
  });
  for (let index = 0; index < 4; index += 1) {
    const piece = Buffer.alloc(PIECE);
    for (let at = 0; at < PIECE; at += 1) {
      piece[at] = (index * PIECE + at) % 251;
    }
    await new Promise((resolve, reject) => {
      store.put(index, piece, (error) => (error ? reject(error) : resolve()));
    });
  }

  const held = new Set([0, 1, 2, 3]);
  let left = times;
  /** How many times the piece was asked of the store at all. */
  let asked = 0;
  // The gap is injected at the one method that answers "can you produce this
  // piece" — subclassed rather than wrapped, because `findSharedStore` walks
  // the chain looking for the real class and would find the real one behind a
  // facade.
  store.reside = async function resideWithAGap(index) {
    if (index !== emptyFor) {
      return SharedPieceStore.prototype.reside.call(this, index);
    }
    asked += 1;
    if (left > 0) {
      left -= 1;
      // THE CLAIM GOES WITH THE BYTES. That is what makes the wait a wait for a
      // download and not a wait for nothing, and it is what the withdrawal now
      // does in production.
      held.delete(index);
      // Back a moment later, as the swarm brings it: the reader's own wait ends
      // on the torrent's `verified` event.
      setImmediate(() => {
        held.add(index);
        torrent.emit("verified", index);
      });
      return null;
    }
    return SharedPieceStore.prototype.reside.call(this, index);
  };

  const torrent = Object.assign(new EventEmitter(), {
    pieceLength: PIECE,
    store,
    bitfield: { get: (index) => held.has(index) },
    files: [{ offset: 0, length: TOTAL, name: "file.bin" }],
    select() {},
    critical() {}
  });

  return {
    torrent,
    clean: async () => {
      store.destroy(() => undefined);
      await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 20 });
    },
    asksFor: () => asked
  };
}

/** Read a range as the worker does. */
async function readRange(torrent, start, end) {
  const collected = [];
  for await (const fragment of readFragments({
    torrent,
    fileIndex: 0,
    start,
    end,
    cancellation: { isCancelled: () => false }
  })) {
    const source = fragment.buffer
      ? Buffer.from(fragment.buffer, fragment.offset, fragment.length)
      : Buffer.alloc(0);
    collected.push(Buffer.from(source));
    fragment.release();
  }
  return Buffer.concat(collected);
}

function expectedBytes(absoluteStart, length) {
  const expected = Buffer.alloc(length);
  for (let at = 0; at < length; at += 1) {
    expected[at] = (absoluteStart + at) % 251;
  }
  return expected;
}

test("a piece withdrawn once is asked for again and the read completes", async () => {
  // Piece 0 is the case the field met: an encoder restart re-opens its input at
  // byte 0, and byte 0 is behind every read head by then.
  const { torrent, clean, asksFor } = await torrentWithAGap({ emptyFor: 0, times: 1 });
  try {
    const bytes = await readRange(torrent, 0, 2 * PIECE - 1);
    assert.deepEqual(bytes, expectedBytes(0, 2 * PIECE), "the read returns the film, not an empty body");
    assert.equal(asksFor(), 2, "the piece is asked for a second time, not given up on");
  } finally {
    await clean();
  }
});

test("a piece that does not come back ends the read with a named error", async () => {
  const { torrent, clean } = await torrentWithAGap({ emptyFor: 0, times: 5 });
  try {
    await assert.rejects(
      () => readRange(torrent, 0, PIECE - 1),
      // NOT "verified but absent": the claim has been withdrawn, so the honest
      // statement is that the bytes did not come back.
      /piece 0 was withdrawn from the store and did not come back/i,
      "a second emptiness is a failure the caller must hear about"
    );
  } finally {
    await clean();
  }
});

test("every piece of a long read gets its own second chance", async () => {
  // The allowance is per piece: a read of many pieces may legitimately meet the
  // gap more than once, and one exhausted allowance must not condemn the rest.
  const { torrent, clean } = await torrentWithAGap({ emptyFor: 2, times: 1 });
  try {
    const bytes = await readRange(torrent, 0, 4 * PIECE - 1);
    assert.deepEqual(bytes, expectedBytes(0, 4 * PIECE));
  } finally {
    await clean();
  }
});
