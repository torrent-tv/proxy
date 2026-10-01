import assert from "node:assert/strict";
import test from "node:test";
import { audioReadingFor } from "../services/encode/audio-calibration.js";

const readings = [
  { codec: "ac3", operation: "aac", channels: 2, samplingFrequency: 48000, speed: 120 },
  { codec: "aac", operation: "copy", channels: 2, samplingFrequency: 48000, speed: 200,
    bytes: 64000, durationSeconds: 4 }
];

test("audio processing uses codec and sample work instead of a video-copy rate", () => {
  assert.equal(audioReadingFor(readings, { codec: "ac3", transcode: true, channels: 6,
    samplingFrequency: 48000 }).speed, 40);
  assert.equal(audioReadingFor(readings, { codec: "ac3", transcode: true, channels: 2,
    samplingFrequency: 24000 }).speed, 240);
  assert.equal(audioReadingFor(readings, { codec: "dts", transcode: true }), null);
});

test("copying uses encoded byte work when the source declares its bitrate", () => {
  assert.equal(audioReadingFor(readings, { codec: "aac", transcode: false, bitrateKbps: 256 }).speed, 100);
  assert.equal(audioReadingFor(readings, { codec: "aac", transcode: false }).speed, 200);
  assert.equal(audioReadingFor(readings, { codec: "aac", transcode: true }), null);
});
