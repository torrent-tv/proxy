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
import { Timeline } from "../services/output/Timeline.js";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { decodeCostOf, decodeFamilyOf } from "../services/decode-cost-fit.js";
import { Output } from "../services/output/Output.js";
import os from "node:os";
import path from "node:path";
import {
  benchmarkDecodeCost,
  canSustainOutput,
  decodeSpeedFor,
  predictedRealtimeSpeed,
  speedBar
} from "../services/hwaccel.js";
import { HlsSessionManager } from "../services/hls-session-manager.js";
import { SourceFile, sourceDecodeCharacteristics } from "../services/source/SourceFile.js";
import { parseFfmpegBitrateKbps, parseFfmpegVideoDimensions, parseFfmpegVideoFps } from "../services/ffmpeg-banner.js";
import { fmp4Format } from "../services/segment-formats/fmp4.js";

const require = createRequire(import.meta.url);
const ffmpegBin = require("ffmpeg-static");
const CALIBRATION_DIR = path.join(import.meta.dirname, "..", "assets", "calibration");

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

  // What the model must get right is how cost SCALES from one source to
  // another — that is the whole of its job, since it is asked about rungs
  // nobody has decoded. So: a bigger, richer source is never cheaper.
  //
  // Deliberately not a numeric bound. This suite runs its files in parallel and
  // the benchmark is a live measurement, so the fit it produces depends on what
  // else the machine was doing: on this desktop the same clips have solved to
  // pixels+bitrate+constant, to pixels alone, and — under load — to a
  // constant-dominated shape whose 720p/1080p ratio was 1.32 rather than the
  // ~2.4 of a quiet run. That instability is real and is recorded against
  // roadmap item 1; pinning a number here would only pin how busy the machine
  // happened to be. What the FIGURES are worth is checked where it is quiet:
  // against the addon host's recorded constants below, and against the real
  // film in the field.
  const clip720 = { megapixelsPerSecond: (1280 * 720 * 24) / 1e6, megabitsPerSecond: 2.248 };
  const clip1080 = { megapixelsPerSecond: (1920 * 1080 * 24) / 1e6, megabitsPerSecond: 11.375 };
  const ratio = decodeSpeedFor(model, clip720) / decodeSpeedFor(model, clip1080);

  assert.ok(
    ratio >= 1,
    `720p at a fifth of the bitrate cannot decode slower than 1080p; the fit says ${ratio.toFixed(2)}x`
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

test("a rung is refused when the combined speed is under the bar", () => {
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
  assert.ok(heavy.speed < 1, `predicted ${heavy.speed.toFixed(2)}x`);

  // The 240p rung of that film predicts 1.58x on an idle machine, and with
  // nothing known about the swarm the bar is realtime, so it is offered.
  const light = canSustainOutput({
    benchmark,
    decodeModel: ADDON_HOST_MODEL,
    source,
    outputPixelsPerSec: 426 * 240 * 24
  });
  assert.ok(Math.abs(light.speed - 1.58) < 0.01, `predicted ${light.speed.toFixed(2)}x`);
  assert.equal(light.sustainable, true);
});

test("the bar is what this file's own supply demands, when it has been measured", () => {
  // The field torrent of 2026-08-17: waits of 1.49 s median arriving every
  // 2.22 s demand 1.67x of any step that is to survive them. The same 240p rung
  // predicted at 1.58x clears realtime and does not clear that.
  const benchmark = [{ preset: "ultrafast", pixelsPerSec: 11.2e6 }];
  const rung = {
    benchmark,
    decodeModel: ADDON_HOST_MODEL,
    source: MEASURED_FILM,
    outputPixelsPerSec: 426 * 240 * 24
  };
  assert.equal(canSustainOutput({ ...rung, requiredSpeed: 1.67 }).sustainable, false);
  assert.equal(canSustainOutput({ ...rung, requiredSpeed: 1.2 }).sustainable, true);
  // A swarm that has not been measured cannot raise the bar, and cannot lower
  // it below realtime either.
  assert.equal(speedBar(null), 1);
  assert.equal(speedBar(0.4), 1);
  assert.equal(speedBar(1.67), 1.67);
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
      ["-hide_banner", "-loglevel", "info", "-i", path.join(CALIBRATION_DIR, "cal-h264-720-hi.mp4"), "-t", "0.1", "-f", "null", "-"],
      { stdio: ["ignore", "ignore", "pipe"], windowsHide: true }
    );
    child.stderr.on("data", (chunk) => {
      text += String(chunk);
    });
    child.on("close", () => resolve(text));
  });

  // The VIDEO stream's rate (9940), not the container's (9946). On a clip that
  // carries nothing else the two differ only by container overhead; on a film
  // with two AC-3 tracks they differ by the whole of the audio, and the fit
  // these figures feed was made from clips decoded with `-an`.
  assert.equal(parseFfmpegBitrateKbps(stderr), 9940, "the video stream's own bitrate, in kb/s");
  const dimensions = parseFfmpegVideoDimensions(stderr);
  const figures = sourceDecodeCharacteristics({
    width: dimensions.width,
    height: dimensions.height,
    fps: parseFfmpegVideoFps(stderr),
    bitrateKbps: parseFfmpegBitrateKbps(stderr)
  });
  assert.ok(Math.abs(figures.megapixelsPerSecond - (1280 * 720 * 24) / 1e6) < 0.01);
  assert.ok(Math.abs(figures.megabitsPerSecond - 9.94) < 0.001);
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
    megabitsPerSecond: 8,
    // Which measurement of this host applies. Absent on the probe means absent
    // here — the caller then prices the source as H.264 8-bit, which is what
    // every source was priced as before the model was fitted per family.
    codec: "",
    bitDepth: null
  });
  assert.deepEqual(
    sourceDecodeCharacteristics({ width: 1920, height: 1080, fps: 24, bitrateKbps: 8000, codec: "hevc", bitDepth: 10 }),
    {
      megapixelsPerSecond: (1920 * 1080 * 24) / 1e6,
      megabitsPerSecond: 8,
      codec: "hevc",
      bitDepth: 10
    }
  );
  assert.equal(sourceDecodeCharacteristics({ width: 1920, height: 1080, fps: 24, bitrateKbps: null }), null);
  assert.equal(sourceDecodeCharacteristics(null), null);
});

test("the OFFER drops the rungs the host cannot hold, and the master keeps addressing them", async (t) => {
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
    // Where this file is cut, held by the file. A fixture that stated it
    // on the session was describing what production no longer does.
    timeline: new Timeline({
      boundaries: Array.from({ length: 101 }, (_, index) => index * 4),
      cutGrid: "keyframe"
    }),
    state: "ready",
    // The file's own facts: the picture's size, and what decoding it costs,
    // which is derived from them rather than stated beside them. These are the
    // measured film of MEASURED_FILM above — 1080p24 at 8 Mbit/s.
    file: new SourceFile({ sourceKey: "source-1", fileIndex: 0, name: "video.mkv" }).learn({
      width: 1920,
      height: 1080,
      fps: 24,
      bitrateKbps: 8000
    }),
    // An ordinary session reads its own file, and its sound is inside it. The
    // three differ only for a soundtrack shipped as a file of its own.
    get inputFile() { return this.file; },
    get audioFile() { return this.file; },
    startedAt: Date.now(),
    lastAccessedAt: Date.now(),
    ffmpeg: null,
    lastError: "",
    consumers: new Set(),
    segmentFormat: fmp4Format,
    transcodeVideo: false,
    transcodeAudio: true,
    audioTrackIndex: 0,
    // A copy can only be cut where the source already has a keyframe, and a
    // master is offered only when that grid is real.
    // The shape this output is encoded AS, decided once for the output.
    output: new Output({
      encodeWidth: 0,
      encodeHeight: 0,
      outputFps: 24,
      softwarePreset: null,
      applyTonemap: false
    }),
    usesExplicitCuts: true,
    useSyntheticPlaylist: true,
    playlistText: "#EXTM3U\n",
    segmentCount: 100,
    progress: { state: "running", processedSeconds: 0, startPositionSeconds: 0, speed: "1.0x" }
  };
  manager.sessionsById.set(session.id, session);

  assert.deepEqual(
    manager.offeredHeights(session),
    [1080],
    "every rung under the copy runs below realtime here, so there is nothing to switch to"
  );
  // The master is NOT that answer. It says which rungs can be spliced onto this
  // cut grid, which is a fact about the file, and it has to hold still for the
  // session's life: the browser is handed its address at creation, and a live
  // figure that withdrew it left a session answering 404 to itself (field
  // 2026-08-18, "Moana (2016).mkv" — nothing played at all).
  const weakMaster = manager.buildMasterPlaylist(session.id);
  assert.ok(weakMaster, "published once, whatever the host is managing this second");
  assert.deepEqual(
    [...weakMaster.matchAll(/^v\/(\d+)\/index\.m3u8$/gm)].map((match) => Number(match[1])),
    [1080, 720, 540, 480, 360, 240],
    "the ladder of the source, addressable — the menu the viewer sees is offeredHeights"
  );

  // A host with a little more encoder keeps the rungs it can actually hold. A
  // second session, because the answer is settled once per session.
  manager.softwarePresetBenchmark = [{ preset: "ultrafast", pixelsPerSec: 12e6 }];
  const stronger = { ...session, id: "dddddddd-eeee-ffff-0000-111111111111", offeredHeightsCache: undefined };
  manager.sessionsById.set(stronger.id, stronger);
  assert.deepEqual(
    manager.offeredHeights(stronger),
    [1080, 360, 240],
    "nothing is known about this swarm, so the bar is realtime"
  );
  const master = manager.buildMasterPlaylist(stronger.id);
  assert.ok(master, "1080p copied plus every rung that can be spliced beside it");
  assert.deepEqual(
    [...master.matchAll(/^v\/(\d+)\/index\.m3u8$/gm)].map((match) => Number(match[1])),
    [1080, 720, 540, 480, 360, 240],
    "the same published set as before: what the host manages is the offer's business, not the document's"
  );

  // The same host, once the reader has measured what this file's supply
  // demands: waits arriving as they did on the field torrent of 2026-08-17 ask
  // 1.67x of any step, and the rungs that only just cleared realtime go.
  const onAThinSwarm = {
    ...stronger,
    id: "eeeeeeee-ffff-0000-1111-222222222222",
    offeredHeightsCache: undefined,
    supplyFigures: { requiredSpeed: 1.67, worstWaitSec: 1.49, medianIntervalSec: 2.22, samples: 12 }
  };
  manager.sessionsById.set(onAThinSwarm.id, onAThinSwarm);
  assert.deepEqual(
    manager.offeredHeights(onAThinSwarm),
    [1080],
    "the copied height costs no encoder and stays; nothing re-encoded survives that supply"
  );
});

test("a source is priced by its own codec family when that family was measured", () => {
  // A model as the startup benchmark now returns it: H.264 terms at the top
  // level, for a caller that knows nothing about codecs, and the measured
  // families beside them.
  const model = {
    pixelTerm: 0.006, bitrateTerm: 0.012, constantTerm: 0,
    families: {
      h264: { pixelTerm: 0.006, bitrateTerm: 0.012, constantTerm: 0 },
      hevc: { pixelTerm: 0.011, bitrateTerm: 0.020, constantTerm: 0 },
      hevc10: { pixelTerm: 0.017, bitrateTerm: 0.026, constantTerm: 0 }
    }
  };
  const rates = { megapixelsPerSecond: 50, megabitsPerSecond: 9 };
  const asH264 = decodeCostOf(model, { ...rates, codec: "h264", bitDepth: 8 });
  const asHevc = decodeCostOf(model, { ...rates, codec: "hevc", bitDepth: 8 });
  const asHevc10 = decodeCostOf(model, { ...rates, codec: "hevc", bitDepth: 10 });
  assert.equal(Number(asH264.toFixed(4)), 0.408);
  assert.equal(Number(asHevc.toFixed(4)), 0.73);
  assert.equal(Number(asHevc10.toFixed(4)), 1.084);
  // The whole point: the same file costs more as HEVC than as H.264, and more
  // again at ten bits. A single fit could not say that.
  assert.ok(asHevc > asH264 && asHevc10 > asHevc);
});

test("a family with no clips is priced as H.264, and a model with no families still works", () => {
  const withFamilies = {
    pixelTerm: 0.006, bitrateTerm: 0.012, constantTerm: 0,
    families: { h264: { pixelTerm: 0.006, bitrateTerm: 0.012, constantTerm: 0 } }
  };
  const rates = { megapixelsPerSecond: 50, megabitsPerSecond: 9 };
  // AV1 has no set of its own yet.
  assert.equal(
    decodeCostOf(withFamilies, { ...rates, codec: "av1", bitDepth: 8 }),
    decodeCostOf(withFamilies, { ...rates, codec: "h264", bitDepth: 8 })
  );
  // And a flat model — every model before this release — is unchanged.
  const flat = { pixelTerm: 0.006, bitrateTerm: 0.012, constantTerm: 0 };
  assert.equal(decodeCostOf(flat, { ...rates, codec: "hevc", bitDepth: 10 }), 0.408);
});

test("the family is chosen by codec and depth, and unknown names fall to H.264", () => {
  assert.equal(decodeFamilyOf({ codec: "hevc", bitDepth: 8 }), "hevc");
  assert.equal(decodeFamilyOf({ codec: "HEVC", bitDepth: 10 }), "hevc10");
  assert.equal(decodeFamilyOf({ codec: "h265", bitDepth: 12 }), "hevc10");
  assert.equal(decodeFamilyOf({ codec: "h264", bitDepth: 10 }), "h264");
  assert.equal(decodeFamilyOf({ codec: "vc1", bitDepth: null }), "h264");
  assert.equal(decodeFamilyOf({}), "h264");
});
