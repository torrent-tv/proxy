/**
 * @file The time a fresh output takes to its first piece, computed rather than
 * remembered, and the cold start of each output said once (torrent-tv/meta#3).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { ColdStarts, secondsToFirstPiece } from "../../services/encode/quality/ColdStarts.js";

test("a fresh output owes the measured wait for a first output when one piece is quicker", () => {
  // The addon host's first segment, field 2026-08-31, against a 4 s piece at 2.4x.
  assert.equal(secondsToFirstPiece({ firstByteWaitSec: 8.4, segmentDurationSec: 4, speed: 2.4 }), 8.4);
});

test("and one piece at the output's own speed when that is longer", () => {
  // A step encoded below realtime: the piece itself is the wait.
  assert.equal(secondsToFirstPiece({ firstByteWaitSec: 1, segmentDurationSec: 4, speed: 0.5 }), 8);
});

test("with no measured wait, a piece cannot appear before it is encoded", () => {
  assert.equal(secondsToFirstPiece({ firstByteWaitSec: 0, segmentDurationSec: 4, speed: 2 }), 2);
});

test("with no known speed the time is unknown, not the wait alone", () => {
  // The wait alone would be a lower bound, and a lower bound here would let a
  // step be taken that the buffer cannot cover.
  assert.equal(secondsToFirstPiece({ firstByteWaitSec: 8.4, segmentDurationSec: 4, speed: 0 }), null);
});

test("each output's cold start is measured once, from the request that created it", () => {
  const cold = new ColdStarts();
  const output = {};
  cold.noteOutputCreated(output, 1_000);
  assert.equal(cold.noteSegmentServed(output, 9_400), 8_400);
  assert.equal(cold.noteSegmentServed(output, 12_000), null, "a later segment is not a cold start");
  assert.equal(cold.noteSegmentServed({}, 12_000), null, "an output this process did not create is not measured");
});
