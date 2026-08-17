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

test("a soundtrack encoder is not free once it has been measured", () => {
  // The second half of roadmap item 6. An audio rendition runs for as long as
  // the picture does — it is a second encoder by construction, not an extra —
  // and the budget counted it at nothing. Small beside a picture, and small is
  // not zero: on a host where a rung needs almost the whole machine, this is
  // the difference between offering it and refusing it.
  const withoutAudio = canSustainOutput({
    benchmark: BENCHMARK,
    decodeModel: DECODE_MODEL,
    source: SOURCE,
    outputPixelsPerSec: RUNG_240P,
    concurrentCostSec: 0.125
  });
  const withAudio = canSustainOutput({
    benchmark: BENCHMARK,
    decodeModel: DECODE_MODEL,
    source: SOURCE,
    outputPixelsPerSec: RUNG_240P,
    // The copy, plus a soundtrack measured at about twenty times realtime.
    concurrentCostSec: 0.125 + 0.05
  });
  assert.ok(
    withAudio.speed < withoutAudio.speed,
    "charging for the soundtrack must lower what the machine has left for the picture"
  );
});

test("two pictures encoding at once are charged as two", () => {
  // The warm-up that makes a quality switch seamless runs two encoders on
  // purpose. Measured 2026-08-15: the new rung ran at 0.504x for its first four
  // seconds, against 0.90-0.99x once it had the machine to itself and 1.58x
  // predicted for an idle one. Priced as though it were alone, the budget
  // describes a machine that does not exist at the moment the viewer switches.
  const alone = canSustainOutput({
    benchmark: BENCHMARK,
    decodeModel: DECODE_MODEL,
    source: SOURCE,
    outputPixelsPerSec: RUNG_240P,
    concurrentCostSec: 0
  });
  const besideAnother = canSustainOutput({
    benchmark: BENCHMARK,
    decodeModel: DECODE_MODEL,
    source: SOURCE,
    outputPixelsPerSec: RUNG_240P,
    // Another rung of the same family, already running at about realtime.
    concurrentCostSec: 1 / 1.05
  });
  assert.ok(alone.sustainable, "the rung must be offerable on an idle machine, or the case is not the one meant");
  assert.equal(
    besideAnother.sustainable,
    false,
    "a machine already spending a second per second of video has nothing left for a second picture"
  );
});
