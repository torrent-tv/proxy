/**
 * @file What the decode measurement must never get wrong.
 *
 * The quality menu is predicted from these readings, so a reading that is
 * merely PRECISE is worth nothing — it has to be ordered the way decoding is.
 * Under `-stream_loop -1` it was not: the loop restart costs 0.03 s on a 480p
 * clip and 0.12 s on a 1080p one (the decoder tearing down and re-allocating
 * its frame buffers), a five-second clip at 55x restarts eleven times a second,
 * and the resulting bias depends on the clip's own resolution and on how fast
 * the host is. On a fast desktop, 2026-08-20, that made 1080p read cheaper than
 * 720p — which is not a thing a decoder does, and the fit refused to solve.
 *
 * These tests state the orderings instead of the numbers: the numbers are
 * properties of whatever machine runs them.
 */

import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ffmpegStatic from "ffmpeg-static";
import { measureDecodeSlope } from "../services/hwaccel.js";

const CLIPS = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "calibration");
const clip = (name) => path.join(CLIPS, name);

test("a bigger picture costs more than a smaller one of the same bitrate", async () => {
  const big = await measureDecodeSlope(ffmpegStatic, clip("cal-h264-1080-hi.mp4"));
  const small = await measureDecodeSlope(ffmpegStatic, clip("cal-h264-480-hi.mp4"));

  assert.ok(big, "the 1080p clip was measured");
  assert.ok(small, "the 480p clip was measured");
  assert.ok(
    small.speed > big.speed,
    `480p decoded at ${small.speed.toFixed(1)}x and 1080p at ${big.speed.toFixed(1)}x — ` +
      `an ordering no decoder produces, which is what the loop used to invert`
  );
});

test("a thicker stream costs more than a thin one of the same size", async () => {
  const thick = await measureDecodeSlope(ffmpegStatic, clip("cal-h264-480-hi.mp4"));
  const thin = await measureDecodeSlope(ffmpegStatic, clip("cal-h264-480-lo.mp4"));

  assert.ok(thick && thin);
  assert.ok(
    thin.speed > thick.speed,
    `the same picture at ${thin.megabitsPerSecond.toFixed(2)} Mbit/s decoded at ${thin.speed.toFixed(1)}x ` +
      `and at ${thick.megabitsPerSecond.toFixed(2)} Mbit/s at ${thick.speed.toFixed(1)}x`
  );
});

test("HEVC costs more than H.264 for the same picture on the same machine", async () => {
  const h264 = await measureDecodeSlope(ffmpegStatic, clip("cal-h264-480-lo.mp4"), "h264");
  const hevc = await measureDecodeSlope(ffmpegStatic, clip("cal-hevc-480-lo.mp4"), "hevc");

  assert.ok(h264 && hevc, "both families are lifted out of their containers correctly");
  assert.ok(
    h264.speed > hevc.speed,
    `H.264 ${h264.speed.toFixed(1)}x against HEVC ${hevc.speed.toFixed(1)}x — the reason the model ` +
      `is fitted per codec family at all`
  );
});

test("the clip's own characteristics come back with the reading", async () => {
  const measured = await measureDecodeSlope(ffmpegStatic, clip("cal-h264-1080-hi.mp4"));

  assert.ok(measured);
  // Read from the container rather than declared anywhere, so replacing a clip
  // cannot silently invalidate the fit that rests on it.
  assert.ok(measured.megapixelsPerSecond > 40 && measured.megapixelsPerSecond < 60);
  assert.ok(measured.megabitsPerSecond > 5 && measured.megabitsPerSecond < 15);
  assert.ok(measured.windowSec >= 0.5, "the slope is taken over a window wide enough to divide by");
});
