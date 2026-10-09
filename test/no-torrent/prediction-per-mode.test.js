/**
 * @file The prediction an output is compared with is the one for the mode it
 * is encoded in (torrent-tv/meta#3).
 *
 * Field 2026-10-07: an XviD 360p step was predicted 7.27x at `ultrafast`, the
 * figure the offer decides on, and measured 1.2-3.4x while being encoded at
 * `fast`. The ratio described two different modes, not the arithmetic.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { EncodeCost, modeEntryFor } from "../../services/encode/quality/EncodeCost.js";
import { qualityStateOf } from "../../services/encode/quality/OutputQualityState.js";

const FRAME = { width: 640, height: 360 };
const FPS = 24;
const PIXELS_PER_SEC = FRAME.width * FRAME.height * FPS;

/** Slowest first, as calibration lists them: `fast` holds 3x here, `ultrafast` 12x. */
const BENCHMARK = [
  { preset: "fast", pixelsPerSec: PIXELS_PER_SEC * 3, bySize: [{ ...FRAME, pixelsPerSec: PIXELS_PER_SEC * 3 }], interpolationError: null },
  { preset: "ultrafast", pixelsPerSec: PIXELS_PER_SEC * 12, bySize: [{ ...FRAME, pixelsPerSec: PIXELS_PER_SEC * 12 }], interpolationError: null }
];

/** Decoding this source costs 1/6 s per second: alone, it would run at 6x. */
const DECODE_MODEL = { pixelTerm: 0, bitrateTerm: 0, constantTerm: 1 / 6 };

function costWith(benchmark = BENCHMARK, active = [], share = 1) {
  return new EncodeCost({
    outputs: { familyOf: () => [], values: () => active, variantHeightOf: () => 0 },
    host: () => ({ benchmark, decodeModel: DECODE_MODEL, contentionPenalties: null,
      availability: { known: true, share }, encoderKind: "software" }),
    runningEncoders: () => active.length,
    encodersRunningNow: () => active.length,
    torrentCostSecFor: () => 0,
    runsFor: () => [],
    stateFor: (session) => session.running ? "PRODUCING" : "IDLE"
  });
}

function outputAt(preset) {
  return {
    id: "834ef7164f5578c3",
    file: { key: "torrent:x:0", decode: { megapixelsPerSecond: 5.5, megabitsPerSecond: 1, codec: "mpeg4" } },
    output: { encodeHeight: FRAME.height },
    spec: {
      transcodesVideo: true,
      carries: "video-only",
      video: { encode: { encoder: "libx264", ...FRAME, fps: FPS, preset, tonemap: false } }
    }
  };
}

test("an output is predicted at its own mode, and the offer's cheapest-mode figure is kept beside it", () => {
  const cost = costWith();
  const session = outputAt("fast");
  cost.notePredictionFor(session);
  const state = qualityStateOf(session);
  assert.equal(state.predictedMode, "fast");
  // 1 / (1/6 + 1/3) = 2x at `fast`; 1 / (1/6 + 1/12) = 4x at `ultrafast`.
  assert.ok(Math.abs(state.predictedSpeedWhenOffered - 2) < 1e-9, `predicted ${state.predictedSpeedWhenOffered}`);
  assert.ok(Math.abs(state.offeredSpeedAtCheapestMode - 4) < 1e-9, `offered ${state.offeredSpeedAtCheapestMode}`);
});

test("new software mode choice includes the costs of currently running encoders", () => {
  const active = outputAt("fast");
  active.running = true;
  qualityStateOf(active).lastAloneSpeed = 1.5;
  const cost = costWith(BENCHMARK, [active]);
  const choice = cost.chooseEncodeBudget({
    transcodeVideo: true,
    targetWidth: FRAME.width,
    targetHeight: FRAME.height,
    sourceWidth: FRAME.width,
    sourceHeight: FRAME.height,
    outputFps: FPS,
    source: { megapixelsPerSecond: 5.5, megabitsPerSecond: 1 },
    requiredSpeed: 1
  });
  assert.equal(choice.preset, "ultrafast");
});

test("new software mode choice reflects the measured free share of the machine", () => {
  const cost = costWith(BENCHMARK, [], 0.3);
  const choice = cost.chooseEncodeBudget({
    transcodeVideo: true,
    targetWidth: FRAME.width,
    targetHeight: FRAME.height,
    sourceWidth: FRAME.width,
    sourceHeight: FRAME.height,
    outputFps: FPS,
    source: { megapixelsPerSecond: 5.5, megabitsPerSecond: 1 },
    requiredSpeed: 1
  });
  assert.equal(choice.preset, "ultrafast");
});

test("a mode that was not measured has no prediction rather than another mode's", () => {
  const cost = costWith();
  const session = outputAt("veryslow");
  cost.notePredictionFor(session);
  const state = qualityStateOf(session);
  assert.equal(state.predictedSpeedWhenOffered, null);
  assert.equal(state.predictedMode, null);
});

test("a copied picture is not predicted at all", () => {
  const cost = costWith();
  const session = { ...outputAt("fast"), spec: { transcodesVideo: false, carries: "video-only", video: { copy: true } } };
  cost.notePredictionFor(session);
  assert.equal(qualityStateOf(session).predictedSpeedWhenOffered, null);
});

test("an encoder with one setting is matched to its one mode when the output names none", () => {
  const one = [{ preset: "h264_nvenc", pixelsPerSec: 1 }];
  assert.equal(modeEntryFor(one, null), one[0]);
  assert.equal(modeEntryFor(BENCHMARK, null), null);
  assert.equal(modeEntryFor(BENCHMARK, "ultrafast"), BENCHMARK[1]);
});
