/**
 * @file Whether a closed piece holds the whole of its stretch of film.
 *
 * Decided by the encoding from the cut table and the piece's own media; the
 * segment store only keeps what it is given.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { cutOf, judgePiece, originOf, productionOf } from "../services/encode/piece-completeness.js";
import { SEGMENT_CUT_TIME_DELTA_SECONDS } from "../services/encode/output/index.js";
import { readFileSync } from "node:fs";
import { fmp4Format } from "../services/encode/segment-formats/fmp4.js";

const evidence = JSON.parse(readFileSync(new URL("./fixtures/refused-audio-20261002.json", import.meta.url)));
const captured = (name) => fmp4Format.readMediaRanges(Buffer.from(evidence.files[name], "base64"));

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

test("captured whole AAC pieces survive movie-time truncation and decimal cut subtraction", () => {
  for (const [name, next] of [["making-0-00013.mp4", 81.415], ["making-0-00090.mp4", 618.076]]) {
    const cut = cutOf({ segmentCount: 2, publishedStartOf: () => next }, 0);
    const ranges = captured(name);
    assert.equal(ranges.tracks[0].positionErrorTicks, 48n);
    assert.equal(judgePiece(fmp4Format, ranges, cut).whole, true, name);
    ranges.tracks[0].ranges.at(-1).end -= 1024n;
    assert.equal(judgePiece(fmp4Format, ranges, cut).whole, false, "one lost AAC frame remains a refusal");
  }
});

test("a restarted AAC cut follows its first packet rather than the requested seek", () => {
  const ranges = captured("repair-13.mp4");
  assert.equal(originOf(ranges, 81_364_000n, "soun"), 71_550_667n);
  // The captured first packet is 71.5506667 s, 21.333 ms before -ss 71.572.
  // segment.c adds it to the relative cut (81.415 - 71.572 = 9.843).
  ranges.production = productionOf({ originMicros: 71_550_667n, endMicros: 81_364_000n }, [9.843], 0, "soun");
  assert.equal(ranges.production.cutMicros, 81_343_667n);
  assert.equal(judgePiece(fmp4Format, ranges, 81.365).whole, true);
  ranges.production.endMicros -= 1024n * 1_000_000n / 48_000n;
  assert.equal(judgePiece(fmp4Format, ranges, 81.365).whole, false);
});

test("a muxer's reference clock cannot conceal a shorter multiplexed track", () => {
  const ranges = captured("making-0-00013.mp4");
  ranges.production = productionOf({ originMicros: 0n, endMicros: 81_365_333n }, [81.415], 0, "soun");
  const audio = ranges.tracks[0];
  ranges.tracks.push({ ...audio, kind: "vide", ranges: audio.ranges.map(range => ({ ...range, end: range.end - 4800n })) });
  assert.equal(judgePiece(fmp4Format, ranges, 81.365).whole, false);
});
