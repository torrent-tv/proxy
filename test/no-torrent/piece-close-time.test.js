/**
 * @file How long until a piece of an output is closed (torrent-tv/meta#178).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { secondsUntilClosed } from "../../services/encode/piece-close-time.js";

const NOW = 1_000_000;
const piece = { index: 10, pieceStart: 40, pieceEnd: 44, now: NOW };

test("a closed piece is closed now", () => {
  assert.equal(secondsUntilClosed({ ...piece, closed: true, runs: [], speed: null, openSeconds: null }), 0);
});

test("a run that holds the piece makes the film from where it reached to the piece's end", () => {
  const runs = [{ from: 8, to: -1, startedAt: NOW - 10_000, startSeconds: 32, reachedSeconds: 42 }];
  assert.equal(secondsUntilClosed({ ...piece, closed: false, runs, speed: 0.5, openSeconds: 1 }), 4);
});

test("a run that has produced nothing yet pays what is left of its opening", () => {
  const runs = [{ from: 10, to: 10, startedAt: NOW - 500, startSeconds: 40, reachedSeconds: 40 }];
  assert.equal(secondsUntilClosed({ ...piece, closed: false, runs, speed: 2, openSeconds: 1.5 }), 1 + 2);
});

test("with no run holding it, a run is opened for it", () => {
  const runs = [{ from: 20, to: 30, startedAt: NOW, startSeconds: 80, reachedSeconds: 90 }];
  assert.equal(secondsUntilClosed({ ...piece, closed: false, runs, speed: 2, openSeconds: 1 }), 1 + 2);
});

test("an unknown speed or opening makes the answer unknown", () => {
  assert.equal(secondsUntilClosed({ ...piece, closed: false, runs: [], speed: null, openSeconds: 1 }), null);
  assert.equal(secondsUntilClosed({ ...piece, closed: false, runs: [], speed: 1, openSeconds: null }), null);
});
