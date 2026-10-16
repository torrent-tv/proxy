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

// r82 (torrent-tv/meta#185): opened during a cold start beside the output it
// was to replace, an output at `faster` was predicted 0.22x; its move was
// priced 1.81x and it measured 1.46-1.65x.
test("the speed a move was decided at replaces the figure taken when the output was opened", () => {
  const cost = costWith();
  const session = outputAt("fast");
  cost.notePredictionFor(session);
  const state = qualityStateOf(session);
  state.lastPredictionRatio = 3;
  cost.notePriceFor(session, 1.81);
  assert.equal(state.predictedSpeedWhenOffered, 1.81);
  assert.equal(state.predictedMode, "fast");
  assert.equal(state.offeredSpeedAtCheapestMode, null, "a move is not an offer");
  assert.equal(state.lastPredictionRatio, null, "the first ratio against the new figure is said");
  cost.notePriceFor(session, Number.NaN);
  assert.equal(state.predictedSpeedWhenOffered, 1.81, "no price, no change");
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

test("new software mode choice prices decoding from the file's own measured cost where there is one", () => {
  // The opening had the file's measured decode cost and the choice priced
  // decoding from the startup model instead (review of r28,
  // torrent-tv/meta#178). Here the model says 1/6 s per second, and the file
  // was measured at 0.8: `fast` then runs at 1 / (0.8 + 1/3) = 0.88x and
  // `ultrafast` at 1 / (0.8 + 1/12) = 1.13x.
  const params = {
    transcodeVideo: true,
    targetWidth: FRAME.width,
    targetHeight: FRAME.height,
    sourceWidth: FRAME.width,
    sourceHeight: FRAME.height,
    outputFps: FPS,
    source: { megapixelsPerSecond: 5.5, megabitsPerSecond: 1 },
    requiredSpeed: 1
  };
  assert.equal(costWith().chooseEncodeBudget(params).preset, "fast", "from the model, `fast` holds 2x");
  assert.equal(costWith().chooseEncodeBudget({ ...params, observedDecodeCostSec: 0.8 }).preset, "ultrafast");
});
