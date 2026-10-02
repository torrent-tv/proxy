import assert from "node:assert/strict";
import test from "node:test";
import {
  addRange,
  compare,
  contiguousEnd,
  fromSeconds,
  joins,
  mediaTime,
  toSeconds
} from "../services/viewer/media-time.js";

const at16k = (ticks) => mediaTime(BigInt(ticks), 16000n);

test("a number of seconds is converted to the exact fraction it denotes", () => {
  assert.deepEqual(fromSeconds(0.5), { ticks: 1n, timescale: 2n });
  assert.deepEqual(fromSeconds(-0.25), { ticks: -1n, timescale: 4n });
  assert.equal(toSeconds(fromSeconds(88.67299999999999)), 88.67299999999999);
  // The double nearest 88.673 is not 88.673, and the comparison says so.
  assert.notEqual(compare(fromSeconds(88.673), at16k(1418768)), 0);
  assert.equal(compare(fromSeconds(88.67299999999999), fromSeconds(88.673)), -1);
});

test("equal ticks join whatever their seconds look like", () => {
  const ranges = [];
  addRange(ranges, { start: at16k(0), end: at16k(1418768), frame: at16k(0) });
  addRange(ranges, { start: at16k(1418768), end: at16k(1482768), frame: at16k(0) });
  assert.equal(ranges.length, 1);
  assert.equal(compare(contiguousEnd(ranges, at16k(0)), at16k(1482768)), 0);
});

test("Gecko's bound: a gap joins when twice the gap is within both frames", () => {
  assert.equal(joins(at16k(672), at16k(672), at16k(672)), true);
  assert.equal(joins(at16k(673), at16k(672), at16k(672)), false);
  // A range whose frames are not known allows nothing of its own.
  assert.equal(joins(at16k(336), at16k(0), at16k(672)), true);
  assert.equal(joins(at16k(337), at16k(0), at16k(672)), false);
});

test("WebKit's bound: no gap wider than 2002/24000 s joins, however long the frames", () => {
  const frame = mediaTime(24000n, 24000n);
  assert.equal(joins(mediaTime(2002n, 24000n), frame, frame), true);
  assert.equal(joins(mediaTime(2003n, 24000n), frame, frame), false);
});

test("a merged range keeps the larger frame, as Gecko's Interval::Span does", () => {
  const ranges = [];
  addRange(ranges, { start: at16k(0), end: at16k(1000), frame: at16k(100) });
  addRange(ranges, { start: at16k(1000), end: at16k(2000), frame: at16k(900) });
  addRange(ranges, { start: at16k(2500), end: at16k(3000), frame: at16k(100) });
  assert.equal(ranges.length, 1);
  assert.equal(compare(ranges[0].frame, at16k(900)), 0);
});

test("ranges a browser does not join stay apart, in order", () => {
  const ranges = [];
  addRange(ranges, { start: at16k(5000), end: at16k(6000), frame: at16k(10) });
  addRange(ranges, { start: at16k(0), end: at16k(1000), frame: at16k(10) });
  assert.deepEqual(ranges.map(({ start }) => start.ticks), [0n, 5000n]);
  assert.equal(compare(contiguousEnd(ranges, at16k(500)), at16k(1000)), 0);
  assert.equal(compare(contiguousEnd(ranges, at16k(2000)), at16k(2000)), 0);
});
