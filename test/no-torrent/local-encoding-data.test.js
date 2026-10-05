/**
 * @file Step 14 of roadmap item 97: which modes this machine may encode with,
 * what each costs at every size, and what the proxy keeps between runs about
 * its own admitted encodes — all on fakes. Nothing here runs ffmpeg, starts a
 * torrent client or touches a swarm; the one file written is in a temporary
 * directory.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  configurationKeyOf,
  kindOfEncoderName,
  parseFfmpegVersion,
  parseNvidiaSmi,
  parseX264Version,
  UNKNOWN
} from "../../services/encode/fingerprint.js";
import { interpolationErrorOf, throughputAt } from "../../services/encode/throughput.js";
import { calibrateEncoder, HostCalibration } from "../../services/encode/calibration.js";
import { canSustainOutput, pickSoftwarePreset } from "../../services/encode/hwaccel.js";
import { contentOf, LocalObservations } from "../../services/encode/LocalObservations.js";
import { OutputSpec, VideoOutput, CutGrid } from "../../services/encode/output/index.js";
import { PEAK_CLASS, videoLoadOfSpec } from "../../services/encode/quality/link-budget.js";
import { SoftwareEncoder } from "../../services/encode/SoftwareEncoder.js";
import { NvencEncoder } from "../../services/encode/NvencEncoder.js";

const FINGERPRINT = Object.freeze({
  ffmpeg: "8.1.2",
  x264: "core 164 r3108 31e19f9",
  cpu: "Cortex-A72",
  threads: 4,
  devices: { vaapi: { model: "0x8086:0x9a49", driver: "i915 (kernel 6.6.31)" } }
});

/** A re-encoded picture's spec, the way `OutputOpening` builds one. */
function specAt({ encoder = "libx264", width = 1280, height = 720, fps = 24, preset = "veryfast", rateControl = null } = {}) {
  return new OutputSpec({
    sourceKey: "src",
    segmentFormatId: "fmp4",
    grid: new CutGrid({ kind: "uniform", fileIndex: 0 }),
    video: new VideoOutput({ fileIndex: 0, encode: { encoder, width, height, fps, preset, tonemap: false, rateControl } }),
    audio: null
  });
}

// --- The configuration key -------------------------------------------------

test("the builds and devices are read out of what the tools print", () => {
  assert.equal(parseFfmpegVersion("ffmpeg version 8.1.2 Copyright (c) 2000-2025\nbuilt with gcc"), "8.1.2");
  assert.equal(parseFfmpegVersion("garbage"), UNKNOWN);
  const stream = Buffer.from("\0\0\x01\x06\x05x264 - core 164 r3108 31e19f9 - H.264/MPEG-4 AVC codec", "latin1");
  assert.equal(parseX264Version(stream), "core 164 r3108 31e19f9");
  assert.equal(parseX264Version(Buffer.from("no version here")), UNKNOWN);
  assert.deepEqual(parseNvidiaSmi("NVIDIA RTX 4000 SFF Ada Generation, 550.54.14\n"), {
    model: "NVIDIA RTX 4000 SFF Ada Generation",
    driver: "550.54.14"
  });
  assert.equal(kindOfEncoderName("h264_nvenc"), "nvenc");
  assert.equal(kindOfEncoderName("libx264"), "software");
});

test("a driver update invalidates what a device was seen doing, and nothing about software", () => {
  const vaapi = { name: "h264_vaapi", kind: "vaapi" };
  const software = { name: "libx264", kind: "software" };
  const updated = { ...FINGERPRINT, devices: { vaapi: { model: "0x8086:0x9a49", driver: "i915 (kernel 6.8.0)" } } };
  assert.notEqual(configurationKeyOf(FINGERPRINT, vaapi), configurationKeyOf(updated, vaapi));
  assert.equal(configurationKeyOf(FINGERPRINT, software), configurationKeyOf(updated, software));
  // Another x264 build or another thread count is another software configuration.
  assert.notEqual(configurationKeyOf(FINGERPRINT, software), configurationKeyOf({ ...FINGERPRINT, threads: 14 }, software));
  assert.notEqual(configurationKeyOf(FINGERPRINT, software), configurationKeyOf({ ...FINGERPRINT, x264: "core 165" }, software));
});

// --- Throughput by size ----------------------------------------------------

const READINGS = [
  { width: 256, height: 144, pixelsPerSec: 40e6 },
  { width: 640, height: 360, pixelsPerSec: 36e6 },
  { width: 1280, height: 720, pixelsPerSec: 30e6 }
];

test("a size is priced from the readings around it, lowered by the error measured for interpolating", () => {
  const error = interpolationErrorOf(READINGS);
  assert.ok(error !== null && error >= 0, "three readings give a measured bound");
  const entry = { preset: "veryfast", pixelsPerSec: 36e6, bySize: READINGS, interpolationError: error };
  assert.equal(throughputAt(entry, { width: 640, height: 360 }), 36e6, "a size read is its own reading");
  const between = throughputAt(entry, { width: 854, height: 480 });
  assert.ok(between < 36e6 && between > 30e6 * (1 - error), `between the two readings, got ${between}`);
});

test("a size beyond what was read is not a size this machine has shown it can do", () => {
  const entry = { preset: "veryfast", pixelsPerSec: 36e6, bySize: READINGS, interpolationError: 0.05 };
  assert.equal(throughputAt(entry, { width: 1920, height: 1080 }), null);
  assert.equal(throughputAt(entry, { width: 128, height: 72 }), null);
  // Two readings measure no interpolation error: only the sizes read are known.
  const two = { preset: "veryfast", pixelsPerSec: 36e6, bySize: READINGS.slice(0, 2), interpolationError: null };
  assert.equal(throughputAt(two, { width: 426, height: 240 }), null);
  assert.equal(throughputAt(two, { width: 640, height: 360 }), 36e6);
  // An entry with no readings by size answers with its one figure, as before.
  assert.equal(throughputAt({ preset: "fast", pixelsPerSec: 5e6 }, { width: 1920, height: 1080 }), 5e6);
});

test("the offer does not keep a rung at a size no mode was measured at", () => {
  const benchmark = [{ preset: "ultrafast", pixelsPerSec: 36e6, bySize: READINGS, interpolationError: 0.05 }];
  const at1080 = canSustainOutput({ benchmark, outputPixelsPerSec: 1920 * 1080 * 24, frame: { width: 1920, height: 1080 } });
  assert.deepEqual(at1080, { speed: null, sustainable: false });
  // The same mode at a size it WAS read at, with decoding priced: 30 Mpx/s
  // against 1280x720x24 is 1.36x, and a decode at 10x leaves 1.19x.
  const at720 = canSustainOutput({
    benchmark,
    outputPixelsPerSec: 1280 * 720 * 24,
    frame: { width: 1280, height: 720 },
    observedDecodeCostSec: 0.1
  });
  assert.equal(at720.sustainable, true);
  assert.ok(Math.abs(at720.speed - 1 / (0.1 + (1280 * 720 * 24) / 30e6)) < 1e-9);
});

test("a preset not measured at a size is not chosen there", () => {
  const benchmark = [
    { preset: "fast", pixelsPerSec: 20e6, bySize: READINGS.slice(0, 2), interpolationError: null },
    { preset: "ultrafast", pixelsPerSec: 60e6, bySize: READINGS, interpolationError: 0.05 }
  ];
  assert.equal(pickSoftwarePreset(benchmark, 1280 * 720 * 24, {}, { width: 1280, height: 720 }), "ultrafast");
});

// --- The calibration walk --------------------------------------------------

/**
 * A calibration with every reading replaced: `speeds` maps "rung@WxH" to how
 * many times realtime that mode encodes there, `failing` the rungs whose
 * segments do not decode.
 */
async function calibrateWith({ encoder, speeds, failing = [] }) {
  const asked = [];
  const result = await calibrateEncoder({
    ffmpegBin: "never-run",
    encoder,
    measure: {
      check: async ({ rung }) => (failing.includes(rung)
        ? { ok: false, reason: "a segment does not decode", segmentKbps: null }
        : { ok: true, reason: "", segmentKbps: { averageKbps: 900, peakKbps: 1400 } }),
      rawFrames: async (frame) => `raw-${frame.width}x${frame.height}`,
      speed: async (rung, rawPath, frame) => {
        asked.push(`${rung}@${frame.width}x${frame.height}`);
        return speeds[`${rung}@${frame.width}x${frame.height}`] ?? null;
      },
      release: () => {}
    }
  });
  return { ...result, asked };
}

test("a mode whose segments do not decode is not used at all", async () => {
  const encoder = new SoftwareEncoder();
  const speeds = {};
  for (const rung of encoder.selectableRungs) {
    for (const size of ["256x144", "640x360", "1280x720", "1920x1080", "3840x2160"]) {
      speeds[`${rung}@${size}`] = 2;
    }
  }
  const { modes, refused } = await calibrateWith({ encoder, speeds, failing: ["faster"] });
  assert.ok(!modes.some((mode) => mode.preset === "faster"));
  assert.ok(refused.some((one) => one.preset === "faster" && /decode/.test(one.reason)));
  assert.equal(modes.length, encoder.selectableRungs.length - 1);
});

test("slower modes are not read where a faster one fell behind, nor larger sizes where the fastest did", async () => {
  const encoder = new SoftwareEncoder();
  const speeds = {
    "ultrafast@256x144": 20, "superfast@256x144": 15, "veryfast@256x144": 10, "faster@256x144": 8, "fast@256x144": 6,
    "ultrafast@640x360": 6, "superfast@640x360": 4, "veryfast@640x360": 0.8,
    "ultrafast@1280x720": 0.9
  };
  const { modes, asked } = await calibrateWith({ encoder, speeds });
  assert.ok(!asked.includes("faster@640x360"), "a mode slower than one that fell behind is not read");
  assert.ok(!asked.some((one) => one.endsWith("@1920x1080")), "a size larger than one the fastest could not hold is not read");
  const ultrafast = modes.find((mode) => mode.preset === "ultrafast");
  assert.deepEqual(ultrafast.bySize.map((reading) => `${reading.width}x${reading.height}`), ["256x144", "640x360", "1280x720"]);
  assert.equal(ultrafast.pixelsPerSec, 640 * 360 * 24 * 6, "the reference figure is the 640x360 reading");
  const fast = modes.find((mode) => mode.preset === "fast");
  assert.equal(throughputAt(fast, { width: 640, height: 360 }), null, "fast was never read at 640x360");
});

test("a device is calibrated only at the one setting its arguments pass", () => {
  assert.deepEqual(new NvencEncoder().selectableRungs, ["p4"]);
  assert.ok(new NvencEncoder().buildVideoArgs({ targetWidth: 1280, targetHeight: 720, segmentDurationSec: 4 }).includes("p4"));
});

test("the modes of the encoder in use are what prices, and software is kept for the fallback", () => {
  const calibration = new HostCalibration({ byKind: { vaapi: [{ preset: "h264_vaapi", pixelsPerSec: 1 }], software: [] }, fingerprint: FINGERPRINT });
  assert.equal(calibration.modesFor("vaapi").length, 1);
  assert.deepEqual(calibration.modesFor("software"), [], "calibrated, nothing qualified");
  assert.equal(calibration.modesFor("nvenc"), null, "not calibrated at all");
});

// --- Local observations ----------------------------------------------------

test("what is kept applies only on the configuration it was seen on, and survives a restart on it", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ttv-observations-"));
  const filePath = path.join(directory, "local-observations.json");
  try {
    const first = new LocalObservations({ fingerprint: FINGERPRINT, filePath });
    const content = { codec: "hevc", bitDepth: 10, width: 1920, height: 1080, megabitsPerSecond: 8 };
    first.noteEncode({ spec: specAt(), content, aloneSpeedX: 1.7, segmentKbps: { averageKbps: 2100, peakKbps: 3900 } });
    first.notePreparation({ spec: specAt(), seconds: 6.5, bufferedSec: 41 });

    const software = configurationKeyOf(FINGERPRINT, { name: "libx264", kind: "software" });
    const again = new LocalObservations({ fingerprint: FINGERPRINT, filePath });
    again.load([software]);
    assert.equal(again.slowestAloneSpeed(specAt(), content), 1.7);
    assert.equal(again.peakMbps(specAt()), 3.9);
    assert.equal(again.longestPreparationSec(specAt()), 6.5);

    // Another libx264 build: nothing kept matches, and the file is rewritten without it.
    const rebuilt = { ...FINGERPRINT, x264: "core 165 r3200 abc" };
    const afterUpdate = new LocalObservations({ fingerprint: rebuilt, filePath });
    afterUpdate.load([configurationKeyOf(rebuilt, { name: "libx264", kind: "software" })]);
    assert.equal(afterUpdate.slowestAloneSpeed(specAt(), content), null);
    assert.equal(afterUpdate.peakMbps(specAt()), null);
    assert.equal(JSON.parse(readFileSync(filePath, "utf8")).entries.speed && Object.keys(JSON.parse(readFileSync(filePath, "utf8")).entries.speed).length, 0);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a speed seen on easier material is not applied to harder material, and the slowest comparable one is used", () => {
  const observations = new LocalObservations({ fingerprint: FINGERPRINT, filePath: "" });
  const light = { codec: "hevc", bitDepth: 10, width: 1920, height: 1080, megabitsPerSecond: 4 };
  const heavy = { ...light, megabitsPerSecond: 12 };
  observations.noteEncode({ spec: specAt(), content: light, aloneSpeedX: 2.4, segmentKbps: null });
  assert.equal(observations.slowestAloneSpeed(specAt(), heavy), null, "a lighter source says nothing about a heavier one");
  observations.noteEncode({ spec: specAt(), content: heavy, aloneSpeedX: 1.3, segmentKbps: null });
  assert.equal(observations.slowestAloneSpeed(specAt(), light), 1.3, "both apply to the lighter source, and the slower wins");
  assert.equal(observations.slowestAloneSpeed(specAt(), { ...light, codec: "h264" }), null, "another codec is not comparable");
  assert.equal(observations.slowestAloneSpeed(specAt({ preset: "fast" }), light), null, "another mode is not this one");
});

test("an encoder with no bound of its own takes the peak seen, as an estimate and never as a bound", () => {
  const hardware = specAt({ encoder: "h264_vaapi", preset: null });
  assert.equal(videoLoadOfSpec(hardware, null).peakClass, PEAK_CLASS.UNKNOWN);
  const seen = videoLoadOfSpec(hardware, null, 5.2);
  assert.equal(seen.peakClass, PEAK_CLASS.ESTIMATED);
  assert.equal(seen.mbps, 5.2);
  // A bound the encoder is held to is never replaced by what was seen.
  const bounded = specAt({ rateControl: { maxrateKbps: 3900, bufsizeKbps: 4500, level: "3.1" } });
  assert.equal(videoLoadOfSpec(bounded, null, 9.9).peakClass, PEAK_CLASS.KNOWN);
  assert.equal(videoLoadOfSpec(bounded, null, 9.9).mbps, 3.9);
});

test("a file of another shape is not read as observations", () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "ttv-observations-"));
  const filePath = path.join(directory, "local-observations.json");
  try {
    writeFileSync(filePath, JSON.stringify({ version: 0, entries: { speed: { x: [1] } } }));
    const observations = new LocalObservations({ fingerprint: FINGERPRINT, filePath });
    observations.load([configurationKeyOf(FINGERPRINT, { name: "libx264", kind: "software" })]);
    assert.equal(observations.peakMbps(specAt()), null);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("what an encode was made from is described by the file's own facts", () => {
  assert.deepEqual(
    contentOf({ width: 1920, height: 1080, decode: { codec: "hevc", bitDepth: 10, megabitsPerSecond: 8, megapixelsPerSecond: 50 } }),
    { codec: "hevc", bitDepth: 10, width: 1920, height: 1080, megabitsPerSecond: 8 }
  );
  assert.equal(contentOf({ width: 0, height: 0, decode: null }), null);
});
