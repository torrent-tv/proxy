/**
 * @file Whether a closed piece holds the whole of its stretch of film.
 *
 * Decided by the encoding from the cut table and the piece's own media; the
 * segment store only keeps what it is given.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { cutOf, judgeNeighbors, judgePiece, originOf, productionOf } from "../../services/encode/piece-completeness.js";

import { SEGMENT_CUT_TIME_DELTA_SECONDS } from "../../services/encode/output/index.js";
import { readFileSync } from "node:fs";
import { fmp4Format } from "../../services/encode/segment-formats/fmp4.js";

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

test("admitted segments require every track's continuous start and end including the final segment", () => {
  const mediaFormat = { producedThroughSeconds: coverage => coverage.tracks.reduce((end, track) =>
    Math.min(end, Number(track.ranges.at(-1).end) / Number(track.timescale)), Infinity) };
  const video = { kind: "vide", timescale: 1000n, ranges: [{ start: 1000n, end: 1950n, frame: 100n }] };
  const sound = { kind: "soun", timescale: 1000n, ranges: [{ start: 1000n, end: 2000n, frame: 20n }] };
  const interval = { from: 1, to: 2, requiredKinds: ["vide", "soun"] };
  assert.equal(judgePiece(mediaFormat, { tracks: [video, sound] }, 1.98, interval).whole, true);
  assert.equal(judgePiece(mediaFormat, { tracks: [video] }, undefined, interval).reason, "segment-missing-soun");
  const late = { ...video, ranges: [{ start: 1200n, end: 2000n, frame: 100n }] };
  assert.equal(judgePiece(mediaFormat, { tracks: [late, sound] }, undefined, interval).reason, "segment-start-outside-interval-vide");
  const gap = { ...video, ranges: [{ start: 1000n, end: 1200n, frame: 100n }, { start: 1500n, end: 2000n, frame: 100n }] };
  assert.equal(judgePiece(mediaFormat, { tracks: [gap, sound] }, undefined, interval).reason, "segment-gap-within-interval-vide");
  const short = { ...sound, ranges: [{ start: 1000n, end: 1500n, frame: 20n }] };
  assert.equal(judgePiece(mediaFormat, { tracks: [video, short] }, undefined, interval).reason, "segment-end-outside-interval-soun");
});

test("neighbors cannot use opposite one-frame tolerances to leave a two-frame gap", () => {
  const left = { tracks: [{ kind: "soun", timescale: 1000n, productionFrame: 20n,
    ranges: [{ start: 0n, end: 980n, frame: 10n }] }] };
  const right = { tracks: [{ kind: "soun", timescale: 48000n, productionFrame: 960n,
    ranges: [{ start: 48000n, end: 96000n, frame: 960n }] }] };
  assert.equal(judgeNeighbors(left, right).whole, true);
  right.tracks[0].ranges[0].start = 48960n;
  assert.equal(judgeNeighbors(left, right).reason, "neighbor-discontinuity-soun");
  right.tracks[0].ranges[0].start = 46080n;
  assert.equal(judgeNeighbors(left, right).whole, true);
  right.tracks[0].ranges[0].start = 44160n;
  assert.equal(judgeNeighbors(left, right).reason, "neighbor-discontinuity-soun");
});

test("final admitted media retains distinct proven track ends without accepting a truncated track", () => {
  const mediaFormat = { producedThroughSeconds: coverage => Math.min(...coverage.tracks.map(track =>
    Number(track.ranges.at(-1).end) / Number(track.timescale))) };
  const video = { kind: "vide", timescale: 1000n, ranges: [{ start: 880000n, end: 888000n, frame: 42n }] };
  const audio = { kind: "soun", timescale: 1000n, ranges: [{ start: 880000n, end: 888064n, frame: 22n }] };
  const interval = { from: 880, to: 888.064, requiredKinds: ["vide", "soun"] };
  assert.equal(judgePiece(mediaFormat, { tracks: [video, audio] }, undefined, interval).whole, false);
  interval.sourceEnds = { vide: 888, soun: 888.064 };
  assert.equal(judgePiece(mediaFormat, { tracks: [video, audio] }, undefined, interval).whole, true);
  const truncated = { ...audio, ranges: [{ start: 880000n, end: 888000n, frame: 22n }] };
  assert.equal(judgePiece(mediaFormat, { tracks: [video, truncated] }, undefined, interval).reason,
    "segment-end-outside-interval-soun");
});

test("neighbor validation refuses absent tracks and invalid frame clocks", () => {
  const track = { kind: "vide", timescale: 1000n, productionFrame: 40n,
    ranges: [{ start: 0n, end: 1000n, frame: 40n }] };
  assert.equal(judgeNeighbors({ tracks: [] }, { tracks: [track] }).whole, false);
  assert.equal(judgeNeighbors({ tracks: [track] }, { tracks: [track, { ...track, kind: "soun" }] }).reason,
    "neighbor-missing-soun");
  assert.equal(judgeNeighbors({ tracks: [{ ...track, productionFrame: 0n }] }, { tracks: [track] }).reason,
    "neighbor-frame-is-invalid");

});
