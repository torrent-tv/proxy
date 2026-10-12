/**
 * @file The deadline of an encoder input and the time a run takes to serve
 * its piece (torrent-tv/meta#178).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { secondsToServe, secondsUntilPiece } from "../../services/encode/input-deadline.js";

// The AVI of 2026-10-12: pieces of 4 s; the viewer at 100 s after a seek back,
// the zone #26..#27 stated as 4 s away (its near edge, 104 s).
const grid = Array.from({ length: 40 }, (_, n) => n * 4);

test("a piece inside a zone is reached that much film after the zone's near edge", () => {
  const zones = [{ from: 26, to: 27, withinSeconds: 4 }, { from: 28, to: 39, withinSeconds: 12 }];
  assert.equal(secondsUntilPiece(zones, grid, 26), 4);
  assert.equal(secondsUntilPiece(zones, grid, 27), 8);
  assert.equal(secondsUntilPiece(zones, grid, 30), 20);
});

test("the nearest zone holding the piece decides; no zone or no grid is unknown", () => {
  assert.equal(secondsUntilPiece([{ from: 20, to: 30, withinSeconds: 9 }, { from: 27, to: 27, withinSeconds: 3 }], grid, 27), 3);
  assert.equal(secondsUntilPiece([{ from: 20, to: 25, withinSeconds: 9 }], grid, 27), null);
  assert.equal(secondsUntilPiece([{ from: 27, to: 27, withinSeconds: Infinity }], grid, 27), null);
  assert.equal(secondsUntilPiece([{ from: 27, to: 27, withinSeconds: 3 }], null, 27), null);
});

test("serving a piece takes the open and the film up to it, and the next piece where it waits for the file after it", () => {
  // Open 4.72 s, 4 s of film at 1.3x: the field's first piece named at 7.76 s.
  assert.ok(Math.abs(secondsToServe({ open: 4.72, speed: 1.3, grid, from: 27, serves: 27 }) - (4.72 + 4 / 1.3)) < 1e-9);
  // Read from the keyframe before: two pieces are encoded first.
  assert.ok(Math.abs(secondsToServe({ open: 4.72, speed: 1.3, grid, from: 26, serves: 27 }) - (4.72 + 8 / 1.3)) < 1e-9);
  // A piece published when the next file closes waits for that file too.
  assert.ok(Math.abs(secondsToServe({ open: 1, speed: 16, grid, from: 27, serves: 27, waitsForNext: true }) - (1 + 8 / 16)) < 1e-9);
});

test("an unknown open, speed or grid is unknown", () => {
  assert.equal(secondsToServe({ open: null, speed: 1, grid, from: 1, serves: 1 }), null);
  assert.equal(secondsToServe({ open: 1, speed: 0, grid, from: 1, serves: 1 }), null);
  assert.equal(secondsToServe({ open: 1, speed: 1, grid: null, from: 1, serves: 1 }), null);
});
