/**
 * @file The bitrate limit and the level are decided with the rest of an
 * output's format, before it is named — roadmap item 97, step 10.
 *
 * Nothing here starts ffmpeg, a torrent or a worker: the decision is a pure
 * function of values.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { decideOutputFormat } from "../../services/encode/quality/output-format.js";
import { nominalKbpsFor, softwareRateControlFor } from "../../services/encode/args.js";
import { AudioOutput, CutGrid, OutputSpec, VideoOutput } from "../../services/encode/output/OutputSpec.js";

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
    source: { ...SOURCE, megabitsPerSecond: 8, decode: null },
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
const SOURCE = { width: 1920, height: 1080, pictureKbps: 6300 };

test("a software output is bounded at its size's nominal rate unless a lower limit is asked for", () => {
  const plain = decide(SOFTWARE).spec.video.encode.rateControl;
  const lower = decide(SOFTWARE, 1400).spec.video.encode.rateControl;

  assert.deepEqual(plain, softwareRateControlFor({ width: 1280, height: 720, fps: 24, source: SOURCE }));
  assert.deepEqual(lower, softwareRateControlFor({ width: 1280, height: 720, fps: 24, source: SOURCE, capKbps: 1400 }));
  assert.equal(lower.level, plain.level, "both are declared at the nominal output's level");
  assert.notEqual(decide(SOFTWARE).spec.toKey(), decide(SOFTWARE, 1400).spec.toKey(), "and are two outputs");
});

test("an unfinished output beyond machine capacity does not prevent a viable requested encode", () => {
  const frame = { width: 1280, height: 720 };
  const pixelsPerSec = frame.width * frame.height * 24 * 1.1;
  const specWith = (encode) => new OutputSpec({
    sourceKey: "torrent:abc",
    segmentFormatId: "fmp4",
    grid: new CutGrid({ kind: "uniform", fileIndex: 0 }),
    video: new VideoOutput({ fileIndex: 0, encode }),
    audio: null
  });
  const partialSlowOutput = specWith({
    encoder: SOFTWARE.name,
    ...frame,
    fps: 24,
    preset: "veryfast",
    tonemap: false,
    rateControl: null
  });
  const decided = decideOutputFormat({
    encodesPicture: true,
    exact: true,
    target: frame,
    source: { ...SOURCE, megabitsPerSecond: 8, decode: null },
    fps: 24,
    encoder: SOFTWARE,
    benchmark: [{
      preset: "ultrafast",
      pixelsPerSec,
      bySize: [{ ...frame, pixelsPerSec }],
      interpolationError: null
    }],
    cost: { decodeModel: null, observedDecodeCostSec: null, requiredSpeed: 1 },
    chooseBudget: () => null,
    machineAdmission: (spec) => ({
      admitted: spec.video.encode.preset !== "veryfast",
      reason: "the unfinished output cannot be produced at realtime",
      speedX: spec.video.encode.preset === "veryfast" ? 0.73 : 1.02
    }),
    tonemap: false,
    limitsFor: () => [null],
    specWith,
    serving: {
      mode: "auto",
      linkMbps: null,
      keys: [partialSlowOutput.toKey()],
      readyAt: () => true
    }
  });

  assert.equal(decided.reusedKey, null, "the partial output is not resumed at a speed the machine cannot sustain");
  assert.equal(decided.spec.video.encode.preset, "ultrafast", "the viable requested output is considered after it");
});

test("a limit named in the request is not answered by an output of another limit already here", () => {
  // The nominal 720p output exists and is ready, and it suits this viewer —
  // which is exactly what a move to a lower limit is for leaving.
  const nominal = decide(SOFTWARE).spec.toKey();
  const asked = decideOutputFormat({
    encodesPicture: true,
    exact: true,
    target: { width: 1280, height: 720 },
    source: { ...SOURCE, megabitsPerSecond: 8, decode: null },
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
  assert.deepEqual(asked.spec.video.encode.rateControl, softwareRateControlFor({ width: 1280, height: 720, fps: 24, source: SOURCE, capKbps: 1400 }));
});

test("a hardware output states no limit, because it is given none", () => {
  assert.equal(decide(HARDWARE).spec.video.encode.rateControl, null);
  assert.ok(decide(HARDWARE).spec.toKey().endsWith("/vbv=-:a=0/0/aac"));
});

test("a limit above the size's own is refused rather than lowered", () => {
  assert.throws(() => decide(SOFTWARE, nominalKbpsFor({ width: 1280, height: 720 }, SOURCE) + 1), RangeError);
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
    source: { ...SOURCE, megabitsPerSecond: 8, decode: null },
    fps: 24,
    encoder,
    benchmark: null,
    cost: { decodeModel: null, observedDecodeCostSec: null, requiredSpeed: null },
    chooseBudget: () => null,
    tonemap: false,
    ...(limits ? { limitsFor: (frame, source) => (frame.height === 720 ? limits : [nominalKbpsFor(frame, source)]) } : {}),
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
    softwareRateControlFor({ width: 1280, height: 720, fps: 24, source: SOURCE, capKbps: 1400 })
  );
  assert.equal(decided.answer.verdict, "fits");
});

test("AUTO prefers a sustainable smaller rung but still opens when no rung fits", () => {
  // Nothing at 720p fits 3 Mbit/s with only the nominal limit, and 480p's
  // nominal peak (1.82 Mbit/s) does.
  const decided = decideFor({ mode: "auto", linkMbps: 3 });
  assert.equal(decided.unavailable, null);
  assert.ok(decided.spec.video.encode.height < 720, "a smaller rung");
  assert.ok(decided.answer.fits, "whose own load the link carries");
  assert.equal(
    decideFor({ mode: "auto", linkMbps: 0.3 }).unavailable,
    null,
    "no rung meeting the estimate is a reason to wait, not refuse the video"
  );
});

test("a manual output opens when its measured rate exceeds the viewer-link estimate", () => {
  const decided = decideFor({ mode: "manual", linkMbps: 3 });
  assert.ok(decided.spec, "the requested output is still prepared");
  assert.equal(decided.unavailable, null);
  assert.equal(decided.answer.verdict, "does not fit");
  assert.equal(decided.answer.linkMbps, 3);
});

test("a hardware output with no stated rate remains available for preparation", () => {
  assert.equal(decideFor({ encoder: HARDWARE, linkMbps: 50 }).unavailable, null);
  assert.equal(decideFor({ encoder: HARDWARE, linkMbps: 50 }).answer.verdict, "no safe bound");
  assert.equal(decideFor({ encoder: HARDWARE, linkMbps: null }).answer.verdict, "no measurement");
});

test("the soundtrack the viewer hears counts toward what their link carries", () => {
  // 720p nominal peaks at 3.64 Mbit/s, and the whole measured link is compared
  // with the stream (no share of it is set aside since proxy 2.89.4). A 3.7 Mbit/s
  // link carries the picture, not the picture and 128 kbit/s of sound (3.768).
  const linkMbps = 3.7;

  assert.equal(decideFor({ mode: "manual", linkMbps }).answer.verdict, "fits");
  assert.equal(
    decideFor({ mode: "manual", linkMbps, audioLoad: { mbps: 0.128, peakClass: "known" } }).answer.fits,
    false,
    "with the sound its measured rate is no longer sustainable"
  );
});

// torrent-tv/meta#178: a viewer moved to another speed setting of the size
// they watch is given exactly that setting, at a size produced exactly.
test("a speed setting named in the request is the one given, and only where it was measured at that size", () => {
  const frame = { width: 1280, height: 720 };
  const fast = 1280 * 720 * 24 * 4;
  const benchmark = [
    { preset: "fast", pixelsPerSec: fast, bySize: [{ ...frame, pixelsPerSec: fast }], interpolationError: null },
    { preset: "veryfast", pixelsPerSec: fast * 2, bySize: [{ ...frame, pixelsPerSec: fast * 2 }], interpolationError: null }
  ];
  const named = (preset, keys = []) => decideOutputFormat({
    encodesPicture: true,
    exact: true,
    target: frame,
    source: { ...SOURCE, megabitsPerSecond: 8, decode: null },
    fps: 24,
    encoder: SOFTWARE,
    benchmark,
    cost: { decodeModel: null, observedDecodeCostSec: null, requiredSpeed: null },
    chooseBudget: () => null,
    tonemap: false,
    preset,
    specWith: (encode) => new OutputSpec({
      sourceKey: "torrent:abc",
      segmentFormatId: "mpegts",
      grid: new CutGrid({ kind: "uniform", fileIndex: 0 }),
      video: new VideoOutput({ fileIndex: 0, encode }),
      audio: new AudioOutput({ fileIndex: 0, trackIndex: 0, transcode: true })
    }),
    serving: { mode: "manual", linkMbps: null, keys, readyAt: () => true }
  });
  const plain = named(null);
  assert.equal(plain.spec.video.encode.preset, "fast", "the best setting this machine holds, when none is named");
  const moved = named("veryfast", [plain.spec.toKey()]);
  assert.equal(moved.reusedKey, null, "the output being left is not handed back");
  assert.equal(moved.spec.video.encode.preset, "veryfast");
  const unmeasured = named("ultrafast");
  assert.equal(unmeasured.spec, null);
  assert.match(unmeasured.unavailable.reason, /ultrafast is not measured at 1280x720/);
});
