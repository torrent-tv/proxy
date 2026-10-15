/**
 * @file A speed setting is priced over a run, its open included
 * (torrent-tv/meta#178).
 *
 * Field r41 (Home Assistant): `fast` was chosen at 1.03x priced on encoding
 * alone, and its runs of one piece took 5.9-7.5 s for 4 s of film.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { effectiveSpeed, runFilmSeconds } from "../../services/encode/quality/effective-speed.js";
import { EncodeCost } from "../../services/encode/quality/EncodeCost.js";
import { qualityStateOf } from "../../services/encode/quality/OutputQualityState.js";

const FRAME = { width: 640, height: 360 };
const FPS = 24;
const PIXELS_PER_SEC = FRAME.width * FRAME.height * FPS;
const BENCHMARK = [
  { preset: "fast", pixelsPerSec: PIXELS_PER_SEC * 3, bySize: [{ ...FRAME, pixelsPerSec: PIXELS_PER_SEC * 3 }], interpolationError: null },
  { preset: "ultrafast", pixelsPerSec: PIXELS_PER_SEC * 12, bySize: [{ ...FRAME, pixelsPerSec: PIXELS_PER_SEC * 12 }], interpolationError: null }
];
/** Decoding costs 1/6 s per second: `fast` makes 2x, `ultrafast` 4x. */
const DECODE_MODEL = { pixelTerm: 0, bitrateTerm: 0, constantTerm: 1 / 6 };

function costWith({ shape = null, active = [], seen = null } = {}) {
  return new EncodeCost({
    outputs: { familyOf: (session) => active.includes(session) ? active : [session, ...active], values: () => active, variantHeightOf: () => 0 },
    host: () => ({ benchmark: BENCHMARK, decodeModel: DECODE_MODEL, contentionPenalties: null,
      availability: { known: true, share: 1 }, encoderKind: "software",
      observedAloneSpeed: (session) => seen?.[session.spec.video.encode.preset] ?? null }),
    runningEncoders: () => active.length,
    encodersRunningNow: () => active.length,
    torrentCostSecFor: () => 0,
    runsFor: () => [],
    stateFor: (session) => session.running ? "PRODUCING" : "IDLE",
    runShapeFor: () => shape
  });
}

function outputAt(preset) {
  return {
    id: "834ef7164f5578c3",
    outputKey: `k-${preset}`,
    file: { key: "torrent:x:0", megabitsPerSecond: 2, decode: { megapixelsPerSecond: 5.5, megabitsPerSecond: 1, codec: "mpeg4" } },
    output: { encodeHeight: FRAME.height },
    spec: { transcodesVideo: true, carries: "video-only",
      video: { encode: { encoder: "libx264", ...FRAME, fps: FPS, preset, tonemap: false } } }
  };
}

const CHOICE = { transcodeVideo: true, targetWidth: FRAME.width, targetHeight: FRAME.height, sourceWidth: FRAME.width,
  sourceHeight: FRAME.height, outputFps: FPS, source: { megapixelsPerSecond: 5.5, megabitsPerSecond: 1 }, requiredSpeed: 1 };

test("a run's speed is its film over its open and its encoding", () => {
  assert.equal(effectiveSpeed({ processingSpeed: 2, openSeconds: 3, filmSeconds: 4 }), 0.8);
  assert.equal(effectiveSpeed({ processingSpeed: 2, openSeconds: null, filmSeconds: 4 }), 2, "an open not known prices encoding alone");
  assert.equal(effectiveSpeed({ processingSpeed: null, openSeconds: 3, filmSeconds: 4 }), null);
});

test("a run is given the stretch the inputs size, and one piece while no copy rate is known", () => {
  // 25 MB/s copied for 2 s of open: 50 MB, within 100 MB of memory, at 0.25 MB a second of film.
  assert.equal(runFilmSeconds({ copyBytesPerMs: 25_000, openSeconds: 2, capacityBytes: 100e6, sourceBytesPerSecond: 250_000, segmentSeconds: 4 }), 200);
  assert.equal(runFilmSeconds({ copyBytesPerMs: 25_000, openSeconds: 2, capacityBytes: 10e6, sourceBytesPerSecond: 250_000, segmentSeconds: 4 }), 40,
    "within the memory inputs may hold");
  assert.equal(runFilmSeconds({ copyBytesPerMs: null, openSeconds: 2, capacityBytes: 10e6, sourceBytesPerSecond: 250_000, segmentSeconds: 4 }), 4);
});

test("a setting that holds realtime only on encoding alone is not chosen when its runs are short", () => {
  assert.equal(costWith().chooseEncodeBudget(CHOICE).preset, "fast", "2x on encoding alone");
  // A run of one 4 s piece opening in 3 s: fast 4 / (3 + 2) = 0.8x, ultrafast 4 / (3 + 1) = 1.0x.
  assert.equal(costWith({ shape: { openSeconds: 3, filmSeconds: 4 } })
    .chooseEncodeBudget({ ...CHOICE, run: { sourceBytesPerSecond: 250_000, segmentSeconds: 4 } }).preset, "ultrafast");
  // Long runs: fast 200 / (3 + 100) = 1.94x.
  assert.equal(costWith({ shape: { openSeconds: 3, filmSeconds: 200 } })
    .chooseEncodeBudget({ ...CHOICE, run: { sourceBytesPerSecond: 250_000, segmentSeconds: 4 } }).preset, "fast");
});

test("a candidate setting is priced by the whole model, the output it replaces left out", () => {
  const current = outputAt("ultrafast");
  current.running = true;
  qualityStateOf(current).lastAloneSpeed = 4;
  const priced = costWith({ active: [current], shape: { openSeconds: 1, filmSeconds: 40 } })
    .presetSpeedOf(current, "fast", { segmentSeconds: 4 });
  // fast alone: 1 / (1/6 + 1/3) = 2x; over a run 40 / (1 + 20) = 1.90x.
  assert.ok(Math.abs(priced.processing - 2) < 1e-9, `processing ${priced.processing}`);
  assert.ok(Math.abs(priced.effective - 40 / 21) < 1e-9, `effective ${priced.effective}`);
  assert.equal(costWith().presetSpeedOf(outputAt("fast"), "veryfast", { segmentSeconds: 4 }), null, "a setting not measured here is not priced");
});

test("a setting seen running slower here than the model says is priced at what it was seen doing", () => {
  const current = outputAt("ultrafast");
  const priced = costWith({ seen: { fast: 0.9 } }).presetSpeedOf(current, "fast", { segmentSeconds: 4 });
  assert.equal(priced.processing, 0.9);
});
