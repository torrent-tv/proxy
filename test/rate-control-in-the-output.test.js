/**
 * @file The bitrate limit and the level are decided with the rest of an
 * output's format, before it is named — roadmap item 97, step 10.
 *
 * Nothing here starts ffmpeg, a torrent or a worker: the decision is a pure
 * function of values.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { decideOutputFormat } from "../services/encode/quality/output-format.js";
import { nominalKbpsFor, softwareRateControlFor } from "../services/encode/args.js";
import { AudioOutput, CutGrid, OutputSpec, VideoOutput } from "../services/encode/output/OutputSpec.js";

/**
 * A 720p output asked for exactly, from a 1080p source, on the encoder given.
 *
 * @param {{ kind: string, name: string }} encoder
 * @param {number | null} [capKbps]
 * @returns {ReturnType<typeof decideOutputFormat>}
 */
function decide(encoder, capKbps = null) {
  return decideOutputFormat({
    encodesPicture: true,
    exact: true,
    target: { width: 1280, height: 720 },
    source: { width: 1920, height: 1080, megabitsPerSecond: 8, decode: null },
    fps: 24,
    encoder,
    benchmark: null,
    cost: { decodeModel: null, observedDecodeCostSec: null, requiredSpeed: null },
    chooseBudget: () => null,
    tonemap: false,
    capKbps,
    specWith: (encode) => new OutputSpec({
      sourceKey: "torrent:abc",
      segmentFormatId: "fmp4",
      grid: new CutGrid({ kind: "uniform", fileIndex: 0 }),
      video: new VideoOutput({ fileIndex: 0, encode }),
      audio: new AudioOutput({ fileIndex: 0, trackIndex: 0, transcode: true })
    }),
    serving: { mode: "manual", linkMbps: null, keys: [], readyAt: () => false }
  });
}

const SOFTWARE = { kind: "software", name: "libx264" };
const HARDWARE = { kind: "nvenc", name: "h264_nvenc" };

test("a software output is bounded at its size's nominal rate unless a lower limit is asked for", () => {
  const plain = decide(SOFTWARE).spec.video.encode.rateControl;
  const lower = decide(SOFTWARE, 1400).spec.video.encode.rateControl;

  assert.deepEqual(plain, softwareRateControlFor({ width: 1280, height: 720, fps: 24 }));
  assert.deepEqual(lower, softwareRateControlFor({ width: 1280, height: 720, fps: 24, capKbps: 1400 }));
  assert.equal(lower.level, plain.level, "both are declared at the nominal output's level");
  assert.notEqual(decide(SOFTWARE).spec.toKey(), decide(SOFTWARE, 1400).spec.toKey(), "and are two outputs");
});

test("a limit named in the request is not answered by an output of another limit already here", () => {
  // The nominal 720p output exists and is ready, and it suits this viewer —
  // which is exactly what a move to a lower limit is for leaving.
  const nominal = decide(SOFTWARE).spec.toKey();
  const asked = decideOutputFormat({
    encodesPicture: true,
    exact: true,
    target: { width: 1280, height: 720 },
    source: { width: 1920, height: 1080, megabitsPerSecond: 8, decode: null },
    fps: 24,
    encoder: SOFTWARE,
    benchmark: null,
    cost: { decodeModel: null, observedDecodeCostSec: null, requiredSpeed: null },
    chooseBudget: () => null,
    tonemap: false,
    capKbps: 1400,
    specWith: (encode) => new OutputSpec({
      sourceKey: "torrent:abc",
      segmentFormatId: "fmp4",
      grid: new CutGrid({ kind: "uniform", fileIndex: 0 }),
      video: new VideoOutput({ fileIndex: 0, encode }),
      audio: new AudioOutput({ fileIndex: 0, trackIndex: 0, transcode: true })
    }),
    serving: { mode: "manual", linkMbps: null, keys: [nominal], readyAt: () => true }
  });
  assert.equal(asked.reusedKey, null);
  assert.deepEqual(asked.spec.video.encode.rateControl, softwareRateControlFor({ width: 1280, height: 720, fps: 24, capKbps: 1400 }));
});

test("a hardware output states no limit, because it is given none", () => {
  assert.equal(decide(HARDWARE).spec.video.encode.rateControl, null);
  assert.ok(decide(HARDWARE).spec.toKey().endsWith("/vbv=-:a=0/0/aac"));
});

test("a limit above the size's own is refused rather than lowered", () => {
  assert.throws(() => decide(SOFTWARE, nominalKbpsFor({ width: 1280, height: 720 }) + 1), RangeError);
  assert.throws(() => decide(SOFTWARE, 0), RangeError, "and a limit that is not a positive rate is not a limit");
});

// ---------------------------------------------------------------------------
// Step 11: the viewer's own link decides whether a format may be given at all.
// ---------------------------------------------------------------------------

/**
 * A 720p output of a 1080p source for a viewer whose link measured `linkMbps`.
 *
 * @param {{ mode?: "auto" | "manual", linkMbps?: number | null, limits?: number[], encoder?: object, audioLoad?: object | null }} how
 */
function decideFor({ mode = "manual", linkMbps = null, limits = null, encoder = SOFTWARE, audioLoad = null } = {}) {
  return decideOutputFormat({
    encodesPicture: true,
    exact: true,
    target: { width: 1280, height: 720 },
    source: { width: 1920, height: 1080, megabitsPerSecond: 8, decode: null },
    fps: 24,
    encoder,
    benchmark: null,
    cost: { decodeModel: null, observedDecodeCostSec: null, requiredSpeed: null },
    chooseBudget: () => null,
    tonemap: false,
    ...(limits ? { limitsFor: (frame) => (frame.height === 720 ? limits : [nominalKbpsFor(frame)]) } : {}),
    audioLoad,
    specWith: (encode) => new OutputSpec({
      sourceKey: "torrent:abc",
      segmentFormatId: "fmp4",
      grid: new CutGrid({ kind: "uniform", fileIndex: 0 }),
      video: new VideoOutput({ fileIndex: 0, encode }),
      audio: null
    }),
    serving: { mode, linkMbps, keys: [], readyAt: () => false }
  });
}

test("a size picked by hand keeps its height and takes the highest limit the link admits", () => {
  // 720p nominal peaks at 3.64 Mbit/s; a 3 Mbit/s link admits 2.4 of it.
  const decided = decideFor({ mode: "manual", linkMbps: 3, limits: [2800, 1400] });
  assert.equal(decided.unavailable, null);
  assert.equal(decided.spec.video.encode.height, 720, "the height picked by hand is kept");
  assert.deepEqual(
    decided.spec.video.encode.rateControl,
    softwareRateControlFor({ width: 1280, height: 720, fps: 24, capKbps: 1400 })
  );
  assert.equal(decided.answer.verdict, "fits");
});

test("AUTO moves to a smaller rung only when that rung's own load is admitted", () => {
  // Nothing at 720p fits 3 Mbit/s with only the nominal limit, and 480p's
  // nominal peak (1.82 Mbit/s) does.
  const decided = decideFor({ mode: "auto", linkMbps: 3 });
  assert.equal(decided.unavailable, null);
  assert.ok(decided.spec.video.encode.height < 720, "a smaller rung");
  assert.ok(decided.answer.admitted, "whose own load the link admits");
  assert.equal(
    decideFor({ mode: "auto", linkMbps: 0.3 }).unavailable?.reason?.length > 0,
    true,
    "and with nothing admitted at any rung, nothing is handed over"
  );
});

test("nothing admitted is answered as unavailable, with the figures, and names no output", () => {
  const decided = decideFor({ mode: "manual", linkMbps: 3 });
  assert.equal(decided.spec, null, "a format known not to fit is never handed over");
  assert.ok(decided.unavailable.reason.length > 0);
  assert.equal(decided.unavailable.figures.verdict, "does not fit");
  assert.equal(decided.unavailable.figures.linkMbps, 3);
});

test("a hardware output is unavailable against a measured link, and given while nothing measured it", () => {
  assert.equal(decideFor({ encoder: HARDWARE, linkMbps: 50 }).unavailable.figures.verdict, "no safe bound");
  assert.equal(decideFor({ encoder: HARDWARE, linkMbps: null }).answer.verdict, "no measurement");
});

test("the soundtrack the viewer hears counts toward what their link carries", () => {
  // 720p nominal peaks at 3.64 Mbit/s, and the whole measured link is compared
  // with the stream (no share of it is set aside since proxy 2.89.4). A 3.7 Mbit/s
  // link carries the picture, not the picture and 128 kbit/s of sound (3.768).
  const linkMbps = 3.7;
  assert.equal(decideFor({ mode: "manual", linkMbps }).answer.verdict, "fits");
  assert.ok(
    decideFor({ mode: "manual", linkMbps, audioLoad: { mbps: 0.128, peakClass: "known" } }).unavailable,
    "with the sound it no longer fits"
  );
});
