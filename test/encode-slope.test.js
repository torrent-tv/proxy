/**
 * @file The slope that turns ffmpeg's progress reports into a preset's speed.
 *
 * Written against the faults a review found in it on 2026-08-15, each of which
 * would have opened the quality ladder rather than closing it: a window of no
 * width at all, and a position ffmpeg reports as the smallest signed 64-bit
 * integer when it has none yet.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { slopeOf } from "../services/hwaccel.js";

const at = (wallSec, outSec) => ({ wallSec, outSec });

test("a steady run measures its own speed", () => {
  assert.equal(slopeOf([at(1, 10), at(2, 14)]), 4);
});

test("a window of no width is refused, however tempting the numbers", () => {
  // Two reports a millisecond apart: 0.042 s of video over 0.001 s of clock is
  // 42x, on a host that may be doing 3x.
  assert.equal(slopeOf([at(1.0, 10), at(1.001, 10.042)], 0.2), null);
});

test("a run that produced nothing between two reports says nothing", () => {
  assert.equal(slopeOf([at(1, 10), at(3, 10)]), null);
});

test("one report is not a measurement", () => {
  assert.equal(slopeOf([at(1, 10)]), null);
  assert.equal(slopeOf([]), null);
});

test("an impossible speed is a fault, not a fast machine", () => {
  // Nothing encodes 640x360 five thousand times realtime; a reading that says
  // so is a measurement fault, and letting it through raises the bar every
  // ladder decision is taken from.
  assert.equal(slopeOf([at(1, 0), at(2, 5000)]), null);
});

test("the narrowest allowed window is honoured", () => {
  assert.equal(slopeOf([at(1.0, 10), at(1.3, 11)], 0.5), null);
  assert.ok(slopeOf([at(1.0, 10), at(1.6, 12)], 0.5) > 0);
});
