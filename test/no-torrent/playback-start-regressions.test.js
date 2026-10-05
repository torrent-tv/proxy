import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { EncodeRun } from "../../services/encode/EncodeRun.js";
import { SoftwareEncoder } from "../../services/encode/SoftwareEncoder.js";
import { predictPlaybackReadiness } from "../../services/viewer/playback-readiness.js";

function encode() {
  const child = new EventEmitter();
  child.stdio = [null, new EventEmitter(), new EventEmitter(), new EventEmitter()];
  child.stderr = child.stdio[2];
  child.kill = () => {};
  const published = [];
  const ended = [];
  const run = new EncodeRun({
    address: "fake", from: 0, to: 1, encoder: new SoftwareEncoder(),
    buildArgs: () => [], spawn: () => child, logger: { info() {}, warn() {} },
    indexOfName: (name) => Number(name),
    onClosed: (name) => { published.push(name); return name; },
    onEnded: (value) => ended.push(value)
  });
  return { child, run, published, ended };
}

test("a clean short input never publishes its flushed tail", () => {
  const { child, published, ended } = encode();
  child.stderr.emit("data", "Stream ends prematurely at 1048576");
  child.stdio[3].emit("data", "0\n");
  child.emit("close", 0, null);
  assert.deepEqual(published, []);
  assert.equal(ended[0].ending, "short");
  assert.equal(ended[0].reached, -1);
});

test("completed cuts survive a failure but its last flushed file does not", () => {
  const { child, published } = encode();
  child.stdio[3].emit("data", "0\n");
  child.stderr.emit("data", "Stream ends prematurely at 1048576");
  child.stdio[3].emit("data", "1\n");
  child.emit("close", 0, null);
  assert.deepEqual(published, ["0"]);
});

test("normal completion drains the filename pipe before publishing the tail", () => {
  const { child, published, ended } = encode();
  child.emit("exit", 0, null);
  assert.deepEqual(ended, []);
  child.stdio[3].emit("data", "0\n1\n");
  child.emit("close", 0, null);
  assert.deepEqual(published, ["0", "1"]);
  assert.equal(ended[0].ending, "complete");
});

test("stopping retains an earlier closed cut and rejects the signal-flushed tail", () => {
  const { child, run, published } = encode();
  child.stdio[3].emit("data", "0\n");
  run.stop("a different range is needed");
  child.stdio[3].emit("data", "1\n");
  child.emit("close", null, "SIGTERM");
  assert.deepEqual(published, ["0"]);
});

function state(clientRanges) {
  return {
    now: 10_000, positionSeconds: 0, durationSeconds: 8,
    bufferedAheadSeconds: 8, bufferLimitSeconds: 8, reserveSeconds: 0, lookaheadSeconds: 8,
    sources: [{ id: "source", complete: true }],
    linkReadings: [{ at: 10_000, value: 80 }],
    tracks: [{ id: "video", sourceIds: ["source"], processedSeconds: 8,
      bitsPerMediaSecond: 80, readings: [{ at: 10_000, value: 2 }],
      readySegmentIndices: [0, 1], segmentSizesBytes: new Map([[0, 40], [1, 40]]),
      clientRanges, segments: [{ index: 0, startSeconds: 0, endSeconds: 4 },
        { index: 1, startSeconds: 4, endSeconds: 8 }] }]
  };
}

test("future browser ranges are retained rather than transferred again", () => {
  const forecast = predictPlaybackReadiness(state([{ start: 4, end: 8 }]));
  assert.equal(forecast.ready, false);
  assert.equal(forecast.reason, "minimum-safe-delay");
  assert.ok(Math.abs(forecast.delaySeconds - 4) < 1e-8);
});

test("a real media hole is not hidden by the scalar buffer or ready file count", () => {
  const input = state([{ start: 0, end: 3 }, { start: 4, end: 8 }]);
  // A ready piece always has its coverage read; the hole is between them.
  input.tracks[0].segments[0].mediaRanges = { timescale: 1000n, ranges: [{ start: 0n, end: 3000n, frame: 0n }] };
  input.tracks[0].segments[1].mediaRanges = { timescale: 1000n, ranges: [{ start: 4000n, end: 8000n, frame: 0n }] };
  const forecast = predictPlaybackReadiness(input);
  assert.equal(forecast.ready, false);
  assert.equal(forecast.bufferedSeconds, 3);
  assert.equal(forecast.reason, "media-continuity-unavailable");
});

test("missing work before global progress can still be produced", () => {
  const input = state([]);
  input.tracks[0].readySegmentIndices = [1];
  const forecast = predictPlaybackReadiness(input);
  assert.equal(forecast.reason, "minimum-safe-delay");
  assert.ok(Number.isFinite(forecast.delaySeconds));
});
