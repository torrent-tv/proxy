/**
 * @file The startup host measurements (torrent-tv/meta#280, design.md §6.5 B):
 * fake measures, so no ffmpeg runs.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { measureHost } from "../../services/encode/measure-host.js";

const software = { kind: "software", name: "libx264" };
const device = { kind: "vaapi", name: "h264_vaapi" };

function fakes({ detected = software, calibrations = {} } = {}) {
  const calls = [];
  const note = (name, value) => async (...args) => { calls.push([name, args[0]]); return typeof value === "function" ? value(args[0]) : value; };
  const measures = {
    detectVideoEncoder: note("detectVideoEncoder", detected),
    benchmarkDecodeCost: note("benchmarkDecodeCost", { model: "decode" }),
    benchmarkContention: note("benchmarkContention", [1.5]),
    readHostFingerprint: note("readHostFingerprint", "fingerprint"),
    calibrateEncoder: note("calibrateEncoder", args => calibrations[args.encoder.kind] ?? { assessmentComplete: true, modes: [{ id: "m" }] }),
    softwareDescriptor: () => software,
    benchmarkCopySpeed: note("benchmarkCopySpeed", 3),
    benchmarkAudio: note("benchmarkAudio", [{ codec: "aac" }]),
    measureStartAndStop: note("measureStartAndStop", { startSec: 1, stopSec: 1 }),
    detectTonemapSupport: note("detectTonemapSupport", true)
  };
  return { calls, measures };
}

const base = { ffmpegBin: "ffmpeg", processorCores: 4 };

test("the measures run in the order the startup ran them", async () => {
  const { calls, measures } = fakes();
  const host = await measureHost({ ...base, logger: { warn() {}, info() {} }, transcode: true, measures });
  assert.deepEqual(calls.map(([name]) => name), ["detectVideoEncoder", "benchmarkDecodeCost", "benchmarkContention",
    "readHostFingerprint", "calibrateEncoder", "benchmarkCopySpeed", "benchmarkAudio", "measureStartAndStop", "detectTonemapSupport"]);
  assert.deepEqual(Object.keys(host).sort(), ["audioCalibration", "calibration", "contentionPenalties", "copySpeedX",
    "decodeCostModel", "startStopCost", "tonemapSupported", "videoEncoder"]);
  assert.equal(host.videoEncoder, software);
  assert.equal(host.copySpeedX, 3);
  assert.equal(host.tonemapSupported, true);
});

test("a device is calibrated and then software too", async () => {
  const { calls, measures } = fakes({ detected: device });
  await measureHost({ ...base, logger: { warn() {}, info() {} }, transcode: true, measures });
  const kinds = calls.filter(([name]) => name === "calibrateEncoder").map(([, args]) => args.encoder.kind);
  assert.deepEqual(kinds, ["vaapi", "software"]);
});

test("a device none of whose modes passed falls back to software and says so", async () => {
  const warnings = [];
  const { measures } = fakes({ detected: device, calibrations: { vaapi: { assessmentComplete: true, modes: [] } } });
  const host = await measureHost({ ...base, logger: { warn: line => warnings.push(line), info() {} }, transcode: true, measures });
  assert.equal(host.videoEncoder, software);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /^calibration: h264_vaapi passed detection but .*; encoding in software instead$/);
});

test("without transcode nothing is measured", async () => {
  const { calls, measures } = fakes();
  const host = await measureHost({ ...base, logger: { warn() {}, info() {} }, transcode: false, measures });
  assert.deepEqual(calls, []);
  assert.deepEqual({ ...host }, { videoEncoder: null, decodeCostModel: null, contentionPenalties: null, calibration: null,
    copySpeedX: null, audioCalibration: [], startStopCost: null, tonemapSupported: false });
});
