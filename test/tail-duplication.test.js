/**
 * @file Asking a second wire for the blocks a reader is still waiting on.
 *
 * Measured on a real swarm 2026-08-19: a blocked read's tail is 2-14 blocks of
 * 512, and it sits on wires at 109-886 KB/s — above the 48 KB/s gate that
 * WebTorrent's own `_hotswap` requires, so the library never duplicates them.
 * The mechanism is the library's: free the reservation with `Piece.cancel` and
 * leave the first request in flight, then ask a second wire through the
 * library's own request path.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { duplicateTailFor } from "../services/torrent-worker/fastest-wires.js";

/** A piece with `chunks` blocks, of which `missing` at the end are absent. */
function piece(chunks, missing) {
  const buffer = new Array(chunks);
  for (let index = 0; index < chunks - missing; index += 1) {
    buffer[index] = new Uint8Array(1);
  }
  const cancelled = [];
  return {
    _buffer: buffer,
    _chunks: chunks,
    cancel: (index) => cancelled.push(index),
    cancelled
  };
}

function wire({ speed = 500_000, has = true } = {}) {
  return {
    peerPieces: { get: () => has },
    downloadSpeed: () => speed,
    peerChoking: false,
    destroyed: false,
    requests: []
  };
}

test("the missing blocks are freed and asked of a second wire", () => {
  const target = piece(512, 3);
  const placed = [];
  const torrent = {
    pieces: [target],
    wires: [wire({ speed: 900_000 }), wire({ speed: 800_000 }), wire({ speed: 700_000 })],
    _request: (wireAsked, index) => {
      placed.push({ wireAsked, index });
      return true;
    }
  };

  const result = duplicateTailFor(torrent, 0);

  assert.equal(result.missing, 3, "the tail is what is still absent from the piece");
  assert.equal(result.duplicated, 3);
  assert.deepEqual(target.cancelled, [509, 510, 511], "each block's reservation is freed first");
  assert.equal(placed.length, 3, "and each is then asked of a wire through the library's own path");
  assert.equal(placed[0].wireAsked, torrent.wires[0], "fastest wire first");
});

test("at most one duplicate per wire, however long the tail", () => {
  const target = piece(512, 16);
  const torrent = {
    pieces: [target],
    wires: [wire(), wire()],
    _request: () => true
  };

  const result = duplicateTailFor(torrent, 0);

  assert.equal(result.duplicated, 2, "two wires, two duplicates — the rest waits for the next attempt");
  assert.equal(target.cancelled.length, 2, "and no reservation is freed that nobody was asked for");
});

test("a piece still arriving normally is not duplicated at all", () => {
  // Forty blocks outstanding is not a tail, it is a piece in transit. Asking
  // for a second copy of it would spend the shared link on bytes that are
  // already on their way — which is the whole difference between this and the
  // 2-14 blocks a blocked reader was measured waiting on.
  const target = piece(512, 40);
  const torrent = {
    pieces: [target],
    wires: [wire(), wire()],
    _request: () => true
  };

  const result = duplicateTailFor(torrent, 0);

  assert.equal(result.duplicated, 0);
  assert.equal(target.cancelled.length, 0, "and nothing is freed either");
});

test("a wire whose pipeline is full does not end the attempt", () => {
  // Pipelines are per wire, so one wire being full says nothing about the next.
  // This used to stop the whole pass on the first refusal, on the stated
  // reasoning that the remaining wires were "no emptier" — an assumption about
  // other peers' queues that nothing measures.
  const target = piece(512, 5);
  const torrent = {
    pieces: [target],
    wires: [wire(), wire(), wire()],
    // The library refuses when the wire already has as many requests as its
    // measured speed justifies.
    _request: () => false
  };

  const result = duplicateTailFor(torrent, 0);

  assert.equal(result.duplicated, 0);
  assert.equal(
    target.cancelled.length,
    3,
    "every wire was offered a block; a freed reservation nobody took is handed to whoever asks next"
  );
});

test("a refusal by one wire does not cost the block a faster wire would have taken", () => {
  const target = piece(512, 3);
  const placed = [];
  const torrent = {
    pieces: [target],
    wires: [wire({ speed: 900_000 }), wire({ speed: 800_000 })],
    _request: (wireAsked, index) => {
      // The first wire is full; the second is not.
      if (wireAsked === torrent.wires[0]) {
        return false;
      }
      placed.push(index);
      return true;
    }
  };

  const result = duplicateTailFor(torrent, 0);

  assert.equal(result.duplicated, 1);
  assert.deepEqual(placed, [0], "the second wire was still asked");
});

test("a piece with nothing missing is left alone", () => {
  const target = piece(4, 0);
  const torrent = { pieces: [target], wires: [wire()], _request: () => true };

  const result = duplicateTailFor(torrent, 0);

  assert.equal(result.duplicated, 0);
  assert.equal(result.missing, 0);
  assert.equal(target.cancelled.length, 0);
});

test("with no wire holding the piece there is nothing to duplicate onto", () => {
  const target = piece(8, 2);
  const torrent = { pieces: [target], wires: [wire({ has: false })], _request: () => true };

  const result = duplicateTailFor(torrent, 0);

  assert.equal(result.wires, 0);
  assert.equal(result.duplicated, 0);
  assert.equal(target.cancelled.length, 0, "and no reservation is freed for nobody");
});

test("a completed piece is not touched", () => {
  assert.deepEqual(
    duplicateTailFor({ pieces: [null], wires: [wire()], _request: () => true }, 0),
    { duplicated: 0, missing: 0, wires: 0 }
  );
});
