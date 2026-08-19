/**
 * @file What a blocked piece's tail looks like, before anything is built on it.
 *
 * The steering shipped in 2.29.0 often places nothing — `steered onto 0 of 9
 * asks (8 peers held it)`, measured 2026-08-18 — because every block of the
 * piece is already reserved and the library will not hand out a second request
 * for the same block. Duplicating those blocks is the standard remedy and costs
 * traffic, so the tail is described first: how much is missing, and on which
 * wires it sits.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { describePieceTail } from "../services/torrent-worker/fastest-wires.js";

/** A torrent whose piece has some blocks in hand and some in flight. */
function torrentWith({ buffer, wires }) {
  return {
    pieces: [{ _buffer: buffer, _chunks: buffer.length }],
    wires
  };
}

function wire({ has = true, blocks = 0, speed = 0, choking = false }) {
  return {
    peerPieces: { get: () => has },
    requests: Array.from({ length: blocks }, () => ({ piece: 0 })),
    downloadSpeed: () => speed,
    peerChoking: choking
  };
}

test("the tail names how much is missing and who is holding it", () => {
  const tail = describePieceTail(
    torrentWith({
      // Four blocks, two already in hand.
      buffer: [new Uint8Array(1), new Uint8Array(1), null, null],
      wires: [
        wire({ blocks: 1, speed: 900_000 }),
        wire({ blocks: 1, speed: 12_000 }),
        wire({ has: true, blocks: 0, speed: 5_000_000 })
      ]
    }),
    0
  );

  assert.equal(tail.missing, 2);
  assert.equal(tail.chunks, 4);
  assert.equal(tail.outstanding.length, 2, "only the wires actually holding a block of it");
  assert.equal(
    tail.outstanding[0].bytesPerSecond,
    12_000,
    "slowest first — that is the wire the read is waiting on"
  );
});

test("a piece nobody is fetching reads as entirely missing, held by nobody", () => {
  const tail = describePieceTail(
    torrentWith({ buffer: [null, null], wires: [wire({ has: false, blocks: 0 })] }),
    0
  );

  assert.equal(tail.outstanding.length, 0);
  assert.equal(tail.missing, 2, "and the missing count still says the piece is untouched");
});

test("a piece no block of which has been reserved is described, not skipped", () => {
  // `torrent-piece` builds its buffer lazily on the first reserve, so a piece
  // the picker has not reached has none. Reading that as "no tail" hid the
  // clearest answer there is: the wait is on nobody having been asked.
  const tail = describePieceTail(
    { pieces: [{ _buffer: null, _chunks: 512 }], wires: [wire({ has: true, blocks: 0, speed: 900_000 })] },
    0
  );

  assert.equal(tail.missing, 512, "every block of it is missing");
  assert.equal(tail.chunks, 512);
  assert.equal(tail.outstanding.length, 0, "and not one of them has been asked for");
});

test("a completed piece is not described at all", () => {
  // WebTorrent nulls `pieces[index]` once the piece is verified and stored.
  assert.equal(describePieceTail({ pieces: [null], wires: [] }, 0), null);
  assert.equal(describePieceTail({ pieces: [], wires: [] }, 0), null);
});

test("a wire that is choking us is named as such", () => {
  const tail = describePieceTail(
    torrentWith({
      buffer: [null],
      wires: [wire({ blocks: 1, speed: 100, choking: true })]
    }),
    0
  );

  assert.equal(tail.outstanding[0].choking, true, "a block reserved by a choking wire is going nowhere");
});
