/**
 * @file What a re-encode costs on this host, decoding included.
 *
 * The budget used to price the encoder alone. Measured on the addon host
 * 2026-08-14, that made it offer a 240p rung it then ran at 0.388-0.947x while
 * claiming the host cleared the bar 2.5 times over — the error on that rung was
 * 209 %. The decode term brings a controlled measurement to within 5 %.
 *
 * The first test runs the real benchmark against the shipped clips with the
 * real ffmpeg, because a fit that only ever runs against invented numbers can
 * be wrong in every way that matters (2.9.124: a module tested only through its
 * own exports missed the caller that never called it).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  benchmarkDecodeCost,
  canSustainOutput,
  decodeSpeedFor,
  predictedRealtimeSpeed,
  REALTIME_SPEED_MARGIN
} from "../services/hwaccel.js";
import { HlsSessionManager, sourceDecodeCharacteristics } from "../services/hls-session-manager.js";
import { parseFfmpegBitrateKbps, parseFfmpegDurationSeconds, parseFfmpegVideoDimensions, parseFfmpegVideoFps } from "../services/ffmpeg-banner.js";
import { fmp4Format } from "../services/segment-formats/fmp4.js";

const require = createRequire(import.meta.url);
const ffmpegBin = require("ffmpeg-static");
const CALIBRATION_DIR = path.join(import.meta.dirname, "..", "assets", "calibration");

/**
 * How long one ffmpeg run takes, and what its banner said.
 *
 * @param {string} clip
 * @param {number} repeats - `-stream_loop`.
 * @returns {Promise<{ elapsedSec: number, stderr: string }>}
 */
function runDecode(clip, repeats) {
  return new Promise((resolve, reject) => {
    const args = [
      "-hide_banner", "-loglevel", "info",
      "-stream_loop", String(repeats),
      "-i", path.join(CALIBRATION_DIR, clip),
      "-an", "-f", "null", "-"
    ];
    const startedAt = Date.now();
    let stderr = "";
    const child = spawn(ffmpegBin, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`decoding ${clip} failed (code ${code})`));
        return;
      }
      resolve({ elapsedSec: (Date.now() - startedAt) / 1000, stderr });
    });
  });
}

/**
 * What decoding one calibration clip costs, in seconds of work per second of
 * video — measured the way the benchmark measures it, as the difference
 * between two passes and one, so no part of starting the process is counted.
 * A prediction can only be held against a figure that means the same thing.
 *
 * @param {string} clip
 * @returns {Promise<number>}
 */
async function timeDecode(clip) {
  // Four passes against one, so the difference covers THREE decodes. The
  // benchmark differences two runs against one, which is enough on a weak host
  // where a pass takes seconds; on a fast desktop a pass is under a fifth of a
  // second and run-to-run jitter is the same size, so a single difference here
  // would measure the machine's mood rather than its decoder.
  const single = await runDecode(clip, 0);
  const quadruple = await runDecode(clip, 3);
  const seconds = parseFfmpegDurationSeconds(single.stderr);
  if (!(seconds > 0)) {
    throw new Error(`${clip} reported no duration`);
  }
  return (quadruple.elapsedSec - single.elapsedSec) / 3 / seconds;
}

// The constants measured on the addon host (CM4) on 2026-08-14. Used here as
// a fixed host, so the arithmetic can be checked against figures that were
// measured rather than against figures this test invented.
const ADDON_HOST_MODEL = { pixelTerm: 0.005555, bitrateTerm: 0.00990, constantTerm: 0.0572 };
// The film measured that day: 1920x1080 at 24 fps, about 8 Mbit/s.
const MEASURED_FILM = { megapixelsPerSecond: (1920 * 1080 * 24) / 1e6, megabitsPerSecond: 8 };

test("the fit comes out of the real clips, and predicts one of them back", async () => {
  const model = await benchmarkDecodeCost({ ffmpegBin });

  assert.ok(model, "the clips ship with the package and this host has ffmpeg");
  assert.ok(model.pixelTerm > 0, "more pixels cannot decode faster");
  assert.ok(Number.isFinite(model.bitrateTerm) && Number.isFinite(model.constantTerm));

  // What the model must get right is how cost SCALES between one source and
  // another — that is the whole of its job, since it is asked about rungs
  // nobody has decoded. So the check is a ratio, measured by a different method
  // (differencing whole processes) than the fit uses (the slope inside one).
  //
  // Deliberately not absolute cost: the two measurements happen at different
  // moments, this suite runs its files in parallel, and the machine's load
  // moves both of them together. A ratio divides that out; an absolute
  // comparison pins how quiet the machine happened to be, and failed for
  // exactly that reason.
  const clip720 = { megapixelsPerSecond: (1280 * 720 * 24) / 1e6, megabitsPerSecond: 2.248 };
  const clip1080 = { megapixelsPerSecond: (1920 * 1080 * 24) / 1e6, megabitsPerSecond: 11.375 };
  const predictedRatio = decodeSpeedFor(model, clip720) / decodeSpeedFor(model, clip1080);
  const measuredRatio = (await timeDecode("cal-1080-hi.mp4")) / (await timeDecode("cal-720.mp4"));

  assert.ok(
    Math.abs(predictedRatio - measuredRatio) / measuredRatio < 0.5,
    `the model scales 720 against 1080-hi by ${predictedRatio.toFixed(2)}, ` +
      `measured ${measuredRatio.toFixed(2)}`
  );
});

test("decode cost prices the film it was checked against", () => {
  const speed = decodeSpeedFor(ADDON_HOST_MODEL, MEASURED_FILM);

  // 0.005555 x 49.77 + 0.00990 x 8 + 0.0572 = 0.4129 s per second of video.
  assert.ok(Math.abs(1 / speed - 0.4129) < 0.001, `cost was ${(1 / speed).toFixed(4)} s/s`);
  // Measured that day: 0.434 s/s. The claim is 5 %, not exactness.
  assert.ok(Math.abs(1 / speed - 0.434) / 0.434 < 0.05);
});

test("decoding and encoding share the machine, so their speeds combine", () => {
  // The rung that broke playback: 240p at 24 fps, encoded at 5.99x by the
  // measurement, decoded at 2.31x. Measured combined speed was 1.48x.
  const outputPixelsPerSec = 426 * 240 * 24;
  const speed = predictedRealtimeSpeed({
    decodeModel: { pixelTerm: 0, bitrateTerm: 0, constantTerm: 1 / 2.31 },
    encodePixelsPerSec: outputPixelsPerSec * 5.99,
    outputPixelsPerSec,
    source: MEASURED_FILM
  });

  assert.ok(Math.abs(speed - 1.67) < 0.01, `predicted ${speed.toFixed(2)}x`);
  // 1.67 against the 1.48x that rung measured under a controlled encode: 12.8 %
  // out. The figure is pinned so a change to the combination has to state what
  // it does to it.
  assert.ok(Math.abs(speed - 1.48) / 1.48 < 0.13);
});

test("with no decode fit the prediction is the encoder alone — what it was before", () => {
  const outputPixelsPerSec = 426 * 240 * 24;
  const speed = predictedRealtimeSpeed({
    decodeModel: null,
    encodePixelsPerSec: outputPixelsPerSec * 5.99,
    outputPixelsPerSec,
    source: MEASURED_FILM
  });

  assert.equal(speed, 5.99, "the old figure, four times the truth on that rung");
});

test("a rung is refused when the combined speed is under the margin", () => {
  // The addon host's fastest preset, read from its own log: 11.2 Mpx/s.
  const benchmark = [{ preset: "ultrafast", pixelsPerSec: 11.2e6 }];
  const source = MEASURED_FILM;

  const heavy = canSustainOutput({
    benchmark,
    decodeModel: ADDON_HOST_MODEL,
    source,
    outputPixelsPerSec: 1280 * 720 * 24
  });
  assert.equal(heavy.sustainable, false, "720p needs 22 Mpx/s from an 11.2 Mpx/s host");
  assert.ok(heavy.speed < REALTIME_SPEED_MARGIN);

  // And this is the gap the model does NOT close: the 240p rung predicts 1.58x
  // and clears a margin of 1.5, while the field measured that same rung at
  // 0.388-0.947x under real load — a host simultaneously copying 1080p,
  // downloading the torrent and pushing segments. The prediction is honest for
  // an idle machine; the margin is what has to carry the load, and 1.5 does not
  // carry it. Pinned here so the arithmetic is not rediscovered from a log.
  const light = canSustainOutput({
    benchmark,
    decodeModel: ADDON_HOST_MODEL,
    source,
    outputPixelsPerSec: 426 * 240 * 24
  });
  assert.ok(Math.abs(light.speed - 1.58) < 0.01, `predicted ${light.speed.toFixed(2)}x`);
  assert.equal(light.sustainable, true);
});

test("a reading from the running encoder outranks the model of the clips", () => {
  // The field case, 2026-08-14: the 240p rung of that film ran at 0.95x at its
  // best on a host whose fastest preset benchmarked at 11.2 Mpx/s. Subtracting
  // the encode half of that reading leaves what the SOURCE costs to decode
  // there — 0.83 s per second of video, i.e. 1.20x — which is four times what
  // the H.264 clips predicted for it, and is the truth about this file.
  const benchmark = [{ preset: "ultrafast", pixelsPerSec: 11.2e6 }];
  const observedDecodeCostSec = 1 / 0.95 - (426 * 240 * 24) / 11.2e6;
  assert.ok(Math.abs(observedDecodeCostSec - 0.8335) < 0.001);

  const withObservation = canSustainOutput({
    benchmark,
    decodeModel: ADDON_HOST_MODEL,
    source: MEASURED_FILM,
    outputPixelsPerSec: 426 * 240 * 24,
    observedDecodeCostSec
  });

  // The same rung the clip model called 1.58x and admitted is now priced at
  // 0.95x — the speed it was actually seen to run at — and refused.
  assert.ok(Math.abs(withObservation.speed - 0.95) < 0.01, `priced ${withObservation.speed.toFixed(2)}x`);
  assert.equal(withObservation.sustainable, false);
});

test("an observation prices a host whose clips were never fitted", () => {
  // No model at all — clips missing, or a fit rejected. Before an observation
  // nothing can be refused; after one, the same rung is priced and refused.
  const benchmark = [{ preset: "ultrafast", pixelsPerSec: 11.2e6 }];
  const outputPixelsPerSec = 426 * 240 * 24;

  const unpriced = canSustainOutput({
    benchmark,
    decodeModel: null,
    source: MEASURED_FILM,
    outputPixelsPerSec
  });
  assert.deepEqual(unpriced, { speed: null, sustainable: true });

  const priced = canSustainOutput({
    benchmark,
    decodeModel: null,
    source: MEASURED_FILM,
    outputPixelsPerSec,
    observedDecodeCostSec: 0.8335
  });
  assert.equal(priced.sustainable, false);
  assert.ok(priced.speed < 1, `priced ${priced.speed?.toFixed(2)}x`);
});

test("nothing measured means nothing refused", () => {
  const verdict = canSustainOutput({
    benchmark: [],
    decodeModel: null,
    source: null,
    outputPixelsPerSec: 1920 * 1080 * 24
  });

  assert.deepEqual(verdict, { speed: null, sustainable: true });
});

test("a real ffmpeg banner reads into the figures the budget prices", async () => {
  // The chain a session actually runs: ffmpeg prints its banner, the four
  // readers take the four facts out of it, and `sourceDecodeCharacteristics`
  // turns them into the two the fit uses. Run against a real file, because the
  // bitrate reader is new and a banner is the one input nobody can invent
  // faithfully.
  const stderr = await new Promise((resolve) => {
    let text = "";
    const child = spawn(
      ffmpegBin,
      ["-hide_banner", "-loglevel", "info", "-i", path.join(CALIBRATION_DIR, "cal-720.mp4"), "-t", "0.1", "-f", "null", "-"],
      { stdio: ["ignore", "ignore", "pipe"], windowsHide: true }
    );
    child.stderr.on("data", (chunk) => {
      text += String(chunk);
    });
    child.on("close", () => resolve(text));
  });

  // The VIDEO stream's rate (2248), not the container's (2252). On a clip that
  // carries nothing else the two differ only by container overhead; on a film
  // with two AC-3 tracks they differ by the whole of the audio, and the fit
  // these figures feed was made from clips decoded with `-an`.
  assert.equal(parseFfmpegBitrateKbps(stderr), 2248, "the video stream's own bitrate, in kb/s");
  const dimensions = parseFfmpegVideoDimensions(stderr);
  const figures = sourceDecodeCharacteristics({
    width: dimensions.width,
    height: dimensions.height,
    fps: parseFfmpegVideoFps(stderr),
    bitrateKbps: parseFfmpegBitrateKbps(stderr)
  });
  assert.ok(Math.abs(figures.megapixelsPerSecond - (1280 * 720 * 24) / 1e6) < 0.01);
  assert.ok(Math.abs(figures.megabitsPerSecond - 2.248) < 0.001);
});

test("the video stream's bitrate is preferred, and the output's is never read", () => {
  // A real banner states three rates: the container's, the input video
  // stream's, and — below "Stream mapping:" — the one ffmpeg is about to
  // produce. Only the middle one describes the source.
  const banner = [
    "  Duration: 01:31:19.00, start: 0.000000, bitrate: 9500 kb/s",
    "  Stream #0:0: Video: h264 (High), yuv420p, 1920x1080, 7800 kb/s, 23.98 fps",
    "  Stream #0:1: Audio: ac3, 48000 Hz, 5.1, fltp, 640 kb/s",
    "Stream mapping:",
    "  Stream #0:0(und): Video: wrapped_avframe, yuv420p, 1920x1080, q=2-31, 200 kb/s, 24 fps"
  ].join("\n");
  assert.equal(parseFfmpegBitrateKbps(banner), 7800);

  // No per-stream rate: the container's stands in, as it always did.
  const noStreamRate = [
    "  Duration: 00:10:00.00, bitrate: 4200 kb/s",
    "  Stream #0:0: Video: hevc (Main 10), yuv420p10le, 1920x1080, 23.98 fps"
  ].join("\n");
  assert.equal(parseFfmpegBitrateKbps(noStreamRate), 4200);
});

test("a banner with no bitrate reads as no bitrate, not as zero", () => {
  assert.equal(parseFfmpegBitrateKbps("Duration: 00:01:00.00, start: 0.000000\n"), null);
  assert.equal(parseFfmpegBitrateKbps(""), null);
  assert.equal(parseFfmpegBitrateKbps("Duration: 00:01:00.00, start: 0.000, bitrate: 8000 kb/s"), 8000);
});

test("the source's decode figures come off the probe, or not at all", () => {
  assert.deepEqual(sourceDecodeCharacteristics({ width: 1920, height: 1080, fps: 24, bitrateKbps: 8000 }), {
    megapixelsPerSecond: (1920 * 1080 * 24) / 1e6,
    megabitsPerSecond: 8
  });
  assert.equal(sourceDecodeCharacteristics({ width: 1920, height: 1080, fps: 24, bitrateKbps: null }), null);
  assert.equal(sourceDecodeCharacteristics(null), null);
});

test("the master playlist drops the rungs the host cannot hold", async (t) => {
  const dirPath = await mkdtemp(path.join(os.tmpdir(), "decode-cost-"));
  const manager = new HlsSessionManager({
    enabled: true,
    ffmpegBin: "ffmpeg",
    localBindHost: "127.0.0.1",
    localPort: 9090,
    // A host that can encode a little: 3 Mpx/s, so only the smallest rungs of a
    // 1080p source can be produced faster than they are watched.
    softwarePresetBenchmark: [{ preset: "ultrafast", pixelsPerSec: 3e6 }],
    decodeCostModel: ADDON_HOST_MODEL
  });
  t.after(async () => {
    await manager.disposeAll();
    await rm(dirPath, { recursive: true, force: true });
  });

  const session = {
    id: "cccccccc-dddd-eeee-ffff-000000000000",
    dirPath,
    state: "ready",
    fileName: "video.mkv",
    startedAt: Date.now(),
    lastAccessedAt: Date.now(),
    ffmpeg: null,
    lastError: "",
    consumers: new Set(),
    segmentFormat: fmp4Format,
    transcodeVideo: false,
    transcodeAudio: true,
    audioTrackIndex: 0,
    sourceKey: "source-1",
    fileIndex: 0,
    sourceWidth: 1920,
    sourceHeight: 1080,
    sourceDecode: MEASURED_FILM,
    outputFps: 24,
    // A copy can only be cut where the source already has a keyframe, and a
    // master is offered only when that grid is real.
    cutGrid: "keyframe",
    encodeWidth: 0,
    encodeHeight: 0,
    usesExplicitCuts: true,
    useSyntheticPlaylist: true,
    playlistText: "#EXTM3U\n",
    segmentBoundaries: Array.from({ length: 101 }, (_, index) => index * 4),
    segmentCount: 100,
    progress: { state: "running", processedSeconds: 0, startPositionSeconds: 0, speed: "1.0x" }
  };
  manager.sessionsById.set(session.id, session);

  assert.equal(
    manager.buildMasterPlaylist(session.id),
    null,
    "every rung under the copy runs below realtime here, so there is nothing to switch to"
  );
  assert.deepEqual(
    manager.offeredHeights(session),
    [1080],
    "and the list the browser is given says the same, since both come from one answer"
  );

  // A host with a little more encoder keeps the rungs it can actually hold. A
  // second session, because the answer is settled once per session.
  manager.softwarePresetBenchmark = [{ preset: "ultrafast", pixelsPerSec: 12e6 }];
  const stronger = { ...session, id: "dddddddd-eeee-ffff-0000-111111111111", offeredHeightsCache: undefined };
  manager.sessionsById.set(stronger.id, stronger);
  const master = manager.buildMasterPlaylist(stronger.id);
  assert.ok(master, "1080p copied plus the one rung this host can produce");
  const heights = [...master.matchAll(/^v\/(\d+)\/index\.m3u8$/gm)].map((match) => Number(match[1]));
  assert.deepEqual(heights, [1080, 240]);
  assert.deepEqual(manager.offeredHeights(stronger), heights);
});
