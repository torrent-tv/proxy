import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { readPresentationRanges, servedPresentationRanges, walkBoxes } from "../../services/encode/segment-formats/mp4-boxes.js";
import { predictPlaybackReadiness } from "../../services/viewer/playback-readiness.js";

const evidence = JSON.parse(readFileSync(new URL("./fixtures/audio-frame-boundary.json", import.meta.url), "utf8"));
const header = Buffer.from(evidence.files["init.mp4"], "base64");

function served(name, shiftedFrames = 0) {
  const bytes = Buffer.from(evidence.files[name], "base64");
  let frameTicks;
  walkBoxes(bytes, (type, start) => {
    if (type === "tfhd") {
      const flags = bytes.readUIntBE(start + 1, 3);
      const at = start + 8 + ((flags & 1) ? 8 : 0) + ((flags & 2) ? 4 : 0);
      if (flags & 8) frameTicks = bytes.readUInt32BE(at);
    }
    if (type === "tfdt" && shiftedFrames) {
      assert.ok(frameTicks > 0);
      bytes.writeBigUInt64BE(bytes.readBigUInt64BE(start + 4) + BigInt(frameTicks * shiftedFrames), start + 4);
    }
  });
  return servedPresentationRanges(readPresentationRanges(Buffer.concat([header, bytes])), header);
}

const seconds = ({ timescale }, ticks) => Number(ticks) / Number(timescale);

function state(second = served("segment-00172.mp4")) {
  const first = served("segment-00171.mp4");
  const now = 1000;
  const firstStart = seconds(first, first.ranges[0].start);
  const secondStart = seconds(second, second.ranges[0].start);
  const secondEnd = seconds(second, second.ranges.at(-1).end);
  return {
    now,
    positionSeconds: firstStart,
    durationSeconds: secondEnd,
    reserveSeconds: 0,
    lookaheadSeconds: secondEnd - firstStart,
    sources: [{ id: "source", complete: true }],
    linkReadings: [{ at: now, value: 1_000_000 }],
    tracks: [{
      id: "audio", sourceIds: ["source"], clockOffsetSeconds: 0, clientRanges: [
        { start: evidence.browserBufferedRanges[0][0], end: evidence.browserBufferedRanges[0][1] }
      ],
      readings: [{ at: now, value: 1 }],
      readySegmentIndices: [0, 1], segmentSizesBytes: { 0: 170000, 1: 170000 },
      segments: [
        { index: 0, startSeconds: firstStart, endSeconds: secondStart, mediaRanges: first },
        { index: 1, startSeconds: secondStart, endSeconds: secondEnd, mediaRanges: second }
      ]
    }]
  };
}

test("the captured AAC join, 432 ticks at 48 kHz, is one Chrome closed and every engine closes", () => {
  const input = state();
  assert.equal(predictPlaybackReadiness(input).ready, true);
  // Without the frame durations the pieces state, nothing allows the gap.
  for (const segment of input.tracks[0].segments) {
    segment.mediaRanges = { ...segment.mediaRanges,
      ranges: segment.mediaRanges.ranges.map((range) => ({ ...range, frame: 0n })) };
  }
  assert.equal(predictPlaybackReadiness(input).reason, "media-continuity-unavailable");
});

test("four missing AAC frames preserve the discontinuity observed in Chrome", () => {
  assert.equal(predictPlaybackReadiness(state(served("segment-00172.mp4", 4))).reason,
    "media-continuity-unavailable");
});

test("a join never supplies audio before the adjacent segment arrives", () => {
  const input = state();
  input.linkReadings[0].value = 1;
  assert.notEqual(predictPlaybackReadiness(input).ready, true);
});
