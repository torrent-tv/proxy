/**
 * @file A rung is judged against the machine it will actually have.
 *
 * The field case of 2026-08-15, in arithmetic: a copy of the picture took about
 * 0.125 s of work per second of video (7.9-8.0x measured), a 240p rung needed
 * about 1.05, and the two together are more than the one second per second the
 * machine has. The budget priced the copy at nothing, offered the rung, and the
 * viewer watched it fail.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { canSustainOutput } from "../services/hwaccel.js";

// A host that encodes 640x360 at 24 fps about eleven times over, and decodes
// 1080p24 at 2.6x — the addon host's own figures.
const BENCHMARK = [
  { preset: "fast", pixelsPerSec: 17.0e6 },
  { preset: "ultrafast", pixelsPerSec: 67.5e6 }
];
const DECODE_MODEL = { pixelTerm: 0.007742, bitrateTerm: 0, constantTerm: 0 };
const SOURCE = { megapixelsPerSecond: (1920 * 1080 * 24) / 1e6, megabitsPerSecond: 8 };
const RUNG_240P = 426 * 240 * 24;

test("a rung is judged on the machine it will have, not on an empty one", () => {
  const alone = canSustainOutput({
    benchmark: BENCHMARK,
    decodeModel: DECODE_MODEL,
    source: SOURCE,
    outputPixelsPerSec: RUNG_240P
  });
  const beside = canSustainOutput({
    benchmark: BENCHMARK,
    decodeModel: DECODE_MODEL,
    source: SOURCE,
    outputPixelsPerSec: RUNG_240P,
    // The picture is being copied beside it, at the cost the field measured.
    concurrentCostSec: 0.125
  });
  assert.ok(alone.speed !== null && beside.speed !== null);
  assert.ok(beside.speed < alone.speed, "sharing the machine cannot make a rung faster");
});

test("nothing else running leaves the answer exactly as it was", () => {
  const withZero = canSustainOutput({
    benchmark: BENCHMARK,
    decodeModel: DECODE_MODEL,
    source: SOURCE,
    outputPixelsPerSec: RUNG_240P,
    concurrentCostSec: 0
  });
  const without = canSustainOutput({
    benchmark: BENCHMARK,
    decodeModel: DECODE_MODEL,
    source: SOURCE,
    outputPixelsPerSec: RUNG_240P
  });
  assert.equal(withZero.speed, without.speed);
});

test("a host with nothing measured still refuses nothing", () => {
  const answer = canSustainOutput({
    benchmark: [],
    outputPixelsPerSec: RUNG_240P,
    concurrentCostSec: 0.125
  });
  assert.equal(answer.sustainable, true);
  assert.equal(answer.speed, null);
});

test("a cost heavy enough to fill the machine puts a rung below realtime", () => {
  const answer = canSustainOutput({
    benchmark: BENCHMARK,
    decodeModel: DECODE_MODEL,
    source: SOURCE,
    outputPixelsPerSec: RUNG_240P,
    concurrentCostSec: 0.9
  });
  assert.ok(answer.speed !== null && answer.speed < 1, "0.9 of the machine spent elsewhere leaves less than realtime");
  assert.equal(answer.sustainable, false);
});
