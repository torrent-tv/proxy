/**
 * @file Whether a closed piece holds the whole of its stretch of film.
 *
 * Decided by the encoding from the cut table and the piece's own media; the
 * segment store only keeps what it is given.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { cutOf, judgePiece } from "../services/encode/piece-completeness.js";
import { SEGMENT_CUT_TIME_DELTA_SECONDS } from "../services/encode/output/index.js";

/** Media ending where stated, in the shape a format's reading has. */
const endingAt = (seconds) => ({ end: seconds });
const format = { producedThroughSeconds: (ranges) => ranges?.end ?? null };

/** Cuts every ten seconds, ten pieces. */
const timeline = { segmentCount: 10, publishedStartOf: (index) => index * 10 };

test("a piece must reach its next cut less the delta the muxer is given", () => {
  assert.equal(cutOf(timeline, 3), 40 - SEGMENT_CUT_TIME_DELTA_SECONDS);
});

test("the final piece has no next cut", () => {
  assert.equal(cutOf(timeline, 9), undefined);
  assert.deepEqual(judgePiece(format, endingAt(95), cutOf(timeline, 9)), { whole: true, throughSeconds: 95 });
});

test("an audio piece ending within the delta of its cut is whole", () => {
  // Field 2026-10-01: AAC frames end 4.7389 s into a piece cut at 4.755 s.
  const cut = 4.755 - SEGMENT_CUT_TIME_DELTA_SECONDS;
  assert.equal(judgePiece(format, endingAt(4.738913832199547), cut).whole, true);
});

test("a piece closed short of its cut is not whole", () => {
  // A run killed mid-piece: 84 ms of film where ten seconds were cut.
  assert.deepEqual(judgePiece(format, endingAt(456.084), 466), { whole: false, throughSeconds: 456.084 });
});

test("a piece with no playable media is not whole, whatever its cut", () => {
  assert.deepEqual(judgePiece(format, null, undefined), { whole: false, throughSeconds: null });
});
