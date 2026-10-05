/**
 * @file When a move to a smaller output is prepared for a viewer, and when it is
 * not (roadmap item 98), and which way their buffer is going.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { drainThreat } from "../../services/encode/quality/drain-threat.js";
import { bufferTrend } from "../../services/viewer/buffer-trend.js";

test("a buffer that falls but lasts past the new piece's readiness moves nothing", () => {
  // 60 s held, draining at 0.5 s/s: empty in 120 s. The new output would have
  // the piece in 8 s, and the next report comes in 10 s.
  const answer = drainThreat({ bufferedSec: 60, slope: -0.5, reportGapSec: 10, secondsToReady: 8 });
  assert.equal(answer.threat, false);
  assert.equal(answer.secondsToEmpty, 120);
});

test("a buffer that would end before the new piece is ready starts the move", () => {
  // 6 s held, draining at 0.5 s/s: empty in 12 s — sooner than 8 s of making
  // plus the 10 s until this viewer is heard from again.
  assert.equal(drainThreat({ bufferedSec: 6, slope: -0.5, reportGapSec: 10, secondsToReady: 8 }).threat, true);
});

test("the wait for the next report is part of the reckoning", () => {
  const without = drainThreat({ bufferedSec: 10, slope: -1, reportGapSec: 0, secondsToReady: 8 });
  const withGap = drainThreat({ bufferedSec: 10, slope: -1, reportGapSec: 3, secondsToReady: 8 });
  assert.equal(without.threat, false, "10 s left against 8 s of making");
  assert.equal(withGap.threat, true, "but the next chance to act is 3 s away, too late");
});

test("a buffer that holds or grows is no threat, and neither is one with no trend yet", () => {
  assert.equal(drainThreat({ bufferedSec: 1, slope: 0, reportGapSec: 10, secondsToReady: 30 }).threat, false);
  assert.equal(drainThreat({ bufferedSec: 1, slope: 0.4, reportGapSec: 10, secondsToReady: 30 }).threat, false);
  assert.equal(drainThreat({ bufferedSec: 1, slope: null, reportGapSec: 10, secondsToReady: 30 }).threat, false);
});

test("a readiness nobody can state is not assumed to be quick", () => {
  assert.equal(drainThreat({ bufferedSec: 600, slope: -0.1, reportGapSec: 10, secondsToReady: null }).threat, true);
});

test("the trend is read over one segment's period, not from two readings", () => {
  // A sawtooth over a flat line: a 4 s segment arrives, then 4 s play out.
  const at = (seconds) => seconds * 1000;
  const flat = [
    { at: at(0), seconds: 20 },
    { at: at(2), seconds: 18 },
    { at: at(4), seconds: 20 },
    { at: at(6), seconds: 18 },
    { at: at(8), seconds: 20 }
  ];
  const trend = bufferTrend(flat, 4);
  assert.ok(Math.abs(trend.slope) < 0.5, `the last two readings alone say +1 s/s; the period says ${trend.slope}`);
  assert.equal(trend.reportGapSec, 2);
});

test("readings that do not yet span one segment say nothing", () => {
  assert.equal(bufferTrend([{ at: 0, seconds: 10 }, { at: 1000, seconds: 9 }], 4), null);
  assert.equal(bufferTrend([{ at: 0, seconds: 10 }], 4), null);
});

test("a steady drain reads as the rate it drains at", () => {
  const readings = [0, 5, 10].map((second) => ({ at: second * 1000, seconds: 30 - second }));
  assert.equal(bufferTrend(readings, 4).slope, -1);
});
